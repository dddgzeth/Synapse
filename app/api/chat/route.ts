/**
 * /api/chat — main chat endpoint.
 *
 * Flow:
 * 1. Recall relevant L1 memories
 * 2. Check for pending Aha Insight
 * 3. Stream Claude response via ai@6 UIMessageStream
 * 4. Write L0 (user + assistant messages) on finish
 * 5. Trigger L1 pipeline in background (every 5 turns)
 */

import { NextRequest } from "next/server";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, convertToModelMessages, stepCountIs } from "ai";
import crypto from "node:crypto";
import { recallForQuery } from "@/lib/memory/recall";
import { insertL0 } from "@/lib/memory/store";
import type { L0Message } from "@/lib/memory/store";
import { notifyTurn } from "@/lib/memory/scheduler";
import { getAhaPending, shouldFireAha, clearAhaPending } from "@/lib/memory/aha";
import { buildChatTools } from "@/lib/memory/search-tools";
import { buildSyncedFileTools, type SyncedFileEntry } from "@/lib/memory/synced-file-tools";
import { runChatLoop, type Tools, type OpenAIMessage, type ChatLoopEvent } from "@/lib/memory/chat-loop";
import { getCurrentSessionKey } from "@/lib/auth-session";
import { getPipelineState, setPipelineState } from "@/lib/memory/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const BASE_SYSTEM_PROMPT = `你是 Synapse，一个有长期记忆的工作助手。你帮助用户整理思路、分析信息、推进工作。
你的回答简洁、精准，直接切入问题。

如果下方"记忆上下文"区域有内容，请自然地融入回复，不要说"根据你的记忆"这类话——直接用内容本身作答。

【你拥有的工具】
- \`web_search(query)\` — 联网搜索（DuckDuckGo）。用于查找 GitHub 仓库、论文、工具等外部资源。
- \`fetch_url(url)\` — 读取一个 URL 的页面内容。用于验证链接是否真实存在、读取 GitHub README、DOI 页面等。
- \`tdai_memory_search(query, limit?, type?, scene?)\` — 搜索结构化研究记忆 L1。
- \`tdai_conversation_search(query, limit?, sessionKey?)\` — 搜索原始对话历史 L0。
- \`list_synced_files()\` — 列出本地同步文件夹的所有文件（仅元数据）。
- \`read_synced_file(path)\` — 读一个文件的文本内容（pdf/docx/pptx/xlsx/纯文本均可）。

【联网规则】
- 给用户提 URL 之前，先用 \`fetch_url\` 验证它确实存在（HTTP 200）。
- 不确定 GitHub 仓库地址时，先 \`web_search\` 找，再 \`fetch_url\` 确认，最后给用户。

【调用规则】
- 工具调用请用 OpenAI 标准 \`tool_calls\` 字段，**不要**自己写 <tool_call>/<invoke> 这类伪 XML。
- 工具返回为空时如实告知，不要编造。

【同步文件夹的调用规则——重要】
1. **用户提到子路径时必须用 \`path_prefix\` 过滤**。例如用户说"分析 NTU/SDL 这个路径的文章"，调用 \`list_synced_files({ path_prefix: 'NTU_Research_FAIR/Zotero/NTU/SDL' })\`，不要拉全量。
2. \`list_synced_files\` 在一次会话中**同一 scope 只调一次**。已经列过的 prefix 不要再列；要新 scope 就用不同的 path_prefix。
3. 用户问"概括 X 路径下所有论文"这类批量任务时，**先告诉用户你的计划**（"找到 N 个文件，将依次读取"），然后按列表顺序读取。
4. 每读完一个文件，**直接输出该文件的概括，再读下一个**——而不是把所有内容囤在脑子里。这样即使中途超时，前面的总结也保留下来了。
5. 用户没说要读哪个文件、也没挂附件时，先 list 看一眼，然后请用户确认是否读全部或挑几个；**不要自作主张读所有文件**。`;

