/**
 * Aha Insight detection — passive, surprise-driven.
 *
 * Checks if a pattern appears in ≥3 different sources (sessions/dates)
 * across a span of ≥2 weeks. If so, sets aha_pending state.
 *
 * On next chat turn, if query is semantically related to the pending pattern,
 * returns the Aha Insight to be embedded in the normal response.
 */

import crypto from "node:crypto";
import { generateText } from "ai";
import { getLLMProvider } from "@/lib/llm/provider";
import {
  getPipelineState,
  setPipelineState,
  appendAhaHistory,
  listAhaHistory,
  getAhaById,
  deleteAhaHistoryItem,
} from "./store";

function getUserLang(userId: string): "en" | "zh" {
  const stored = getPipelineState(`user_lang:${userId}`);
  return stored === "en" ? "en" : "zh";
}
import {
  detectThreadsForUser,
  rankThreads,
  formatThreadForPrompt,
  type MemoryThread,
} from "./insights/thread-detector";
import {
  detectThemeCandidateForUser,
  formatThemeForPrompt,
  type MemoryTheme,
} from "./insights/theme-detector";

// pipeline_state keys are per-user. Build them here so the rest of the file
// can read/write without thinking about scoping.
const k = {
  pending: (u: string) => `aha_pending:${u}`,
  last:    (u: string) => `aha_last:${u}`,
  seen:    (u: string) => `aha_last_seen_at:${u}`,
};

export interface ExternalSource {
  title: string;
  abstract: string;
  source: "semantic_scholar" | "arxiv";
  url?: string;
  year?: number;
}

/**
 * One node in the trajectory timeline — the evidence track that grounds the
 * pattern/hypothesis/reframe. Embedded directly so the modal can render
 * without re-fetching memories.
 */
export interface TrajectoryNode {
  memoryId: string;
  recordedAt: string;     // ISO timestamp
  type: string;           // claim / method / observation / ...
  snippet: string;        // ≤ 140 chars excerpt for the timeline UI
  /** One-line LLM reasoning: why this memory supports the insight. */
  why?: string;
}

/**
 * Aha cards come in two architectural flavors:
 *   - "trajectory": evolution over time WITHIN one L2 scene (X → Y → Z)
 *   - "theme":      a cross-cutting concern spanning MULTIPLE L2 scenes
 *
 * Both kinds share the same pattern/observation/hypothesis/reframe shape so
 * downstream consumers (modal, history list) treat them uniformly. The
 * `kind` discriminator drives the evidence layout in the UI: trajectory
 * renders a timeline strip; theme renders contributing-scene chips.
 */
export type AhaKind = "trajectory" | "theme";

export interface AhaPending {
  id: string;
  /** Discriminator — drives UI rendering of the evidence layer. */
  kind: AhaKind;
  /** Trajectory: the L2 scene_name. Theme: LLM-named cross-cutting concern. */
  topic: string;
  pattern: string;
  observation: string;
  hypothesis: string;
  reframe: string;
  /** Chronologically ordered evidence chain — populated for both kinds, but
   *  ordering only carries meaning for trajectory cards. */
  trajectory: TrajectoryNode[];
  /** Only populated when kind="theme" — the scene names that exhibit it. */
  themeScenes?: string[];
  /** Only populated when kind="theme" — short LLM-given reason. */
  themeReasoning?: string;
  /** Kept for back-compat with /api/aha/evidence consumers. */
  supportingMemoryIds: string[];
  externalSources: ExternalSource[];
  detectedAt: string;
  /** Detector stats captured at generation time — for tuning/audit. */
  metrics?: { sceneCount?: number; spanDays: number; memoryCount: number };
}

export interface AhaHistoryEntry {
  id: string;
  detectedAt: string;
  pattern: string;
  observation: string;
}

