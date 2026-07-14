/**
 * LLM provider abstraction.
 *
 * One seam for every chat/completion LLM call so the rest of the app never
 * hand-rolls `createOpenAI` / baseURL juggling. Three backends:
 *
 *   - fucheers   (default)  OpenAI-compatible proxy that routes Claude. Non-
 *                           streaming tool loop + image transcription (its
 *                           gateway truncates tool_call args on stream and
 *                           rejects images+tools together).
 *   - openai                Direct OpenAI API — also OpenAI-compatible, so it
 *                           reuses the exact same raw-fetch path as fucheers.
 *   - anthropic             Direct Anthropic API via @ai-sdk/anthropic (only
 *                           loaded when selected).
 *
 * CRITICAL: the app must run with ONLY the fucheers key configured. fucheers
 * is the default; openai/anthropic are opt-in via `LLM_PROVIDER` env or a
 * per-request frontend override, and are never touched otherwise.
 *
 * Design: the provider owns exactly ONE primitive — "make one non-streaming
 * call → normalized result, or throw a detectable error". The manual tool loop
 * (chat-loop.ts) keeps everything else (compaction, tool execution, message
 * assembly) unchanged, so fucheers behaviour is byte-for-byte preserved.
 */
import { createOpenAI } from "@ai-sdk/openai";

export type LLMProviderType = "fucheers" | "openai" | "anthropic";

export interface LLMConfig {
  type: LLMProviderType;
  /** For OpenAI-compatible providers: the `/v1` base. Empty ⇒ official endpoint. */
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LLMCapabilities {
  /** Provider streams tool_call arguments intact (fucheers does NOT). */
  streamingToolCalls: boolean;
  /** Provider accepts images and tools in the same request (fucheers does NOT). */
  imagesWithTools: boolean;
}

// ── OpenAI wire message shape (single source of truth; chat-loop re-exports) ──
export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: string; [k: string]: unknown }> }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ChatCompletionResult {
  text: string;
  toolCalls: NormalizedToolCall[];
}

