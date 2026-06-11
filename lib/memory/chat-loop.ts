/**
 * Manual chat tool-call loop — works around the fucheers proxy bug that
 * truncates tool_call arguments on streaming responses.
 *
 * Flow:
 *   1. Convert ai-SDK tool definitions to OpenAI function-calling format.
 *   2. POST non-streaming to fucheers `/chat/completions`.
 *   3. If the assistant message has no tool_calls → return final text.
 *   4. For each tool_call:
 *      a. If the tool has a server-side `execute` → run it, append tool_result
 *         to messages, continue loop.
 *      b. If the tool has NO `execute` → pause. Return the pending tool call
 *         so the route can ship it to the browser via a UI message stream.
 *         Client reads the file, sends a follow-up POST with tool_result
 *         appended, server resumes this loop.
 *   5. Loop bounded by `maxSteps`.
 */

import { z } from "zod";

// ─────────────────────────────────────
// Types
// ─────────────────────────────────────

export interface ToolSpec {
  description: string;
  inputSchema: z.ZodTypeAny;
  /** If undefined → client-side tool: server pauses and ships to client. */
  execute?: (input: any) => Promise<string | unknown>;
}

export type Tools = Record<string, ToolSpec>;

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: string; [k: string]: unknown }> }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatLoopResult =
  | { kind: "final"; text: string; messages: OpenAIMessage[] }
  | {
      kind: "pending-tool";
      toolCall: { id: string; name: string; input: unknown };
      messages: OpenAIMessage[];
    }
  | { kind: "error"; code: ChatLoopErrorCode; error?: string; messages: OpenAIMessage[] };

export type ChatLoopErrorCode =
  | "request_timed_out"
  | "context_still_too_long"
  | "context_too_long_no_compactable"
  | "provider_error";

export type ChatLoopEvent =
  | { kind: "step-start"; step: number; promptChars: number; budgetMs: number }
  | { kind: "step-text"; step: number; text: string }
  | { kind: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; name: string; output: string; tookMs: number }
  | { kind: "tool-error"; toolCallId: string; name: string; error: string }
  | { kind: "compaction"; reason: "context-budget" | "context-error" | "timeout-retry"; beforeChars: number; afterChars: number; targetToolCallId?: string }
  | { kind: "notice"; code: "context_too_long_retry"; detail?: string };

export interface RunChatLoopParams {
  systemPrompt: string;
  /** Conversation up to and including the latest user turn, OR with previously
   *  appended assistant tool_calls + tool_results from a resumed round. */
  messages: OpenAIMessage[];
  tools: Tools;
  baseURL: string;          // e.g. "https://www.fucheers.top/v1"
  apiKey: string;
  model: string;            // e.g. "claude-sonnet-4-6"
  maxSteps?: number;
  timeoutMs?: number;
  /** Hook to rewrite outgoing body (e.g. for vision attachments). */
  fetchImpl?: typeof fetch;
  /** Optional progress emitter — route handler uses this to stream UI events. */
  onEvent?: (event: ChatLoopEvent) => void;
}

// ─────────────────────────────────────
// Tool format conversion
// ─────────────────────────────────────

function toolsToOpenAI(tools: Tools) {
  return Object.entries(tools).map(([name, spec]) => ({
    type: "function" as const,
    function: {
      name,
      description: spec.description,
      // zod v4 has built-in JSON Schema conversion.
      parameters: (z as any).toJSONSchema(spec.inputSchema),
    },
  }));
}

// ─────────────────────────────────────
// Context management
// ─────────────────────────────────────

// Legacy pre-step budget gate. Disabled after provider probes showed both
// configured APIs accept much larger contexts; only compact on real API
// context-window errors now. Keep the old values here for reference.
// const MAX_INPUT_CHARS = 180_000;
// const COMPACT_TARGET_CHARS = 130_000;
// Below this size we won't try to compact a single tool result (not worth it).
const COMPACT_MIN_TOOL_CHARS = 5_000;

function totalMessageChars(messages: OpenAIMessage[], systemPrompt: string): number {
  let n = systemPrompt.length;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) n += JSON.stringify(m.content).length;
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) n += tc.function.arguments.length + tc.function.name.length + 32;
    }
  }
  return n;
}

