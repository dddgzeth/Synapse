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
import { incrementTurnCount, shouldTriggerL1, runL1Pipeline } from "@/lib/memory/l1-pipeline";
import { getAhaPending, shouldFireAha, clearAhaPending, runAhaDetection } from "@/lib/memory/aha";
import { buildChatTools } from "@/lib/memory/search-tools";
import { buildSyncedFileTools, type SyncedFileEntry } from "@/lib/memory/synced-file-tools";
import { runChatLoop, type Tools, type OpenAIMessage } from "@/lib/memory/chat-loop";

export const runtime = "nodejs";
export const maxDuration = 120;

const BASE_SYSTEM_PROMPT = `你是 Synapse，一个有长期记忆的工作助手。你帮助用户整理思路、分析信息、推进工作。
你的回答简洁、精准，直接切入问题。

如果下方"记忆上下文"区域有内容，请自然地融入回复，不要说"根据你的记忆"这类话——直接用内容本身作答。

【你拥有的工具】
- \`tdai_memory_search(query, limit?, type?, scene?)\` — 搜索用户的结构化记忆 L1（已经从对话里抽取出的事实/观察/结论），适合查"用户偏好/正在做的项目/研究发现/方法/数据集"等。**优先用这个**，比对话搜索更精准。
- \`tdai_conversation_search(query, limit?, sessionKey?)\` — 搜索用户的原始对话历史 L0，按关键词召回单条消息（含 role/session/时间）。适合"用户之前提到过 X 吗 / 帮我找 3 月份关于 Y 的对话"这类问题。

【工具调用规则】
- 当用户问到"过去/之前/上次/我有没有提过/我说过/帮我找..."等回忆类问题时，**立刻调用工具**而不是猜测。
- 工具调用请使用 OpenAI 标准 \`tool_calls\` 字段（SDK 会自动处理），**不要**自己手写 <tool_call>、<function_call>、<invoke> 等伪 XML 标签。
- 工具返回为空时，如实告诉用户"我在记忆里没找到相关内容"，不要编造。
- 文件系统/目录结构方面的问题：你**没有**直接读文件的工具——如果用户没在输入框挂文件，请请他挂上来；绝不要编造文件名或目录结构。`;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    messages = [],
    sessionKey = "default",
    sessionId = crypto.randomUUID(),
    syncedFilesIndex = [],
  } = body as {
    messages: Array<{ role: "user" | "assistant"; parts?: Array<{ type: string; text?: string }>; content?: string }>;
    sessionKey?: string;
    sessionId?: string;
    syncedFilesIndex?: SyncedFileEntry[];
  };

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") {
    return new Response("No user message", { status: 400 });
  }

  // Extract text from UIMessage parts (ai@6 format) or legacy content
  const userText = extractText(lastMsg);

  // 1. Recall memories
  const recall = recallForQuery(userText);

  // 2. Check Aha Insight
  const ahaPending = getAhaPending();
  const fireAha = ahaPending && shouldFireAha(userText, ahaPending);

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

  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({
    baseURL,
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // fucheers.top proxy only accepts Anthropic-style image blocks, not OpenAI's image_url.
    // Rewrite the request body so vision attachments work, and force non-streaming for
    // vision requests because the proxy strips images on streaming requests.
    fetch: createProxyFetch(),
  });

  const hasImage = messageHasImage(lastMsg);
  // For the manual chat loop we need plain OpenAI-format messages, not ai-sdk
  // UIMessages. Use convertToModelMessages to get the right shape, then map to
  // strict OpenAI schema.
  const modelMessages = await convertToModelMessages(messages as any);
  const openaiMessages = toOpenAIMessages(modelMessages);

  const afterFinish = async (text: string) => {
    const now = Date.now();
    try {
      insertL0({
        record_id: `l0_${now}_u_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey,
        session_id: sessionId,
        role: "user",
        message_text: userText + (hasImage ? "\n\n[附件：1 张图片]" : ""),
        recorded_at: new Date(now).toISOString(),
        timestamp: now,
      } satisfies L0Message);
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

    incrementTurnCount(sessionKey);
    if (shouldTriggerL1(sessionKey)) {
      runL1Pipeline(sessionKey, sessionId)
        .then(() => runAhaDetection())
        .catch((err) => console.error("[chat] L1 pipeline failed:", err));
    }
  };

  const chatTools: Tools = {
    ...buildChatTools(),
    ...buildSyncedFileTools(syncedFilesIndex),
  };

  // 3a. Vision path — non-streaming (proxy strips images on streaming).
  //     Vision-containing requests don't use tools; LLM just answers about the image.
  if (hasImage) {
    const gen = await generateText({
      model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
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
  const baseFetch = createProxyFetch();
  const result = await runChatLoop({
    systemPrompt,
    messages: openaiMessages,
    tools: chatTools,
    baseURL,
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    fetchImpl: baseFetch,
  });

  if (result.kind === "final") {
    await afterFinish(result.text);
    return uiStreamFromText(result.text);
  }

  if (result.kind === "error") {
    console.error("[chat] loop error:", result.error);
    return uiStreamFromText(`[Synapse 内部错误：${result.error}]`);
  }

  // result.kind === "pending-tool" → ship to client.
  // Do NOT call afterFinish — conversation is mid-flight, no final answer yet.
  return uiStreamFromPendingTool(result.toolCall);
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