/** HTTP-level LLM error — carries status+body so context-window detection works. */
export class LLMHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM ${status}: ${body.slice(0, 300)}`);
  }
}

export interface ChatCompletionParams {
  system: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  signal?: AbortSignal;
}

export interface LLMProvider {
  config: LLMConfig;
  capabilities: LLMCapabilities;
  /** ai-sdk model handle for generateText/streamText call sites. */
  createModel(): ReturnType<ReturnType<typeof createOpenAI>["chat"]>;
  /** One non-streaming completion for the manual tool loop. */
  chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

export interface LLMOverride {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ── Config resolution ───────────────────────────────────────────────

function normV1(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function resolveConfig(override?: LLMOverride): LLMConfig {
  const rawType = (override?.provider && override.provider !== "default")
    ? override.provider
    : (process.env.LLM_PROVIDER || "fucheers");
  const type: LLMProviderType =
    rawType === "openai" || rawType === "anthropic" ? rawType : "fucheers";

  if (type === "openai") {
    return {
      type,
      baseURL: normV1(override?.baseUrl?.trim() || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      apiKey: override?.apiKey?.trim() || process.env.OPENAI_API_KEY || "",
      model: override?.model?.trim() || process.env.OPENAI_MODEL || "gpt-4o",
    };
  }
  if (type === "anthropic") {
    // Direct Anthropic uses DEDICATED env so it never collides with the
    // fucheers-repurposed ANTHROPIC_BASE_URL (which points at the proxy).
    return {
      type,
      baseURL: (override?.baseUrl?.trim() || process.env.ANTHROPIC_DIRECT_BASE_URL || "").replace(/\/$/, ""),
      apiKey: override?.apiKey?.trim() || process.env.ANTHROPIC_DIRECT_API_KEY || "",
      model: override?.model?.trim() || process.env.ANTHROPIC_DIRECT_MODEL || "claude-sonnet-4-6",
    };
  }
  // fucheers (default) — the only backend the app needs to run.
  return {
    type: "fucheers",
    baseURL: normV1(override?.baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL || "https://www.fucheers.top"),
    apiKey: override?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY || "",
    model: override?.model?.trim() || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  };
}

function capabilitiesFor(type: LLMProviderType): LLMCapabilities {
  if (type === "fucheers") return { streamingToolCalls: false, imagesWithTools: false };
  return { streamingToolCalls: true, imagesWithTools: true };
}

// ── OpenAI-compatible provider (fucheers + openai) ───────────────────

class OpenAICompatibleProvider implements LLMProvider {
  constructor(public config: LLMConfig, public capabilities: LLMCapabilities) {}

  createModel() {
    return createOpenAI({ baseURL: this.config.baseURL, apiKey: this.config.apiKey })
      .chat(this.config.model);
  }

  async chatCompletion({ system, messages, tools, signal }: ChatCompletionParams): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: false,
      messages: [{ role: "system", content: system }, ...messages],
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new LLMHttpError(resp.status, await resp.text().catch(() => ""));
    }
    // fucheers returns an SSE stream (`data: {...}` chunks) whenever `tools`
    // are present, IGNORING stream:false — so `resp.json()` throws on tool
    // turns (this was the latent "model provider returned an error" bug).
    // Read as text and branch: plain JSON vs SSE.
    const raw = await resp.text();
    return raw.trimStart().startsWith("data:") ? parseSSE(raw) : parseJSONCompletion(raw);
  }
}

/** Parse a standard non-streaming OpenAI chat.completion JSON body. */
function parseJSONCompletion(raw: string): ChatCompletionResult {
  const json = JSON.parse(raw);
  const msg = json.choices?.[0]?.message;
  return {
    text: msg?.content ?? "",
    toolCalls: (msg?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments || "{}",
    })),
  };
}

/** Accumulate an SSE `data:`-chunk stream into a single completion result. */
function parseSSE(raw: string): ChatCompletionResult {
  let content = "";
  // Streamed tool_calls arrive fragmented by `index`: id+name on the first
  // chunk, arguments concatenated across chunks.
  const acc = new Map<number, { id: string; name: string; args: string }>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: any;
    try { chunk = JSON.parse(payload); } catch { continue; }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    // Some proxies deliver the whole message in one SSE frame (message), others
    // stream deltas. Handle both.
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === "string") content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      acc.set(idx, cur);
    }
  }
  const toolCalls: NormalizedToolCall[] = [...acc.values()]
    .filter((t) => t.name)
    .map((t) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));
  return { text: content, toolCalls };
}

// ── Anthropic direct provider (lazy — only when selected) ────────────

class AnthropicProvider implements LLMProvider {
  constructor(public config: LLMConfig, public capabilities: LLMCapabilities) {}

  private sdk() {
    // Dynamic require keeps @ai-sdk/anthropic out of the fucheers-only path.
    const { createAnthropic } = require("@ai-sdk/anthropic");
    return createAnthropic({
      apiKey: this.config.apiKey,
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
    });
  }

  createModel() {
    return this.sdk()(this.config.model) as ReturnType<LLMProvider["createModel"]>;
  }

  async chatCompletion({ system, messages, tools, signal }: ChatCompletionParams): Promise<ChatCompletionResult> {
    const { generateText, jsonSchema, tool } = require("ai");
    // id → toolName map so OpenAI tool-result messages (which only carry the id)
    // can be rebuilt into ai-sdk tool-result parts (which need the name).
    const idToName = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) idToName.set(tc.id, tc.function.name);
      }
    }
    const modelMessages = messages.map((m) => toModelMessage(m, idToName)).filter(Boolean);
    const aiTools = tools && tools.length > 0
      ? Object.fromEntries(tools.map((t) => [
          t.function.name,
          tool({ description: t.function.description, inputSchema: jsonSchema(t.function.parameters) }),
        ]))
      : undefined;

    const result = await generateText({
      model: this.sdk()(this.config.model),
      system,
      messages: modelMessages,
      ...(aiTools ? { tools: aiTools } : {}),
      abortSignal: signal,
    });
    const toolCalls: NormalizedToolCall[] = (result.toolCalls ?? []).map((tc: any) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: JSON.stringify(tc.input ?? tc.args ?? {}),
    }));
    return { text: result.text ?? "", toolCalls };
  }
}

/** OpenAI wire message → ai-sdk ModelMessage (anthropic path only). */
function toModelMessage(m: OpenAIMessage, idToName: Map<string, string>): any {
  if (m.role === "system") return { role: "system", content: m.content };
  if (m.role === "tool") {
    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: m.tool_call_id,
        toolName: idToName.get(m.tool_call_id) ?? "tool",
        output: { type: "text", value: m.content },
      }],
    };
  }
  if (m.role === "assistant") {
    const parts: any[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: safeParse(tc.function.arguments),
      });
    }
    return { role: "assistant", content: parts.length ? parts : "" };
  }
  // user
  if (typeof m.content === "string") return { role: "user", content: m.content };
  const parts = m.content.map((p: any) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image_url") return { type: "image", image: p.image_url?.url ?? p.image_url };
    return { type: "text", text: "" };
  });
  return { role: "user", content: parts };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

// ── Factory + singleton ──────────────────────────────────────────────

function build(config: LLMConfig): LLMProvider {
  const caps = capabilitiesFor(config.type);
  return config.type === "anthropic"
    ? new AnthropicProvider(config, caps)
    : new OpenAICompatibleProvider(config, caps);
}

let _singleton: LLMProvider | null = null;

/** Process-wide default provider from env (fucheers unless LLM_PROVIDER set). */
export function getLLMProvider(): LLMProvider {
  if (!_singleton) _singleton = build(resolveConfig());
  return _singleton;
}

/** Per-request provider from a frontend override; falls back to env defaults. */
export function createLLMProviderFromOverride(override?: LLMOverride): LLMProvider {
  return build(resolveConfig(override));
}
