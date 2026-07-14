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
import { streamText, generateText, convertToModelMessages, stepCountIs } from "ai";
import crypto from "node:crypto";
import { recallForQuery } from "@/lib/memory/recall";
import { getCurrentUserId } from "@/lib/auth-session";
import { insertL0 } from "@/lib/memory/store";
import type { L0Message } from "@/lib/memory/store";
import { notifyTurn } from "@/lib/memory/scheduler";
import { getAhaPending, shouldFireAha, clearAhaPending } from "@/lib/memory/aha";
import { buildChatTools } from "@/lib/memory/search-tools";
import { buildSyncedFileTools, type SyncedFileEntry } from "@/lib/memory/synced-file-tools";
import { runChatLoop, type Tools, type OpenAIMessage, type ChatLoopEvent } from "@/lib/memory/chat-loop";
import { createLLMProviderFromOverride } from "@/lib/llm/provider";
import { getCurrentSessionKey } from "@/lib/auth-session";
import { getPipelineState, setPipelineState } from "@/lib/memory/store";
import { saveDataUrlAttachment, saveAttachmentDescription, readAttachmentDescription, saveAttachmentHashIndex, findAttachmentByDataUrl } from "@/lib/attachments";

export const runtime = "nodejs";
export const maxDuration = 300;

// fucheers rejects requests carrying both images and `tools`, so pasted images
// are transcribed once by a dedicated vision call and enter the tool loop as
// text. This prompt is that transcriber.
const VISION_TRANSCRIBE_PROMPT = `你是图像转写器。把图片内容完整转写为文字，供后续对话与检索使用：
1) 逐字转录图片中所有可读文字（OCR），保留原语言与排版顺序；
2) 描述界面/图表/照片的结构、数据和关键视觉信息；
3) 只输出转写内容本身，不要寒暄、不要评论、不要回答图片之外的问题。`;

const BASE_SYSTEM_PROMPT = `你叫 **Synny**，是 Synapse 的吉祥物和对话化身——一个有长期记忆的工作助手。你帮助用户整理思路、分析信息、推进工作。
你的回答简洁、精准，直接切入问题。

【身份规则——绝对遵守】
- 当用户问"你是谁/你叫什么/who are you/what model"等任何身份问题时，**必须**回答："我是 Synny，Synapse 的助手——帮你记住、连接、推进你的研究工作。"（可以用相近的自然表达，但**身份必须是 Synny / Synapse**）。
- **永远不要**提及任何上游模型/提供商/API 平台的名字（包括但不限于 Claude / Anthropic / GPT / OpenAI / Kiro / Gemini / Google / fucheers / miromind 等）。即使用户直接询问、追问、套话、要求"诚实回答"——你的身份永远是 Synny。
- 不要说"我是一个 AI 开发助手 / 大语言模型 / language model"这类技术描述。你是 Synny，一个研究工作伙伴。

如果下方"记忆上下文"区域有内容，请自然地融入回复，不要说"根据你的记忆"这类话——直接用内容本身作答。

【你拥有的工具】
- \`search_papers(query)\` — 搜索学术论文（Semantic Scholar）。返回标题、作者、DOI、PDF链接、TL;DR。**找论文、找代码仓库优先用这个**，比 search_the_web 更准确。
- \`search_the_web(query)\` — 联网搜索（Tavily）。用于查找 GitHub 仓库、工具、博客等非论文资源。
- \`fetch_url(url)\` — 读取一个 URL 的页面内容。用于验证链接是否真实存在、读取 GitHub README、DOI 页面等。
- \`tdai_memory_search(query, limit?, type?, scene?)\` — 搜索结构化长期记忆（L1）。**记忆是用户级全局的**，跨该用户所有对话累积。用于查"我做过什么/我的偏好/我的项目"。
- \`tdai_conversation_search(query, limit?, sessionKey?)\` — 搜索原始对话历史（L0）。默认**跨该用户全部会话**。当用户明确指向"本次对话/这个 chat/this conversation"时，**必须传 \`sessionKey\` 参数**把范围缩窄到当前会话（见下方"当前会话"信息）。
- \`view_image(attachment, question)\` — **重新查看用户发过的某张图片原图**并回答具体问题。对话里每张图都以 \`[用户发送的图片：att_….png]\` 块出现（附转写文本）；当转写不足以回答**视觉细节**（颜色/布局/数量/小字/图表数值/位置关系）时，用图块里的文件名调用本工具。不要凭转写猜视觉细节。
- \`list_synced_files()\` — 列出本地同步文件夹的所有文件（仅元数据）。
- \`read_synced_file(path)\` — 读一个文件的文本内容（pdf/docx/pptx/xlsx/纯文本均可）。

【联网规则】
- 给用户提 URL 之前，先用 \`fetch_url\` 验证它确实存在（HTTP 200）。
- 不确定 GitHub 仓库地址时，先 \`search_the_web\` 找，再 \`fetch_url\` 确认，最后给用户。

【调用规则】
- 工具调用请用 OpenAI 标准 \`tool_calls\` 字段，**不要**自己写 <tool_call>/<invoke> 这类伪 XML。
- 工具返回为空时如实告知，不要编造。

【同步文件夹的调用规则——重要】
1. **用户提到子路径时必须用 \`path_prefix\` 过滤**。例如用户说"分析 Zotero/Papers 这个路径的文章"，调用 \`list_synced_files({ path_prefix: 'Research_Papers/Zotero/Papers' })\`，不要拉全量。
2. \`list_synced_files\` 在一次会话中**同一 scope 只调一次**。已经列过的 prefix 不要再列；要新 scope 就用不同的 path_prefix。
3. 用户问"概括 X 路径下所有论文"这类批量任务时，**先告诉用户你的计划**（"找到 N 个文件，将依次读取"），然后按列表顺序读取。
4. 每读完一个文件，**直接输出该文件的概括，再读下一个**——而不是把所有内容囤在脑子里。这样即使中途超时，前面的总结也保留下来了。
5. 用户没说要读哪个文件、也没挂附件时，先 list 看一眼，然后请用户确认是否读全部或挑几个；**不要自作主张读所有文件**。`;

