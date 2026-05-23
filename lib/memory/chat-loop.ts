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
  | { kind: "error"; error: string; messages: OpenAIMessage[] };

export interface RunChatLoopParams {
  systemPrompt: string;
  /** Conversation up to and including the latest user turn, OR with previously
   *  appended assistant tool_calls + tool_results from a resumed round. */
  messages: OpenAIMessage[];
  tools: Tools;
  baseURL: string;          // e.g. "https://www.fucheers.top/v1"
  apiKey: string;
  model: string;            // e.g. "claude-sonnet-4-6"
  maxTokens?: number;
  maxSteps?: number;
  timeoutMs?: number;
  /** Hook to rewrite outgoing body (e.g. for vision attachments). */
  fetchImpl?: typeof fetch;
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
// Main loop
// ─────────────────────────────────────

export async function runChatLoop(params: RunChatLoopParams): Promise<ChatLoopResult> {
  const {
    systemPrompt, messages: initialMessages, tools,
    baseURL, apiKey, model,
    maxTokens = 2048,
    maxSteps = 15,
    timeoutMs = 100_000,
    fetchImpl = fetch,
  } = params;

  let messages: OpenAIMessage[] = [...initialMessages];
  const toolDefs = toolsToOpenAI(tools);

  for (let step = 0; step < maxSteps; step++) {
    const body: any = {
      model,
      stream: false,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    };
    if (toolDefs.length > 0) {
      body.tools = toolDefs;
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${baseURL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "error", error: `fetch failed: ${msg}`, messages };
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        kind: "error",
        error: `fucheers ${resp.status}: ${body.slice(0, 300)}`,
        messages,
      };
    }

    let json: any;
    try {
      json = await resp.json();
    } catch (e) {
      return { kind: "error", error: `non-JSON response`, messages };
    }

    const choice = json.choices?.[0];
    if (!choice) {
      return { kind: "error", error: `no choice in response`, messages };
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

      if (spec.execute) {
        // Server-side execute
        let result: string;
        try {
          const out = await spec.execute(input);
          result = typeof out === "string" ? out : JSON.stringify(out);
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
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
    error: `loop hit maxSteps=${maxSteps} without resolution`,
    messages,
  };
}