/**
 * Replace the largest tool result with an LLM-generated summary. This is now a
 * last-resort fallback for real provider context-window errors, not a routine
 * pre-step budget gate.
 *
 * If the summarizer LLM call itself fails, falls back to a hard-truncate so
 * we always make forward progress.
 */
async function compactOnce(
  messages: OpenAIMessage[],
  baseURL: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch,
  onEvent?: (e: ChatLoopEvent) => void,
  reason: "context-budget" | "context-error" | "timeout-retry" = "context-error",
): Promise<{ messages: OpenAIMessage[]; compacted: boolean }> {
  let biggestIdx = -1;
  let biggestSize = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const sz = typeof m.content === "string" ? m.content.length : 0;
    if (sz > biggestSize && sz > COMPACT_MIN_TOOL_CHARS) {
      biggestSize = sz;
      biggestIdx = i;
    }
  }
  if (biggestIdx === -1) return { messages, compacted: false };

  const target = messages[biggestIdx] as { role: "tool"; tool_call_id: string; content: string };
  const original = target.content;

  let summary: string;
  try {
    const resp = await fetchImpl(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        // No max_tokens — the prompt asks for a dense summary, let the model
        // decide its own length so important facts aren't cut off.
        messages: [
          {
            role: "system",
            content:
              "You compress a tool's raw output into a dense factual summary. " +
              "Keep ALL named entities, numbers, file paths, conclusions, decisions, and specific claims. " +
              "Drop boilerplate, repetition, and prose decoration. " +
              "Output only the summary — no preface, no meta-commentary.",
          },
          {
            role: "user",
            // Cap input to 100k chars so the summarizer itself doesn't time out.
            content: original.length > 100_000
              ? original.slice(0, 50_000) + "\n\n[...middle elided...]\n\n" + original.slice(-50_000)
              : original,
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    summary = j.choices?.[0]?.message?.content ?? "";
    if (!summary || summary.length < 50) throw new Error("empty summary");
  } catch (err) {
    // Fall back to hard truncate so we make forward progress.
    console.warn("[chat-loop] compactor LLM failed, hard-truncating:", err);
    summary = original.slice(0, 4_000) + `\n\n[...truncated; original ${original.length} chars; summarizer failed]`;
  }

  const compacted = `[COMPACTED — original tool output was ${original.length} chars]\n\n${summary}`;
  const newMessages = messages.map((m, i) =>
    i === biggestIdx ? { ...target, content: compacted } : m,
  );

  onEvent?.({
    kind: "compaction",
    reason,
    beforeChars: original.length,
    afterChars: compacted.length,
    targetToolCallId: target.tool_call_id,
  });

  return { messages: newMessages, compacted: true };
}

// Legacy pre-step compaction is intentionally disabled. It caused long stalls
// on large file/tool workflows by summarizing before the provider actually
// rejected the request.
// async function compactUntilBudget(...) { ... }

class ApiResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`provider ${status}: ${body.slice(0, 300)}`);
  }
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "AbortError" || /aborted/i.test(e.message);
}

function isContextWindowError(e: unknown): boolean {
  const text = e instanceof ApiResponseError
    ? `${e.status} ${e.body}`.toLowerCase()
    : e instanceof Error
      ? e.message.toLowerCase()
      : String(e).toLowerCase();

  return (
    /\b(context|token|prompt|input)\b/.test(text) &&
    /(length|limit|window|maximum|max|exceed|exceeded|too long|too large)/.test(text)
  ) || /context_length_exceeded|maximum context|too many tokens|request entity too large|payload too large/.test(text);
}

// ─────────────────────────────────────
// Main loop
// ─────────────────────────────────────