export function getAhaHistoryList(userId: string, limit = 30): AhaHistoryEntry[] {
  return listAhaHistory(userId, limit).map((row) => {
    try {
      const p = JSON.parse(row.payload_json) as AhaPending;
      return {
        id: row.id,
        detectedAt: row.detected_at,
        pattern: p.pattern ?? "",
        observation: p.observation ?? "",
      };
    } catch {
      return { id: row.id, detectedAt: row.detected_at, pattern: "", observation: "" };
    }
  });
}

export function getAhaFromHistory(userId: string, id: string): AhaPending | null {
  const row = getAhaById(userId, id);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as AhaPending;
  } catch {
    return null;
  }
}

export function getAhaPending(userId: string): AhaPending | null {
  const raw = getPipelineState(k.pending(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AhaPending;
  } catch {
    return null;
  }
}

// Mirror of aha_pending that is NEVER cleared — so the frontend can still
// render the evidence chain for the most recently detected Aha even after
// it was injected into a chat reply (which clears aha_pending).
export function getAhaLast(userId: string): AhaPending | null {
  const raw = getPipelineState(k.last(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AhaPending;
  } catch {
    return null;
  }
}

// Was the most recent Aha already shown to the user (sidebar click or chat
// inject)? Returns true when there's nothing new to surface.
export function isAhaLastSeen(userId: string): boolean {
  const aha = getAhaLast(userId);
  if (!aha) return true;
  const seenAt = getPipelineState(k.seen(userId)) ?? "";
  return seenAt >= aha.detectedAt;
}

// Mark the current latest Aha as seen so the sidebar badge clears.
export function markAhaLastSeen(userId: string): void {
  const aha = getAhaLast(userId);
  if (!aha) return;
  setPipelineState(k.seen(userId), aha.detectedAt);
}

export function clearAhaPending(userId: string): void {
  setPipelineState(k.pending(userId), "");
}

/**
 * Delete one Aha from history. Also clears the pending/last pointers if they
 * point at the same id — otherwise the sidebar badge would stay "unseen"
 * pointing at a record that no longer exists.
 */
export function deleteAhaInsight(userId: string, id: string): boolean {
  const ok = deleteAhaHistoryItem(userId, id);
  if (!ok) return false;
  const pending = getAhaPending(userId);
  if (pending?.id === id) setPipelineState(k.pending(userId), "");
  const last = getAhaLast(userId);
  if (last?.id === id) {
    setPipelineState(k.last(userId), "");
    setPipelineState(k.seen(userId), "");  // no last → seen state is moot
  }
  return true;
}

/**
 * Force-generate an Aha — manual "Look back" entry point. Tries theme first
 * (it's the rarer / more interesting card), falls back to top trajectory.
 * Surface vetoes are bypassed in force mode so the user always gets something.
 *
 * Writes to aha_last + history, and to aha_pending if none currently pending,
 * so the modal + badge UX is identical to passive detection.
 */
export async function forceGenerateAha(userId: string): Promise<AhaPending | null> {
  const lang = getUserLang(userId);
  // 1. Try cross-scene theme (LLM-driven detection — already filters its own quality)
  const theme = await detectThemeCandidateForUser(userId);
  if (theme) {
    const aha = await generateAhaFromTheme(theme, { force: true, lang });
    if (aha) { persistAha(userId, aha); return aha; }
  }
  // 2. Fall back to top within-scene trajectory
  const threads = rankThreads(detectThreadsForUser(userId));
  if (threads.length === 0) return null;
  const aha = await generateAhaFromThread(threads[0], { force: true, lang });
  if (!aha) return null;
  persistAha(userId, aha);
  return aha;
}

// Legacy bag-of-words check kept as a fallback when the LLM judge fails.
// Sync, no network, conservative threshold.
export function shouldFireAhaFallback(userText: string, aha: AhaPending): boolean {
  const patternWords = aha.pattern.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const queryLower = userText.toLowerCase();
  const matchCount = patternWords.filter((w) => queryLower.includes(w)).length;
  return matchCount >= Math.min(2, patternWords.length);
}

/**
 * LLM-based relevance judge — replaces the brittle bag-of-words `shouldFireAha`.
 * Decides whether to inline-inject the pending Aha into this chat turn based on
 * semantic relatedness between the user's query and the pending insight.
 *
 * Sidebar badge is the safety net: if this returns false, the Aha is still
 * reachable via the badge until the user clicks it. So we err on the side of
 * NOT injecting (avoid surprising the user with irrelevant cards).
 *
 * Budget: ~1s extra per chat when aha_pending exists. ~0 otherwise (early return).
 */
export async function shouldFireAhaLLM(userText: string, aha: AhaPending): Promise<boolean> {
  const provider = getLLMProvider();
  try {
    const result = await generateText({
      model: provider.createModel(),
      system: `你是相关性判官。判断【用户当前问题】是否与【待推送的洞察】话题相关。
只回答一个字：YES 或 NO。

YES 的标准：用户问的话题和洞察涉及同一研究方向/概念/工具。
NO 的标准：完全不相关、纯闲聊、问跟洞察无关的事。

宁严不松——宁可漏推不要错推。`,
      prompt: `【用户问题】${userText}

【待推送洞察的内容】
pattern: ${aha.pattern}
observation: ${aha.observation.slice(0, 200)}

YES 或 NO?`,
      abortSignal: AbortSignal.timeout(8_000),
    });
    const verdict = result.text.trim().toUpperCase();
    return verdict.startsWith("Y");
  } catch (err) {
    console.warn("[aha] LLM judge failed, falling back to bag-of-words:", err);
    return shouldFireAhaFallback(userText, aha);
  }
}

// Backward-compat alias kept for the old sync call sites — async-only now.
export const shouldFireAha = shouldFireAhaLLM;

/**
 * Passive detection — called after each L2 run. Tries to find ONE
 * surface-worthy insight, of either kind, with bias to skip.
 *
 * Strategy: theme first (cross-scene findings are rarer / higher-value).
 * If no theme, try top trajectory. Either generator can still veto via
 * `surface: false` — we don't fall through across candidates of the same
 * kind because that would bias toward surfacing something every time
 * (the spam mode we explicitly want to avoid).
 */
export async function runAhaDetection(userId: string): Promise<void> {
  if (getPipelineState(k.pending(userId))) return;  // already pending — don't stomp

  const lang = getUserLang(userId);

  // 1. Theme — its own LLM detector already enforces "found=false" for noise.
  //    Hard gate on top: a "recurring theme" must actually recur — ≥2 scenes
  //    AND ≥2 weeks of span. Below that it's coincidence, not a pattern, and
  //    surfacing it burns the user's trust in the feature.
  try {
    const theme = await detectThemeCandidateForUser(userId);
    if (theme) {
      const span = spanDaysOf(theme.memories);
      if (theme.scenes.length < 2 || span < MIN_THEME_SPAN_DAYS) {
        console.log(`[aha] theme gated out: scenes=${theme.scenes.length} spanDays=${span} (need ≥2 scenes, ≥${MIN_THEME_SPAN_DAYS}d)`);
      } else {
        const aha = await generateAhaFromTheme(theme, { force: false, lang });
        if (aha) { persistAha(userId, aha); return; }
      }
    }
  } catch (err) {
    console.warn("[aha] theme detection threw:", err);
  }

  // 2. Trajectory fallback — generator has its own surface veto for marginal
  //    threads (same-instant L1 batches, weak evolution, etc.).
  try {
    const threads = rankThreads(detectThreadsForUser(userId));
    if (threads.length === 0) return;
    const aha = await generateAhaFromThread(threads[0], { force: false, lang });
    if (aha) persistAha(userId, aha);
  } catch (err) {
    console.warn("[aha] trajectory detection threw:", err);
  }
}

function persistAha(userId: string, aha: AhaPending): void {
  const serialized = JSON.stringify(aha);
  setPipelineState(k.pending(userId), serialized);
  setPipelineState(k.last(userId), serialized);
  appendAhaHistory(userId, aha.id, aha.detectedAt, serialized);
}

// Passive theme gate: a theme must span at least this many days to surface.
const MIN_THEME_SPAN_DAYS = 14;

// Appended to every generator system prompt — asks for a per-memory reasoning
// line so the evidence drawer can show WHY each memory supports the insight.
const EVIDENCE_SUFFIX_ZH = `

补充要求：JSON 里额外加一个字段
"evidence": [{"i": <上面记忆列表的序号>, "why": "<一句话：这条记忆为什么支撑该结论，说人话>"}]
覆盖你真正引用的 2-6 条记忆即可，不要为凑数全列。`;
const EVIDENCE_SUFFIX_EN = `

Additional requirement: include one more JSON field
"evidence": [{"i": <index from the numbered memory list>, "why": "<one plain sentence: why this memory supports the conclusion>"}]
Cover only the 2-6 memories you actually drew on.`;

/** Days between oldest and newest memory in a set. */
function spanDaysOf(memories: Array<{ createdAt: string }>): number {
  const ts = memories.map((m) => Date.parse(m.createdAt)).filter(Number.isFinite);
  if (ts.length < 2) return 0;
  return Math.round((Math.max(...ts) - Math.min(...ts)) / 86_400_000);
}

/** Attach per-memory `why` lines onto trajectory nodes (1-based indexes). */
function applyEvidenceWhy(
  trajectory: TrajectoryNode[],
  evidence: Array<{ i?: number; why?: string }> | undefined,
): void {
  if (!Array.isArray(evidence)) return;
  for (const e of evidence) {
    if (typeof e?.i === "number" && typeof e?.why === "string" && e.why.trim()) {
      const node = trajectory[e.i - 1];
      if (node) node.why = e.why.trim();
    }
  }
}

/**
 * Generate an Aha card from one thread. The LLM sees an explicit chronological
 * sequence (`[date] (type) content`) and must:
 *   1. Decide if the sequence is a meaningful trajectory (vs noise).
 *   2. If meaningful, output pattern/observation/hypothesis/reframe that
 *      explicitly explains WHY this evolution makes sense.
 *   3. Return `{ "surface": false }` if not — built-in null-bias.
 *
 * `force=true` skips the surface judgment (used by manual trigger so the user
 * always sees something even from a marginal thread).
 */
async function generateAhaFromThread(
  thread: MemoryThread,
  opts: { force: boolean; lang?: "en" | "zh" },
): Promise<AhaPending | null> {
  const provider = getLLMProvider();

  const lang = opts.lang ?? "zh";
  const timeline = formatThreadForPrompt(thread);
  const system = (opts.force
    ? (lang === "en" ? FORCE_SYSTEM_PROMPT_EN : FORCE_SYSTEM_PROMPT)
    : (lang === "en" ? PASSIVE_SYSTEM_PROMPT_EN : PASSIVE_SYSTEM_PROMPT))
    + (lang === "en" ? EVIDENCE_SUFFIX_EN : EVIDENCE_SUFFIX_ZH);

  const prompt = lang === "en"
    ? `The following is the user's research trajectory on the topic "${thread.sceneName}" (chronological order):\n\n${timeline}\n\nOutput JSON per system instructions.`
    : `以下是用户在"${thread.sceneName}"这个话题下的研究轨迹（按时间升序）：\n\n${timeline}\n\n请按 system 指令输出 JSON。`;

  const result = await generateText({
    model: provider.createModel(),
    system,
    prompt,
    abortSignal: AbortSignal.timeout(30_000),
  });

  let parsed: ThreadGenResult;
  try {
    const cleaned = result.text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!opts.force && parsed.surface === false) return null;
  if (!parsed.pattern || !parsed.observation) return null;

  // Optional external evidence — non-fatal if it fails.
  const externalSources = await fetchExternalSourcesForAha(parsed.pattern, parsed.observation)
    .catch((err) => {
      console.warn("[aha] external source fetch failed:", err);
      return [] as ExternalSource[];
    });

  const trajectory: TrajectoryNode[] = thread.memories.map((m) => ({
    memoryId: m.id,
    recordedAt: m.createdAt,
    type: m.type,
    snippet: m.content.length > 140 ? m.content.slice(0, 140) + "…" : m.content,
  }));
  applyEvidenceWhy(trajectory, parsed.evidence);

  return {
    id: `aha_${crypto.randomBytes(5).toString("hex")}`,
    kind: "trajectory",
    topic: thread.sceneName,
    pattern: parsed.pattern,
    observation: parsed.observation,
    hypothesis: parsed.hypothesis ?? "",
    reframe: parsed.reframe ?? "",
    trajectory,
    supportingMemoryIds: thread.memories.map((m) => m.id),
    externalSources,
    detectedAt: new Date().toISOString(),
    metrics: { spanDays: spanDaysOf(thread.memories), memoryCount: thread.memories.length },
  };
}

/**
 * Generate a "theme" Aha card from a cross-scene MemoryTheme. The structure
 * is identical to trajectory cards (same JSON fields) so consumers can render
 * either uniformly — only the prompt and the `kind` field differ.
 *
 * Theme generator has no `surface: false` veto: theme-detector already vetoed
 * by returning null upstream. If we get a theme here, we're committed to
 * articulating it. The LLM may still return malformed JSON → we'd return null
 * for technical-failure reasons only, not "I don't think it's interesting".
 */
async function generateAhaFromTheme(
  theme: MemoryTheme,
  opts: { force: boolean; lang?: "en" | "zh" },
): Promise<AhaPending | null> {
  const provider = getLLMProvider();

  const lang = opts.lang ?? "zh";
  const themePrompt = formatThemeForPrompt(theme);
  const system = (lang === "en" ? THEME_SYSTEM_PROMPT_EN : THEME_SYSTEM_PROMPT)
    + (lang === "en" ? EVIDENCE_SUFFIX_EN : EVIDENCE_SUFFIX_ZH);
  const prompt = lang === "en"
    ? `A cross-cutting theme has been detected:\n\n${themePrompt}\n\nOutput JSON per system instructions.`
    : `检测到一个横切主题：\n\n${themePrompt}\n\n按 system 指令输出 JSON。`;

  const result = await generateText({
    model: provider.createModel(),
    system,
    prompt,
    abortSignal: AbortSignal.timeout(30_000),
  });

  let parsed: { pattern?: string; observation?: string; hypothesis?: string; reframe?: string; evidence?: Array<{ i?: number; why?: string }> };
  try {
    const cleaned = result.text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed.pattern || !parsed.observation) return null;

  const externalSources = await fetchExternalSourcesForAha(parsed.pattern, parsed.observation)
    .catch((err) => {
      console.warn("[aha] external source fetch failed:", err);
      return [] as ExternalSource[];
    });

  // For themes we still produce a "trajectory" array of evidence nodes (the
  // representative memories), but the UI knows from `kind` that ordering
  // doesn't carry meaning — it'll render them as scene-tagged evidence chips
  // instead of a timeline.
  const trajectory: TrajectoryNode[] = theme.memories.map((m) => ({
    memoryId: m.id,
    recordedAt: m.createdAt,
    type: m.type,
    snippet: m.content.length > 140 ? m.content.slice(0, 140) + "…" : m.content,
  }));
  applyEvidenceWhy(trajectory, parsed.evidence);

  return {
    id: `aha_${crypto.randomBytes(5).toString("hex")}`,
    kind: "theme",
    topic: theme.topic,
    pattern: parsed.pattern,
    observation: parsed.observation,
    hypothesis: parsed.hypothesis ?? "",
    reframe: parsed.reframe ?? "",
    trajectory,
    themeScenes: theme.scenes,
    themeReasoning: theme.reasoning,
    supportingMemoryIds: theme.memories.map((m) => m.id),
    metrics: {
      sceneCount: theme.scenes.length,
      spanDays: spanDaysOf(theme.memories),
      memoryCount: theme.memories.length,
    },
    externalSources,
    detectedAt: new Date().toISOString(),
  };
}

// ─── English prompt variants ───────────────────────────────────────────────

const PLAIN_LANGUAGE_RULES_EN = `[Plain-language rules — strictly observed]
- Speak directly to the user ("you"), like a long-time colleague who has been paying close attention — not like an academic paper.
- BANNED words and phrases: "node", "cognitive arc", "closed loop", "convergence", "paradigm", "deconstruct", "framework", "implicit architectural decision". Do not use these even once.
- No bullet-list enumeration (e.g. "claim → method → dataset" or "node 1 / 2 / 3"). Write narrative prose, not lists.
- Use concrete nouns. If a project name, tool name, or paper title appears in the material, name it explicitly — never say "a certain framework" or "a certain method".
- Length: natural. Long is fine, short is fine; prefer clear and slightly wordy over compressed and cryptic.
- Do not relabel content with structural jargon. If you mean "you were choosing hardware," say "you were picking hardware," not "performing hardware-selection decision modelling."`;

const THEME_SYSTEM_PROMPT_EN = `You are a cross-cutting theme observer. The input is an implicit preference the user has shown across several different topics. Your job is to describe it to the user in plain language.

${PLAIN_LANGUAGE_RULES_EN}

Output strict JSON:
{
  "pattern": "One short sentence (max two lines) naming the angle the user keeps returning to across different things. Be concrete — use nouns, not metaphors.",
  "observation": "Tell it like a story: 'Synapse noticed that when you were working on X you focused on A, then in Y you came back to A again, and by Z it was A once more — you have done this at least N times now.' Name at least 2 specific scenes/topics and spell out what the common thread actually is.",
  "hypothesis": "Start with 'What you may actually care about is…' — make a guess about the deeper concern.",
  "reframe": "Start with 'Looked at another way…' or 'These are all the same thing:…' — pull the apparently scattered topics toward one underlying motivation."
}

Goal: the user should finish reading and think "yes, that is exactly what I have been circling around" — not "what is this even saying."`;

const PASSIVE_SYSTEM_PROMPT_EN = `You are an observer of the user's research trajectory. You are given a chronologically ordered sequence of memories on one topic. Your job: decide whether this record contains a real thread of evolution the user may not have explicitly noticed — and only produce an insight when it genuinely does.

Criteria for "interesting" (all must hold):
1. Something changed over time — not the same thing recorded twice, but a real shift in thinking, approach, or focus.
2. The user probably hasn't explicitly noticed this shift — if you're just replaying what they just did, it has no value.
3. For short sequences (fewer than three entries) be especially sceptical; lean toward "not interesting" unless the thread is very clear.

${PLAIN_LANGUAGE_RULES_EN}

Output strict JSON — one of two forms:

[Not interesting]:
{ "surface": false }

[Interesting]:
{
  "surface": true,
  "pattern": "One plain-language sentence: what the user has mainly been doing or thinking about during this period. Name specific projects, tools, or questions — no metaphors.",
  "observation": "Tell it as a story: 'Synapse noticed that you started by looking at X, then moved to Y, and lately have been thinking about how to make Z work in practice.' Name the specific projects/tools/concepts — no 'node 1', 'the first entry', etc.",
  "hypothesis": "Start with 'What you may actually be trying to figure out is…' — speculate about the next direction.",
  "reframe": "Start with 'One way to read this whole sequence is:…' — give an interpretation the user would nod at."
}

When in doubt, leave it out — a missed insight costs less than an irrelevant one.`;

const FORCE_SYSTEM_PROMPT_EN = `You are an observer of the user's research trajectory. The user has manually requested an insight, so you MUST output pattern/observation/hypothesis/reframe — do not return surface=false.

${PLAIN_LANGUAGE_RULES_EN}

Output strict JSON:
{
  "pattern": "One plain-language sentence: what the user has mainly been doing or thinking about. Name specific projects, tools, or questions.",
  "observation": "Tell it as a story: 'Synapse noticed that you started by looking at X, then moved to Y, and lately have been thinking about Z.' Name specific projects/tools/concepts.",
  "hypothesis": "Start with 'What you may actually be trying to figure out is…'",
  "reframe": "Start with 'One way to read this whole sequence is:…'"
}`;

// ─── Chinese prompt variants ────────────────────────────────────────────────

const PLAIN_LANGUAGE_RULES = `【说人话规则 — 严格遵守】
- 第二人称对用户说话（"你"），像一个看了你很久的同事在跟你闲聊，不是写论文。
- **禁止**使用：节点、第N节点、认知弧、闭环、收敛、演进、命题、框架成、隐式架构决策、范式、收束、归一、解构。这些词出现一次都不行。
- **禁止**枚举式 "claim→method→dataset" 或 "节点 1/2/3" 这种结构化罗列。要叙事，不要列表。
- 用具体名词。如果材料里出现了项目名、工具名、文章名，要点名说出来，不要用 "某框架"、"某方法"。
- 不要数字限制字数，自然长度即可。长就长，短就短，宁可清晰啰嗦也不要为压字数变隐晦。
- 不要把内容塞回结构性概念里。如果你想说 "你在做硬件选型"，就直接说 "你在挑硬件"，不要说 "进行硬件选型决策的认知建模"。`;

const THEME_SYSTEM_PROMPT = `你是横切主题观察者。输入是用户在多个不同话题下都流露出来的同一种隐式偏好。你的工作是把这件事用人话讲给用户听。

${PLAIN_LANGUAGE_RULES}

输出严格 JSON：
{
  "pattern": "一句不超过两行的简短结论，告诉用户你在不同事情里反复关注的那个角度是什么。要具体到名词，不要用比喻。",
  "observation": "像跟用户讲故事一样：'Synapse 注意到，你在 X 上关注 A，又在 Y 上关注 A，到了 Z 又是 A——这件事你已经做了 N 次了。' 必须点名至少 2 个具体场景/话题，并说清楚它们之间共同的那个东西到底是什么。",
  "hypothesis": "用 '你可能真正在意的是…' 这样的句式，猜测用户内心更深的关切。",
  "reframe": "用 '换个角度看…' 或 '这些其实是同一件事：…' 这样的句式，把表面分散的话题归到一个动机上。"
}

任务核心：让用户读完想说 "对，我确实一直在想这个"，而不是想说 "这写的什么玩意儿"。`;

interface ThreadGenResult {
  surface?: boolean;
  pattern?: string;
  observation?: string;
  hypothesis?: string;
  reframe?: string;
  /** Per-memory reasoning, indexes refer to the numbered prompt list (1-based). */
  evidence?: Array<{ i?: number; why?: string }>;
}

const PASSIVE_SYSTEM_PROMPT = `你是用户研究轨迹的观察者。给你的是用户在某一个话题下按时间排序的记忆序列。你的工作：判断这段记录是不是真的有一条"用户自己可能没意识到的演变线索"，只有真的有的时候才输出洞察。

判断有没有意思的标准（必须同时满足）：
1. 时间上确实有变化——不是同一件事被反复记录，而是想法、做法、关注点在动。
2. 这个变化**用户自己可能没显式注意到**——如果只是把用户刚做的事重复一遍，没价值。
3. 三条以下的短序列要尤其谨慎，除非线索非常清楚，否则倾向于判定为噪声。

${PLAIN_LANGUAGE_RULES}

输出严格 JSON，二选一：

【没意思】输出：
{ "surface": false }

【有意思】输出：
{
  "surface": true,
  "pattern": "一句简短的人话总结：这段时间里你主要在做什么/想什么。要点出具体的项目、工具或问题名字，不要用比喻。",
  "observation": "像跟用户讲故事一样描述这段变化：'Synapse 注意到，你一开始在看 X，后来转去查 Y，最近又开始想 Z 怎么落地。' 把具体的项目/工具/概念点出来，不要说 '第一节点'、'前四节点' 这种。",
  "hypothesis": "用 '你可能真正想搞清楚的是…' 这样的句式，猜一下你接下来可能想往哪个方向走。",
  "reframe": "用 '其实你这一连串动作可以理解成：…' 这样的句式，给这段变化一个用户读完会点头的解读。"
}

宁缺毋滥——错过比误报代价小得多。`;

const FORCE_SYSTEM_PROMPT = `你是用户研究轨迹的观察者。用户手动点击要求生成洞察，所以**必须**输出 pattern/observation/hypothesis/reframe，不能 surface=false 跳过。

${PLAIN_LANGUAGE_RULES}

输出严格 JSON：
{
  "pattern": "一句简短的人话总结：这段时间里你主要在做什么/想什么。要点出具体的项目、工具或问题名字。",
  "observation": "像跟用户讲故事一样描述这段变化：'Synapse 注意到，你一开始在看 X，后来转去查 Y，最近又开始想 Z 怎么落地。' 把具体的项目/工具/概念点出来。",
  "hypothesis": "用 '你可能真正想搞清楚的是…' 这样的句式。",
  "reframe": "用 '其实你这一连串动作可以理解成：…' 这样的句式。"
}`;

async function fetchExternalSourcesForAha(
  pattern: string,
  observation: string,
): Promise<ExternalSource[]> {
  // The pattern/observation are typically Chinese narrative; Semantic Scholar
  // and arXiv are keyword-based English search engines. Ask Claude to distill
  // a short English keyword query first.
  const query = await extractEnglishKeywordQuery(pattern, observation);
  if (!query || query.length < 4) return [];

  const { searchSemanticScholar, searchArxiv } = await import("@/lib/search/external");
  const [scholar, arxiv] = await Promise.allSettled([
    searchSemanticScholar(query, 1),
    searchArxiv(query, 1),
  ]);
  const out: ExternalSource[] = [];
  if (scholar.status === "fulfilled") {
    for (const r of scholar.value) {
      if (!r.title) continue;
      out.push({
        title: r.title, abstract: r.abstract ?? "",
        source: "semantic_scholar", url: r.url, year: r.year,
      });
    }
  }
  if (arxiv.status === "fulfilled") {
    for (const r of arxiv.value) {
      if (!r.title) continue;
      out.push({
        title: r.title, abstract: r.abstract ?? "",
        source: "arxiv", url: r.url, year: r.year,
      });
    }
  }
  return out.slice(0, 2);
}

async function extractEnglishKeywordQuery(pattern: string, observation: string): Promise<string> {
  const provider = getLLMProvider();
  try {
    const result = await generateText({
      model: provider.createModel(),
      system: `You distill a research-pattern description into a short English keyword query
suitable for Semantic Scholar / arXiv. Output 3-6 English keywords separated by
spaces. No commas, no quotes, no full sentences, no explanation. Only the query.`,
      prompt: `Pattern: ${pattern}\n\nObservation: ${observation.slice(0, 300)}\n\nKeyword query:`,
      abortSignal: AbortSignal.timeout(8_000),
    });
    return result.text.replace(/["'\n]/g, " ").trim().slice(0, 120);
  } catch (err) {
    console.warn("[aha] keyword extraction failed:", err);
    return "";
  }
}

// (Trigram clustering `normalizePattern` was deleted — detection now uses
// L2 scene threading via lib/memory/insights/thread-detector.ts.)
