/**
 * Context analyzer — runs between FTS recall and the main chat LLM call.
 *
 * Architectural role:
 *   FTS gives us memories that are LEXICALLY similar to the user's message.
 *   This analyzer gives them a SEMANTIC type: "connection" / "contradiction" /
 *   "skip" — turning unstructured recall into typed relationships the main
 *   LLM can react to without further analysis.
 *
 * The Connection-Suggester and Contradiction-Finder features the product spec
 * asks for are NOT separate LLM passes — they are the two non-skip output
 * types of this single classifier. One LLM call covers both.
 *
 * No hardcoded thresholds. The classifier itself decides per case. To keep it
 * from spamming, the prompt enforces:
 *   - Default to "skip" when uncertain
 *   - Empty result is a valid (and common) output
 *   - Each non-skip must come with a short reason that grounds it in the
 *     specific overlap, not vague "this seems related"
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { MemoryRecord } from "../../tencentdb/record/l1-writer";

/**
 * One semantic relationship between the user's current message and a past
 * L1 memory. The main LLM uses these to decide what to weave into its reply
 * AFTER answering the user's primary question.
 */
export interface MemoryLink {
  memoryId: string;
  type: "connection" | "contradiction";
  /** ≤ 80 chars — short enough to slot into prompt without bloat. */
  reason: string;
  /** Pulled forward so the prompt block is self-contained for the main LLM. */
  snippet: string;
  /** Original memory date so the main LLM can phrase "two weeks ago you ...". */
  recordedAt: string;
}

/**
 * Classify a small set of FTS-recalled memory candidates against the user's
 * current message. Returns only `connection` and `contradiction` items —
 * `skip` items are dropped.
 *
 * Returns [] (and skips the LLM call entirely) for empty input. The cost
 * envelope is "one cheap LLM call per chat turn iff recall hit anything",
 * which we can amortize against the main turn's much larger spend.
 */
export async function analyzeRecallContext(
  userMessage: string,
  candidates: MemoryRecord[],
): Promise<MemoryLink[]> {
  if (candidates.length === 0) return [];
  // Skip absurdly short user messages — "hi" / "thanks" can't connect or
  // contradict anything.
  const trimmed = userMessage.trim();
  if (trimmed.length < 4) return [];

  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

  // Truncate each candidate so the prompt stays bounded even when recall
  // returns long memories.
  const memBlock = candidates.map((m, i) => {
    const c = m.content.length > 220 ? m.content.slice(0, 220) + "…" : m.content;
    return `[${i}] id=${m.id} (${m.type}, ${m.createdAt.slice(0, 10)}) ${c}`;
  }).join("\n");

  let raw: string;
  try {
    const res = await generateText({
      model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      system: SYSTEM,
      prompt: `用户当前消息：
"""
${trimmed.slice(0, 600)}
"""

候选记忆（按 FTS 相关度返回）：
${memBlock}

按 system 输出 JSON 数组。`,
      abortSignal: AbortSignal.timeout(8_000),
    });
    raw = res.text;
  } catch (err) {
    console.warn("[context-analyzer] LLM call failed, returning [] (silent degrade):", err);
    return [];
  }

  let parsed: Array<{ id: string; type: string; reason: string }>;
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }

  // Defensively look up each id back in candidates so a hallucinated id can't
  // sneak in. This also rehydrates snippet + recordedAt for the consumer.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: MemoryLink[] = [];
  for (const item of parsed) {
    if (!item?.id || !item?.type || !item?.reason) continue;
    if (item.type !== "connection" && item.type !== "contradiction") continue;
    const source = byId.get(item.id);
    if (!source) continue;  // LLM made up an id
    out.push({
      memoryId: item.id,
      type: item.type,
      reason: item.reason.slice(0, 100),
      snippet: source.content.length > 160 ? source.content.slice(0, 160) + "…" : source.content,
      recordedAt: source.createdAt,
    });
  }
  return out;
}

const SYSTEM = `你是上下文关联分析器。给定用户当前的一句话 + 系统从长期记忆里召回的若干候选条目，你要为每个候选打标签：

- "connection"：该记忆与当前消息构成**有信息量的关联**——比如同一项目的前期决策、同一概念的较早讨论、可以延展当前问题的相关背景。注意：仅仅"提到同一个词"不算 connection，必须是**让用户回忆起来会感觉有用**的关联。
- "contradiction"：当前消息与该记忆**实质上冲突**——用户改了主意、用了相反的方案、否定了之前的判断。仅仅措辞不同不算，必须是真冲突。
- 既不是 connection 也不是 contradiction → **不要输出这条**。

输出严格 JSON 数组（可以为空 \`[]\`）：
[
  { "id": "<memory id 原样回传>", "type": "connection" | "contradiction", "reason": "≤30字说明为什么" }
]

宁缺毋滥的硬规则：
- 不确定就跳过——空数组是完全合法的输出。
- 不要为了凑数硬找关联。
- 单条候选只能出现一次。
- reason 必须**具体到具体共同点**，不能是"都与 X 主题相关"这种空话。

只输出 JSON，不要任何其他内容。`;

/**
 * Format MemoryLink[] for injection into the main LLM's system prompt.
 * Empty input → empty string (caller can no-op).
 */
export function formatLinksForPrompt(links: MemoryLink[]): string {
  if (links.length === 0) return "";
  const lines: string[] = [];
  for (const l of links) {
    const date = l.recordedAt.slice(0, 10);
    const label = l.type === "contradiction" ? "⚠️ 冲突" : "🔗 关联";
    lines.push(`- ${label} [${date}] ${l.snippet}\n  → ${l.reason}`);
  }
  return `<noteworthy-links>
以下是用户当前消息与其长期记忆之间值得提及的关联或冲突。回答完用户的主要问题后，**用很轻的笔触**自然地点一下这些关联——比如"顺便注意到..."、"这跟你之前 X 的思路有连续性"、"上次你倾向 A，这次的 B 是改主意了吗"。
不要罗列所有项；只挑最相关的 1-2 条点出来。如果都不自然，可以全部忽略。
${lines.join("\n")}
</noteworthy-links>`;
}