export async function runChatLoop(params: RunChatLoopParams): Promise<ChatLoopResult> {
  const {
    systemPrompt, messages: initialMessages, tools,
    baseURL, apiKey, model,
    maxSteps = 20,
    // Per-step timeout is adaptive (see computeStepTimeout below). The static
    // `timeoutMs` only acts as an upper cap.
    timeoutMs = 300_000,
    fetchImpl = fetch,
    onEvent,
  } = params;

  let messages: OpenAIMessage[] = [...initialMessages];
  const toolDefs = toolsToOpenAI(tools);

  for (let step = 0; step < maxSteps; step++) {
    // Helper to do the actual fucheers call with adaptive timeout. Returns
    // either a parsed response or throws.
    const callFucheers = async (): Promise<any> => {
      const body: any = {
        model,
        stream: false,
        // No max_tokens — let the model run to completion. The proxy will
        // honour the model's own default cap.
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
      };
      if (toolDefs.length > 0) {
        body.tools = toolDefs;
        body.tool_choice = "auto";
      }
      const promptChars = totalMessageChars(messages, systemPrompt);
      // Budget for generation time without a maxTokens hint: assume up to
      // ~30k token output (worst case ≈ 5 minutes streaming).
      const adaptiveTimeout = Math.min(
        timeoutMs,
        30_000 + promptChars * 5 + 240_000,
      );
      onEvent?.({ kind: "step-start", step, promptChars, budgetMs: adaptiveTimeout });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), adaptiveTimeout);
      try {
        const resp = await fetchImpl(`${baseURL}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        clearTimeout(timer);
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          throw new ApiResponseError(resp.status, errBody);
        }
        return resp.json();
      } finally {
        clearTimeout(timer);
      }
    };

    // ── 1. Try the call. Only compact after a real provider context-window error.
    let json: any;
    try {
      json = await callFucheers();
    } catch (e) {
      if (isAbortError(e)) {
        return {
          kind: "error",
          code: "request_timed_out",
          messages,
        };
      }

      if (isContextWindowError(e)) {
        onEvent?.({
          kind: "notice",
          code: "context_too_long_retry",
        });
        const r = await compactOnce(messages, baseURL, apiKey, model, fetchImpl, onEvent, "context-error");
        if (r.compacted) {
          messages = r.messages;
          try {
            json = await callFucheers();
          } catch (e2) {
            if (isContextWindowError(e2)) {
              return { kind: "error", code: "context_still_too_long", messages };
            }
            return {
              kind: "error",
              code: "provider_error",
              error: e2 instanceof Error ? e2.message : String(e2),
              messages,
            };
          }
        } else {
          return {
            kind: "error",
            code: "context_too_long_no_compactable",
            messages,
          };
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: "error", code: "provider_error", error: msg, messages };
      }
    }

    const choice = json.choices?.[0];
    if (!choice) {
      return { kind: "error", code: "provider_error", error: "no choice in response", messages };
    }
    const assistantMsg = choice.message;
    const toolCalls = assistantMsg?.tool_calls ?? [];
    const text: string = assistantMsg?.content ?? "";

    // No tool calls → final answer.
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: text });
      return { kind: "final", text, messages };
    }

    // Has tool calls — push the assistant message (with tool_calls) into history.
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        },
      })),
    });

    // Execute each tool call. Server-side execute → push tool_result and continue.
    // Client-side (no execute) → pause and ship to browser.
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const spec = tools[name];
      if (!spec) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: unknown tool "${name}"`,
        });
        continue;
      }
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {};
      }

      onEvent?.({ kind: "tool-call", toolCallId: tc.id, name, input });

      if (spec.execute) {
        // Server-side execute
        const t0 = Date.now();
        let result: string;
        try {
          const out = await spec.execute(input);
          result = typeof out === "string" ? out : JSON.stringify(out);
          onEvent?.({ kind: "tool-result", toolCallId: tc.id, name, output: result, tookMs: Date.now() - t0 });
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e);
          result = `Error: ${errStr}`;
          onEvent?.({ kind: "tool-error", toolCallId: tc.id, name, error: errStr });
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      } else {
        // Client-side — pause. Note: if there are multiple tool calls in this
        // step, we handle the FIRST client-side one and stop. Any server-side
        // tools earlier in the loop already executed.
        return {
          kind: "pending-tool",
          toolCall: { id: tc.id, name, input },
          messages,
        };
      }
    }

    // All tool calls in this step were server-side; loop with appended results.
  }

  return {
    kind: "error",
    code: "provider_error",
    error: `loop hit maxSteps=${maxSteps} without resolution`,
    messages,
  };
}