interface ApiSettingsOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    messages = [],
    sessionKey: requestedSessionKey = "default",
    sessionId = crypto.randomUUID(),
    syncedFilesIndex = [],
    apiSettings,
  } = body as {
    messages: Array<{ role: "user" | "assistant"; parts?: Array<{ type: string; text?: string }>; content?: string }>;
    sessionKey?: string;
    sessionId?: string;
    syncedFilesIndex?: SyncedFileEntry[];
    apiSettings?: ApiSettingsOverride;
  };
  const sessionKey = await getCurrentSessionKey(requestedSessionKey);
  if (!sessionKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Find the most recent user message. This can't just be `messages[last]`
  // because AI SDK 6's `sendAutomaticallyWhen` resends with a tool-result as
  // the last message after the client executes a client-side tool.
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) {
    return new Response("No user message", { status: 400 });
  }
  const lastMsg = messages[messages.length - 1];
  const isResumeAfterTool = lastMsg.role !== "user";

  // Extract text from UIMessage parts (ai@6 format) or legacy content
  const userText = extractText(lastUserMsg);

  // 1. Recall memories
  const recall = recallForQuery(userText);

  // 2. Check Aha Insight — only on the original turn, never on a tool-resume
  //    (otherwise the Aha would be injected mid-tool-loop and the judge would
  //    run twice for the same user query).
  const ahaPending = !isResumeAfterTool ? getAhaPending() : null;
  const fireAha = ahaPending ? await shouldFireAha(userText, ahaPending) : false;

  // Build system prompt
  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (recall.contextText) {
    systemPrompt += `\n\n${recall.contextText}`;
  }
  if (fireAha && ahaPending) {
    systemPrompt += `\n\n<aha-instruction>
在正常回答之后，用"---"分隔，以"Synapse 注意到..."开头，自然地加入以下洞察：
Observation: ${ahaPending.observation}
Hypothesis: ${ahaPending.hypothesis}
Reframe: ${ahaPending.reframe}
语气要像长期观察后突然发现规律的助手，不要用"Aha"或"洞察卡"这类词。
</aha-instruction>`;
    clearAhaPending();
  }

  const rawBase = apiSettings?.baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL || "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const apiKey = apiSettings?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY || "";
  const model = apiSettings?.model?.trim() || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const provider = createOpenAI({
    baseURL,
    apiKey,
    // fucheers.top proxy only accepts Anthropic-style image blocks, not OpenAI's image_url.
    // Rewrite the request body so vision attachments work, and force non-streaming for
    // vision requests because the proxy strips images on streaming requests.
    fetch: createProxyFetch(),
  });

  const hasImage = messageHasImage(lastUserMsg);
  // For the manual chat loop we need plain OpenAI-format messages, not ai-sdk
  // UIMessages. Use convertToModelMessages to get the right shape, then map to
  // strict OpenAI schema.
  const modelMessages = await convertToModelMessages(messages as any);
  const openaiMessages = toOpenAIMessages(modelMessages);

  const afterFinish = async (text: string) => {
    const now = Date.now();
    try {
      // On a resume-after-tool turn, the user message was already inserted on
      // the original turn; only insert the (now-final) assistant text.
      if (!isResumeAfterTool) {
        insertL0({
          record_id: `l0_${now}_u_${crypto.randomBytes(3).toString("hex")}`,
          session_key: sessionKey,
          session_id: sessionId,
          role: "user",
          message_text: userText + (hasImage ? "\n\n[附件：1 张图片]" : ""),
          recorded_at: new Date(now).toISOString(),
          timestamp: now,
        } satisfies L0Message);
      }
      insertL0({
        record_id: `l0_${now}_a_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey,
        session_id: sessionId,
        role: "assistant",
        message_text: text,
        recorded_at: new Date(now + 1).toISOString(),
        timestamp: now + 1,
      } satisfies L0Message);
    } catch (err) {
      console.error("[chat] L0 insert failed:", err);
    }

    // Scheduler-managed pipeline: counts turns and fires L1/L2/L3 only when
    // batch thresholds are met. No longer fires per turn.
    notifyTurn(sessionKey, sessionId)
      .catch((err) => console.error("[chat] scheduler.notifyTurn failed:", err));
  };

  // Collect ALL prior list_synced_files scopes so the new buildSyncedFileTools
  // closure can dedup and avoid re-listing across request boundaries.
  //
  // Root cause of cross-request re-scan: read_synced_file is client-side, so
  // each file read triggers a new HTTP request. The server re-creates
  // buildSyncedFileTools with a fresh emittedScopes closure. Client messages
  // don't contain the server-side list_synced_files tool results (those happen
  // in the internal loop before the pending-tool pause), so message-history
  // scanning alone can't detect prior listing.
  //
  // Fix: persist listed scopes to pipeline_state (SQLite) keyed by session.
  // On each request we read them back and pre-populate emittedScopes.
  const LIST_SCOPES_KEY = `list_scopes_${sessionKey}`;
  const priorListPrefixes = (() => {
    const seen = new Set<string>();
    // 1. Server-side persistent state (survives cross-request tool resumes)
    try {
      const stored = getPipelineState(LIST_SCOPES_KEY);
      if (stored) JSON.parse(stored).forEach((s: string) => seen.add(s));
    } catch { /* ignore */ }
    // 2. Client message history (belt-and-suspenders for same-request turns)
    const idToName = new Map<string, string>();
    const idToArgs = new Map<string, string>();
    for (const m of openaiMessages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          idToName.set(tc.id, tc.function?.name ?? "");
          idToArgs.set(tc.id, tc.function?.arguments ?? "{}");
          if (tc.function?.name === "list_synced_files") {
            try {
              const args = JSON.parse(tc.function.arguments || "{}");
              seen.add(typeof args.path_prefix === "string" ? args.path_prefix : "");
            } catch { seen.add(""); }
          }
        }
      }
    }
    for (const m of openaiMessages) {
      if (m.role !== "tool") continue;
      if (idToName.get(m.tool_call_id) === "list_synced_files") {
        try {
          const args = JSON.parse(idToArgs.get(m.tool_call_id) ?? "{}");
          seen.add(typeof args.path_prefix === "string" ? args.path_prefix : "");
        } catch { seen.add(""); }
        continue;
      }
      if (typeof m.content === "string") {
        const noPrefMatch = /^\d+ synced file\(s\) available:/.exec(m.content);
        if (noPrefMatch) { seen.add(""); continue; }
        const prefMatch = /^\d+ file\(s\) under "([^"]+)"/.exec(m.content);
        if (prefMatch) { seen.add(prefMatch[1]); }
      }
    }
    return Array.from(seen);
  })();

  // Persist any newly listed scopes during this request to pipeline_state.
  function saveListScope(prefix: string) {
    try {
      const stored = getPipelineState(LIST_SCOPES_KEY);
      const scopes: string[] = stored ? JSON.parse(stored) : [];
      if (!scopes.includes(prefix)) {
        scopes.push(prefix);
        setPipelineState(LIST_SCOPES_KEY, JSON.stringify(scopes));
      }
    } catch { /* ignore */ }
  }

  const chatTools: Tools = {
    ...buildChatTools(),
    ...buildSyncedFileTools(syncedFilesIndex, priorListPrefixes),
  } as unknown as Tools;

  // 3a. Vision path — non-streaming (proxy strips images on streaming).
  //     Vision-containing requests don't use tools; LLM just answers about the image.
  if (hasImage) {
    const gen = await generateText({
      model: provider.chat(model),
      system: systemPrompt,
      messages: modelMessages,
      maxOutputTokens: 2048,
    });
    await afterFinish(gen.text);
    return uiStreamFromText(gen.text);
  }

  // 3b. Manual tool loop (non-streaming fucheers + UI message stream).
  //     fucheers proxy truncates tool_call arguments on streaming, so we can't
  //     use streamText. Loop until final text or until a client-side tool
  //     (read_synced_file) needs the browser; in that case pause and ship the
  //     pending tool call back to the client via the UI message stream so
  //     useChat's onToolCall handler fires.
  //
  //     We stream UI message events progressively (tool-input-* + data-*)
  //     so the user sees what Synapse is doing in real time — like Grok / Claude.ai.
  const baseFetch = createProxyFetch();
  return runChatStreaming({
    systemPrompt,
    openaiMessages,
    chatTools,
    baseURL,
    apiKey,
    model,
    fetchImpl: baseFetch,
    afterFinish,
    onToolCall: (name: string, input: unknown) => {
      if (name === "list_synced_files") {
        const prefix = typeof (input as any)?.path_prefix === "string"
          ? (input as any).path_prefix
          : "";
        saveListScope(prefix);
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Streaming wrapper: spins up a ReadableStream, pumps UI message
// events into it as the chat-loop progresses. The browser sees
// tool calls + results in real time.
// ─────────────────────────────────────────────────────────────
function runChatStreaming(args: {
  systemPrompt: string;
  openaiMessages: OpenAIMessage[];
  chatTools: Tools;
  baseURL: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  afterFinish: (text: string) => Promise<void>;
  onToolCall?: (name: string, input: unknown) => void;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (e: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // controller already closed (client disconnected)
        }
      };

      write({ type: "start" });
      write({ type: "start-step" });

      // We emit AI SDK 6-compatible `data-*` parts for tool progress, so the
      // browser stores them on the assistant message and we render them in
      // message-bubble.tsx. This is independent of the actual tool-input/output
      // protocol AI SDK uses for client-side tools — that still goes through
      // tool-input-available + onToolCall as before.
      const onEvent = (ev: ChatLoopEvent) => {
        if (ev.kind === "step-start") {
          write({
            type: "data-progress",
            id: `step-${ev.step}`,
            data: { kind: "step-start", step: ev.step, promptChars: ev.promptChars, budgetMs: ev.budgetMs },
          });
        } else if (ev.kind === "tool-call") {
          args.onToolCall?.(ev.name, ev.input);
          write({
            type: "data-progress",
            id: `tc-${ev.toolCallId}`,
            data: { kind: "tool-call", toolCallId: ev.toolCallId, name: ev.name, input: ev.input },
          });
        } else if (ev.kind === "tool-result") {
          write({
            type: "data-progress",
            id: `tr-${ev.toolCallId}`,
            data: {
              kind: "tool-result",
              toolCallId: ev.toolCallId,
              name: ev.name,
              tookMs: ev.tookMs,
              outputPreview: ev.output.slice(0, 280),
              outputLen: ev.output.length,
            },
          });
        } else if (ev.kind === "tool-error") {
          write({
            type: "data-progress",
            id: `te-${ev.toolCallId}`,
            data: { kind: "tool-error", toolCallId: ev.toolCallId, name: ev.name, error: ev.error },
          });
        } else if (ev.kind === "compaction") {
          write({
            type: "data-progress",
            id: `cmp-${ev.targetToolCallId ?? Date.now()}`,
            data: {
              kind: "compaction", reason: ev.reason,
              beforeChars: ev.beforeChars, afterChars: ev.afterChars,
              targetToolCallId: ev.targetToolCallId,
            },
          });
        } else if (ev.kind === "notice") {
          write({
            type: "data-progress",
            id: `ntc-${Date.now()}`,
            data: { kind: "notice", code: ev.code, detail: ev.detail },
          });
        }
      };

      try {
        const result = await runChatLoop({
          systemPrompt: args.systemPrompt,
          messages: args.openaiMessages,
          tools: args.chatTools,
          baseURL: args.baseURL,
          apiKey: args.apiKey,
          model: args.model,
          fetchImpl: args.fetchImpl,
          onEvent,
        });

        if (result.kind === "final") {
          const textId = "0";
          write({ type: "text-start", id: textId });
          write({ type: "text-delta", id: textId, delta: result.text });
          write({ type: "text-end", id: textId });
          write({ type: "finish-step" });
          write({ type: "finish", finishReason: "stop" });
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
          await args.afterFinish(result.text);
          return;
        }

        if (result.kind === "error") {
          console.error("[chat] loop error:", result.code, result.error ?? "");
          write({
            type: "data-progress",
            id: `err-${Date.now()}`,
            data: { kind: "error", code: result.code, detail: result.error },
          });
          write({ type: "finish-step" });
          write({ type: "finish", finishReason: "stop" });
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
          return;
        }

        // result.kind === "pending-tool" → ship to client.
        const { toolCall } = result;
        write({ type: "tool-input-start", toolCallId: toolCall.id, toolName: toolCall.name });
        write({
          type: "tool-input-delta",
          toolCallId: toolCall.id,
          inputTextDelta: JSON.stringify(toolCall.input ?? {}),
        });
        write({
          type: "tool-input-available",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input ?? {},
        });
        write({ type: "finish-step" });
        write({ type: "finish", finishReason: "tool-calls" });
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      } catch (e) {
        console.error("[chat] stream wrapper crash:", e);
        const msg = e instanceof Error ? e.message : String(e);
        write({
          type: "data-progress",
          id: `err-${Date.now()}`,
          data: { kind: "error", code: "internal_error", detail: msg },
        });
        write({ type: "finish-step" });
        write({ type: "finish", finishReason: "stop" });
        try { controller.enqueue(encoder.encode(`data: [DONE]\n\n`)); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

// Convert ai-sdk ModelMessage[] to strict OpenAI-format messages.
// Drops the rich content-block array, keeps text only — multi-modal handled
// by the vision branch separately.
function toOpenAIMessages(modelMessages: any[]): OpenAIMessage[] {
  return modelMessages.map((m): OpenAIMessage => {
    if (m.role === "system") return { role: "system", content: extractContentString(m.content) };
    if (m.role === "user") return { role: "user", content: extractContentString(m.content) };
    if (m.role === "assistant") {
      const content = extractContentString(m.content);
      const toolCalls = extractToolCalls(m.content);
      return toolCalls
        ? { role: "assistant", content: content || null, tool_calls: toolCalls }
        : { role: "assistant", content };
    }
    if (m.role === "tool") {
      // ai-sdk tool messages have content: [{type:"tool-result", toolCallId, output}]
      const c = Array.isArray(m.content) ? m.content[0] : null;
      const tcid = c?.toolCallId ?? m.tool_call_id ?? "";
      const out = c?.output;
      const text = typeof out === "string" ? out : JSON.stringify(out ?? c ?? m.content ?? "");
      return { role: "tool", tool_call_id: tcid, content: text };
    }
    return { role: "user", content: extractContentString(m.content) };
  });
}

function extractContentString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text ?? "")
      .join("");
  }
  return "";
}

function extractToolCalls(content: unknown): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | null {
  if (!Array.isArray(content)) return null;
  const calls = content
    .filter((p: any) => p?.type === "tool-call")
    .map((p: any) => ({
      id: p.toolCallId,
      type: "function" as const,
      function: {
        name: p.toolName,
        arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}),
      },
    }));
  return calls.length > 0 ? calls : null;
}

function messageHasImage(msg: { parts?: Array<{ type: string }> }): boolean {
  return !!msg.parts?.some((p) => p.type === "file" || p.type === "image" || p.type === "image_url");
}

// Emit a single text chunk as a UIMessageStream the client can render.
function uiStreamFromText(text: string): Response {
  const encoder = new TextEncoder();
  const id = "0";
  const events = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];
  return uiStreamResponse(events);
}

// Emit a pending tool call so the client's useChat onToolCall handler runs.
// AI SDK 6 expects: tool-input-start → tool-input-delta (full args) →
// tool-input-available, then finish-step with finishReason: "tool-calls".
function uiStreamFromPendingTool(toolCall: { id: string; name: string; input: unknown }): Response {
  const argsString = JSON.stringify(toolCall.input ?? {});
  const events = [
    { type: "start" },
    { type: "start-step" },
    { type: "tool-input-start", toolCallId: toolCall.id, toolName: toolCall.name },
    { type: "tool-input-delta", toolCallId: toolCall.id, inputTextDelta: argsString },
    { type: "tool-input-available", toolCallId: toolCall.id, toolName: toolCall.name, input: toolCall.input ?? {} },
    { type: "finish-step" },
    { type: "finish", finishReason: "tool-calls" },
  ];
  return uiStreamResponse(events);
}

function uiStreamResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

function extractText(msg: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  if (msg.parts && msg.parts.length > 0) {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return msg.content ?? "";
}

// Rewrite OpenAI-style image_url content blocks → Anthropic image blocks.
// Returned as a factory so each request gets a fresh fetch (avoids stale closures).
function createProxyFetch(): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (Array.isArray(m.content)) {
              m.content = m.content.map((part: any) => {
                if (part?.type === "image_url" && part.image_url?.url) {
                  const url = part.image_url.url as string;
                  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
                  if (match) {
                    return {
                      type: "image",
                      source: { type: "base64", media_type: match[1], data: match[2] },
                    };
                  }
                  return { type: "image", source: { type: "url", url } };
                }
                return part;
              });
            }
          }
        }
        init = { ...init, body: JSON.stringify(parsed) };
      } catch {
        // body not JSON; pass through
      }
    }
    return fetch(input as any, init as any);
  };
}