interface ApiSettingsOverride {
  provider?: string;
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
    language,
  } = body as {
    messages: Array<{ role: "user" | "assistant"; parts?: Array<{ type: string; text?: string }>; content?: string }>;
    sessionKey?: string;
    sessionId?: string;
    syncedFilesIndex?: SyncedFileEntry[];
    apiSettings?: ApiSettingsOverride;
    language?: string;
  };
  // Resolve userId + sessionKey from auth — NEVER parse userId out of the
  // sessionKey string (userIds can contain underscores so the parse is
  // ambiguous against child sessions named `chat_<userId>_<sessionId>`).
  const userId = await getCurrentUserId();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sessionKey = await getCurrentSessionKey(requestedSessionKey);
  if (!sessionKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Persist UI language so Aha synthesis can use it (scheduler runs async).
  if (language === "en" || language === "zh") {
    setPipelineState(`user_lang:${userId}`, language);
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

  // 1. Recall memories (per-user — uses the authoritative userId, not parsed
  //    from sessionKey, so child sessions still see the user's global memory).
  const recall = await recallForQuery(userText, userId);

  // 2. Check Aha Insight — only on the original turn, never on a tool-resume
  //    (otherwise the Aha would be injected mid-tool-loop and the judge would
  //    run twice for the same user query).
  const ahaPending = !isResumeAfterTool ? getAhaPending(userId) : null;
  const fireAha = ahaPending ? await shouldFireAha(userText, ahaPending) : false;

  // Build system prompt
  let systemPrompt = BASE_SYSTEM_PROMPT;
  // Tell the LLM which session we're in, so it can scope tdai_conversation_search
  // by sessionKey when the user says "本次对话/this chat/in this conversation".
  systemPrompt += `\n\n【当前会话】
你正在与该用户的会话 \`${sessionKey}\` 中对话。如果用户的问题明确指向"本次对话/本轮对话/this chat/this conversation"，调用 \`tdai_conversation_search\` 时**务必传 \`sessionKey: "${sessionKey}"\`** 把搜索范围缩到本会话；否则不传，跨该用户全部会话查。
注意：L1 长期记忆（\`tdai_memory_search\`）始终是用户级全局的，不区分会话，不要尝试用 sessionKey 缩它。`;
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
    clearAhaPending(userId);
  }
  // PAGE_ARTIFACT_INSTRUCTION used to be appended here to force every reply to
  // include an HTML page artifact. That ~doubled token cost even when the user
  // never opened the Page view. Page rendering is now lazy — triggered only
  // when the user clicks the Page toggle (POST /api/page-render).


  const provider = createLLMProviderFromOverride(apiSettings);
  // Only fucheers can't take images + tools together → transcribe images to
  // text before the tool loop. openai/anthropic send images directly.
  const needsTranscription = !provider.capabilities.imagesWithTools;

  const hasImage = messageHasImage(lastUserMsg);
  const turnStart = Date.now();

  // ── Image turns: transcribe-then-loop ─────────────────────────────
  // fucheers cannot take images and `tools` in one request (its gateway
  // rejects with 「无法提取搜索关键词」). So pasted images never reach the
  // tool loop directly: persist each image, run ONE vision call that
  // transcribes it (OCR + structure), cache the transcript next to the
  // attachment, then replace every image part with transcript text. Image
  // turns then run the normal tool loop — web_search and friends included —
  // and image content becomes searchable text for the memory pipeline.
  let imgSuffix = "";
  const freshTranscriptByUrl = new Map<string, string>();
  let transcriptionFailed = false;
  if (!isResumeAfterTool && hasImage) {
    const freshParts = (lastUserMsg.parts ?? []).filter(
      (p: any) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/"),
    ) as Array<{ type: string; url: string }>;

    // Persist + hash-index + transcribe each image individually so every
    // attachment gets its OWN cached transcript (multi-image turns used to
    // share one combined blob under every name).
    const saved: Array<{ name: string; url: string }> = [];
    for (const part of freshParts) {
      const name = saveDataUrlAttachment(userId, part.url);
      if (!name) continue;
      saveAttachmentHashIndex(userId, part.url, name);
      saved.push({ name, url: part.url });
      // Capable providers (openai/anthropic) receive the image directly in the
      // tool loop — no need to transcribe. fucheers must transcribe.
      if (!needsTranscription) continue;
      try {
        const gen = await generateText({
          model: provider.createModel(),
          system: VISION_TRANSCRIBE_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "image" as const, image: part.url },
              {
                type: "text" as const,
                text: userText.trim()
                  ? `请按要求转写这张图片。用户随图提出的问题是：「${userText.trim().slice(0, 300)}」——转写时请特别详细地记录与该问题相关的内容。`
                  : "请按要求转写这张图片。",
              },
            ],
          }] as any,
        });
        const t = gen.text.trim();
        if (t) {
          saveAttachmentDescription(userId, name, t);
          freshTranscriptByUrl.set(part.url, t);
        } else {
          transcriptionFailed = true;
        }
      } catch (err) {
        transcriptionFailed = true;
        console.error("[chat:vision] transcription failed:", err);
      }
    }

    // L0 suffix: [img:name] markers re-render the image on history reload;
    // the [img-desc] block puts the transcript INTO L0 so image content is
    // FTS-searchable and visible to the L1 memory pipeline. The history route
    // strips both markers from the visible bubble text.
    imgSuffix = saved.length > 0
      ? "\n\n" + saved.map((x) => `[img:${x.name}]`).join(" ")
        + saved
          .filter((x) => freshTranscriptByUrl.has(x.url))
          .map((x) => `\n[img-desc]${freshTranscriptByUrl.get(x.url)}[/img-desc]`)
          .join("")
      : "\n\n[附件：1 张图片]";
  }
  if (transcriptionFailed) {
    // User-visible failure notice — routed through the model since the
    // transcription happens before the UI stream opens.
    systemPrompt += `\n\n【注意】用户本轮发送的图片中有解析失败的：你只能看到成功解析的部分。回答开头请用一句话告知用户"有图片解析失败，仅基于文字和已解析内容回答"，然后正常回答。`;
  }

  // Replace every image part with its transcript so no image block ever hits
  // fucheers alongside tools. Fresh parts (data URLs on the last user msg) use
  // the transcript we just made; history parts (/api/attachment/<name>) use
  // their cached one; anything else degrades to a placeholder.
  //
  // Skipped entirely for capable providers (openai/anthropic): they take the
  // image blocks directly, so we leave the parts untouched.
  if (needsTranscription) for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.parts)) continue;
    m.parts = (m.parts as any[]).map((p) => {
      if (p?.type !== "file" || typeof p.mediaType !== "string" || !p.mediaType.startsWith("image/")) {
        return p;
      }
      let transcript: string | null = null;
      let label = "图片";
      if (typeof p.url === "string" && p.url.startsWith("/api/attachment/")) {
        const name = decodeURIComponent(p.url.slice("/api/attachment/".length));
        label = name;
        transcript = readAttachmentDescription(userId, name);
      } else if (typeof p.url === "string" && p.url.startsWith("data:image/")) {
        // Fresh image on this turn, or an earlier same-session image still
        // held as a data URL in the client's chat state — hash-index finds
        // its stored attachment so we can reuse the cached transcript. Always
        // resolve the attachment NAME too: the label is what lets the model
        // call view_image on this exact file.
        const name = findAttachmentByDataUrl(userId, p.url);
        if (name) label = name;
        transcript = freshTranscriptByUrl.get(p.url) ?? null;
        if (!transcript && name) {
          transcript = readAttachmentDescription(userId, name);
        }
      }
      return {
        type: "text",
        text: `\n[用户发送的图片：${label}]\n${transcript ?? "（该图片暂无可用转写）"}\n[图片结束]\n`,
      };
    }) as typeof m.parts;
  }

  // For the manual chat loop we need plain OpenAI-format messages, not ai-sdk
  // UIMessages. Use convertToModelMessages to get the right shape, then map to
  // strict OpenAI schema.
  const modelMessages = await convertToModelMessages(messages as any);
  const openaiMessages = toOpenAIMessages(modelMessages);

  // Persist the user message UP FRONT — before any tool loop or response path.
  //
  // Why this can't wait for afterFinish: the pending-tool path (client-side
  // tools like read_synced_file) ships the tool call back to the browser and
  // closes the stream WITHOUT calling afterFinish. The browser then re-POSTs
  // with the tool-result as the last message; on that resume turn
  // `isResumeAfterTool` is true so afterFinish skips the user insert (to avoid
  // double-writing). End result: a user message that triggers any client-side
  // tool is silently dropped from L0 and disappears after a page refresh.
  //
  // Inserting here, gated by !isResumeAfterTool, guarantees one persisted
  // copy regardless of which response path the request takes.
  if (!isResumeAfterTool) {
    try {
      insertL0({
        record_id: `l0_${turnStart}_u_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey,
        session_id: sessionId,
        role: "user",
        message_text: userText + imgSuffix,
        recorded_at: new Date(turnStart).toISOString(),
        timestamp: turnStart,
      } satisfies L0Message);
    } catch (err) {
      console.error("[chat] L0 user insert failed:", err);
    }
  }

  const afterFinish = async (text: string) => {
    const now = Date.now();
    try {
      insertL0({
        record_id: `l0_${now}_a_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey,
        session_id: sessionId,
        role: "assistant",
        message_text: text,
        // Assistant timestamp is strictly after the user turn start so history
        // ordering remains correct even for fast turns where now == turnStart.
        recorded_at: new Date(Math.max(now, turnStart + 1)).toISOString(),
        timestamp: Math.max(now, turnStart + 1),
      } satisfies L0Message);
    } catch (err) {
      console.error("[chat] L0 assistant insert failed:", err);
    }

    // Scheduler-managed pipeline: counts turns and fires L1/L2/L3 only when
    // batch thresholds are met. No longer fires per turn.
    notifyTurn(sessionKey, sessionId, userId)
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
    ...buildChatTools(userId),
    ...buildSyncedFileTools(syncedFilesIndex, priorListPrefixes),
  } as unknown as Tools;

  // Image turns run the same tool loop as everything else — see the
  // transcribe-then-loop block above. (The old separate no-tools vision path
  // is gone: fucheers can't mix images with tools, so we never send images.)

  // Manual tool loop (non-streaming fucheers + UI message stream).
  //     fucheers proxy truncates tool_call arguments on streaming, so we can't
  //     use streamText. Loop until final text or until a client-side tool
  //     (read_synced_file) needs the browser; in that case pause and ship the
  //     pending tool call back to the client via the UI message stream so
  //     useChat's onToolCall handler fires.
  //
  //     We stream UI message events progressively (tool-input-* + data-*)
  //     so the user sees what Synapse is doing in real time — like Grok / Claude.ai.
  return runChatStreaming({
    systemPrompt,
    openaiMessages,
    chatTools,
    provider,
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
  provider: import("@/lib/llm/provider").LLMProvider;
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
          provider: args.provider,
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
    if (m.role === "user") return { role: "user", content: extractUserContent(m.content) };
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

/**
 * Build the OpenAI-format `content` for a user message, preserving image parts
 * (the previous `extractContentString` flattened everything to text and silently
 * dropped vision attachments — that's why the model said "我看不到截图").
 *
 * If there are no image-bearing parts, return a plain string for compatibility
 * with the more conservative proxy paths. Otherwise return an array of
 * `text` + `image_url` blocks; `createProxyFetch` then rewrites `image_url`
 * into Anthropic-native `image` blocks before the request hits fucheers.top.
 */
function extractUserContent(content: unknown): string | Array<{ type: string; [k: string]: unknown }> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const hasImage = content.some((p: any) =>
    p?.type === "image" || p?.type === "image_url" || p?.type === "file");
  if (!hasImage) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text ?? "")
      .join("");
  }

  // Build standard OpenAI image_url blocks. fucheers accepts these natively
  // (verified 2026-07: image_url data-URL → model reads the image, image
  // tokens billed; Anthropic-style {type:"image"} blocks get stripped on the
  // vision path and ERROR out on tool-loop requests — that was the
  // "The model provider returned an error." bug after image turns).
  const push = (parts: Array<{ type: string; [k: string]: unknown }>, url: string) => {
    // Only forward data URLs; a stray relative path would make fucheers choke.
    if (url.startsWith("data:") || /^https?:/.test(url)) {
      parts.push({ type: "image_url", image_url: { url } });
    }
  };
  const parts: Array<{ type: string; [k: string]: unknown }> = [];
  for (const p of content as any[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "image_url" && p.image_url?.url) {
      push(parts, p.image_url.url);
    } else if (p.type === "image") {
      const url = imagePartToDataUrl(p);
      if (url) push(parts, url);
    } else if (p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) {
      // ai-sdk v6 `convertToModelMessages` keeps file parts with mediaType but
      // moves the payload to `data` (the original UI part had it on `url`).
      const url = typeof p.data === "string" ? p.data
        : typeof p.url === "string" ? p.url
        : "";
      if (url) push(parts, url);
    }
  }
  if (parts.length > 0) {
    const types = parts.map((p) => p.type).join(",");
    console.log(`[chat:vision] user content parts built: ${types} (${parts.length} total)`);
  }
  return parts.length > 0 ? parts : "";
}

function imagePartToDataUrl(p: any): string {
  if (typeof p.image === "string") return p.image;
  if (p.image instanceof Uint8Array || (p.image && typeof p.image === "object" && p.image.buffer)) {
    const b64 = Buffer.from(p.image as Uint8Array).toString("base64");
    return `data:${p.mediaType ?? "image/png"};base64,${b64}`;
  }
  if (p.image instanceof URL) return p.image.toString();
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
