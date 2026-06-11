/**
 * Cross-scene theme detector.
 *
 * A "theme" is a recurring underlying concern that shows up in MULTIPLE L2
 * scenes — e.g., the user values reproducibility, which surfaces both in
 * their SDL infra work and in how they pick a Singapore neighborhood.
 *
 * This is fundamentally a different shape from a trajectory:
 *   Trajectory: t1 → t2 → t3  (evolution over time, single topic)
 *   Theme:      A ↔ B ↔ C    (cross-cutting concern, multiple topics)
 *
 * Detection is LLM-driven because no mechanical rule can tell that
 * "reproducibility in SDL" and "reproducibility in commute regularity" are
 * the same underlying preference. Mechanical clustering (trigrams, types)
 * misses this.
 *
 * Cost envelope: one cheap LLM call per Aha detection. Skipped entirely if
 * the user has fewer than 2 scenes (no theme possible).
 */
import path from "node:path";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { readSceneIndex } from "../../tencentdb/scene/scene-index";
import { getUserDataDir, sessionKeyForUser } from "../user-scope";
import { queryAllL1ForUser } from "../store";
import type { MemoryRecord } from "../../tencentdb/record/l1-writer";

export interface MemoryTheme {
  /** LLM-named theme — short noun phrase, e.g. "可复现性优先". */
  topic: string;
  /** L2 scene filenames (without .md) that exhibit this theme. ≥2. */
  scenes: string[];
  /** Representative L1 memories drawn from each contributing scene. */
  memories: MemoryRecord[];
  /** Why the LLM thinks these scenes share a concern (≤80 chars). */
  reasoning: string;
}

interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
}

/**
 * Detect at most one cross-scene theme for the user.
 *
 * Returns null if:
 *   - User has < 2 L2 scenes (can't cross-cut)
 *   - LLM can't find a meaningful cross-cutting concern
 *   - LLM call fails (silent degrade — Aha trajectory will still fire)
 */
export async function detectThemeCandidateForUser(userId: string): Promise<MemoryTheme | null> {
  const scenes = await loadScenes(userId);
  console.log(`[theme-detector] loaded ${scenes.length} candidate scenes for ${userId}:`);
  for (const s of scenes) {
    console.log(`  - ${s.filename} (heat=${s.heat}) :: ${s.summary.slice(0, 80)}`);
  }
  if (scenes.length < 2) {
    console.log(`[theme-detector] <2 scenes — skipping theme detection`);
    return null;
  }

  const proposal = await proposeThemeFromScenes(scenes);
  if (!proposal) {
    console.log(`[theme-detector] LLM returned found=false or invalid JSON — falling back to trajectory`);
    return null;
  }
  console.log(`[theme-detector] LLM proposed theme "${proposal.topic}" across ${proposal.scenes.length} scenes`);

  // Pull representative L1 memories from each named scene so the generator
  // has concrete content to ground its pattern in. Without this the generator
  // would just be paraphrasing scene summaries.
  const prefix = sessionKeyForUser(userId);
  const allMem = queryAllL1ForUser(prefix, 200);
  const memBySceneName = new Map<string, MemoryRecord[]>();
  for (const m of allMem) {
    const arr = memBySceneName.get(m.scene_name);
    if (arr) arr.push(m);
    else memBySceneName.set(m.scene_name, [m]);
  }
  // Match the LLM's chosen scene filenames back to scene_name on the memories.
  // The scene index filename is `<scene_name>.md`, and L1 records carry the
  // raw scene_name (no extension).
  const chosenSceneNames = proposal.scenes.map((f) => f.replace(/\.md$/, ""));
  const memories: MemoryRecord[] = [];
  for (const sn of chosenSceneNames) {
    const fromScene = memBySceneName.get(sn) ?? [];
    // Take up to 2 high-priority memories per scene to keep generation prompt bounded.
    fromScene
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, 2)
      .forEach((m) => memories.push(m));
  }
  if (memories.length < 2) return null;

  return {
    topic: proposal.topic,
    scenes: chosenSceneNames,
    memories,
    reasoning: proposal.reasoning,
  };
}

/**
 * Build the candidate scene list theme detection runs over.
 *
 * L1 `scene_name` is the source of truth for what topics the user actually has
 * memories in. L2 scene_block files are a crystallized SUBSET that the L2
 * pipeline has had time to summarize — for active users the L1 set is much
 * richer (e.g., user has 9 distinct L1 scene_names but only 1 has been
 * summarized into a scene_block file). Without this fallback, theme detection
 * silently returns null on real-but-young accounts because `scenes.length < 2`.
 *
 * Strategy: union of (L1 scene_names with ≥2 memories) and (L2 scene_index
 * entries). Use the L2 summary if present, otherwise synthesize one from the
 * memory snippets.
 */
async function loadScenes(userId: string): Promise<SceneIndexEntry[]> {
  const prefix = sessionKeyForUser(userId);
  const allMem = queryAllL1ForUser(prefix, 500);

  // Pull L2 summaries opportunistically — gives the LLM richer scene
  // descriptions when available, but we don't depend on them.
  const l2Summary = new Map<string, string>();
  const l2Heat = new Map<string, number>();
  try {
    const idx = await readSceneIndex(getUserDataDir(userId));
    for (const e of idx) {
      const name = e.filename.replace(/\.md$/, "");
      l2Summary.set(name, e.summary ?? "");
      l2Heat.set(name, e.heat ?? 0);
    }
  } catch {
    // No L2 index yet — fine, we'll synthesize from L1.
  }

  // Group L1 memories by scene_name.
  const grouped = new Map<string, MemoryRecord[]>();
  for (const m of allMem) {
    if (!m.scene_name) continue;
    const arr = grouped.get(m.scene_name);
    if (arr) arr.push(m);
    else grouped.set(m.scene_name, [m]);
  }

  const entries: SceneIndexEntry[] = [];
  for (const [name, mems] of grouped) {
    // A "scene" needs at least 2 memories to be worth proposing as part of a
    // cross-cutting theme. Single-memory scenes are too thin for the LLM to
    // make a meaningful judgement on.
    if (mems.length < 2) continue;
    const summary = l2Summary.get(name)
      || synthesizeSceneSummary(mems);
    entries.push({
      filename: name,
      summary,
      // Use L2 heat if available, else memory count as a coarse proxy.
      heat: l2Heat.get(name) ?? mems.length,
    });
  }

  entries.sort((a, b) => b.heat - a.heat);
  return entries;
}

/** Build a short scene summary from memory snippets when L2 hasn't run yet. */
function synthesizeSceneSummary(mems: MemoryRecord[]): string {
  return mems
    .slice(0, 3)
    .map((m) => m.content.replace(/\s+/g, " ").trim().slice(0, 90))
    .join("； ");
}

async function proposeThemeFromScenes(
  scenes: SceneIndexEntry[],
): Promise<{ topic: string; scenes: string[]; reasoning: string } | null> {
  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

  const sceneList = scenes.map((s, i) => {
    const name = s.filename.replace(/\.md$/, "");
    return `[${i}] ${name}\n    ${s.summary}`;
  }).join("\n\n");

  let raw: string;
  let finishReason: string | undefined;
  let usage: any;
  try {
    const res = await generateText({
      model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      system: SYSTEM,
      prompt: `用户目前有以下 L2 场景及其摘要：

${sceneList}

按 system 指令输出 JSON。`,
      abortSignal: AbortSignal.timeout(60_000),
    });
    raw = res.text;
    finishReason = res.finishReason as any;
    usage = res.usage;
  } catch (err) {
    console.warn("[theme-detector] LLM call failed:", err);
    return null;
  }
  console.log(`[theme-detector] LLM finish=${finishReason} usage=${JSON.stringify(usage)} rawLen=${raw?.length ?? 0}`);
  if (raw) {
    try { require("node:fs").writeFileSync("/tmp/theme-raw.txt", raw); } catch {}
    console.log(`[theme-detector] raw[0..120]=${JSON.stringify(raw.slice(0, 120))}`);
    console.log(`[theme-detector] raw[-120..]=${JSON.stringify(raw.slice(-120))}`);
  }

  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed?.found !== true) {
      console.log(`[theme-detector] parsed.found=${parsed?.found} — returning null`);
      return null;
    }
    if (!parsed.topic || !Array.isArray(parsed.scenes) || parsed.scenes.length < 2) {
      console.log(`[theme-detector] missing topic or scenes`);
      return null;
    }

    // LLMs frequently return scene REFERENCES instead of filenames, even when
    // told otherwise: index strings like "0", "[0]", indices as numbers, or
    // "scene_filename_1" template placeholders. Resolve all of these back to
    // real scene filenames before validation.
    const sceneByFilename = new Map(
      scenes.map((s) => [s.filename.replace(/\.md$/, ""), s.filename.replace(/\.md$/, "")]),
    );
    const resolved: string[] = [];
    for (const ref of parsed.scenes as Array<string | number>) {
      const refStr = String(ref).replace(/^\[?(\d+)\]?$/, "$1").replace(/\.md$/, "").trim();
      // Try as index first (most common LLM mistake)
      if (/^\d+$/.test(refStr)) {
        const idx = parseInt(refStr, 10);
        if (idx >= 0 && idx < scenes.length) {
          resolved.push(scenes[idx].filename.replace(/\.md$/, ""));
          continue;
        }
      }
      // Try as exact filename
      if (sceneByFilename.has(refStr)) {
        resolved.push(refStr);
        continue;
      }
      // Try as fuzzy substring match (LLM truncated/paraphrased the name)
      const fuzzy = scenes.find((s) => {
        const name = s.filename.replace(/\.md$/, "");
        return name.includes(refStr) || refStr.includes(name);
      });
      if (fuzzy) {
        resolved.push(fuzzy.filename.replace(/\.md$/, ""));
      }
    }

    // Dedup
    const chosen = Array.from(new Set(resolved));
    console.log(`[theme-detector] LLM proposed ${parsed.scenes.length} refs → resolved to ${chosen.length} real scenes`);
    if (chosen.length < 2) {
      console.log(`[theme-detector] resolved <2 scenes, refs were: ${JSON.stringify(parsed.scenes)}`);
      return null;
    }
    return {
      topic: String(parsed.topic).slice(0, 80),
      scenes: chosen,
      reasoning: String(parsed.reasoning ?? "").slice(0, 400),
    };
  } catch (e) {
    console.warn("[theme-detector] JSON parse failed:", (e as Error).message);
    return null;
  }
}

/** Format a theme for the generation LLM. */
export function formatThemeForPrompt(theme: MemoryTheme): string {
  const memBlock = theme.memories.map((m) => {
    const date = m.createdAt.slice(0, 10);
    return `[${date}] (scene: ${m.scene_name}, ${m.type}) ${m.content}`;
  }).join("\n");
  return `Theme: ${theme.topic}
Reasoning: ${theme.reasoning}
Spanning ${theme.scenes.length} scenes: ${theme.scenes.join(" / ")}

Representative memories:
${memBlock}`;
}

const SYSTEM = `你是研究主题串联器。给你用户最近的多个 scene。你的工作：找出**至少有 2 个 scene 共享的那条主线**，并把这些 scene 列出来。

**你是串联器，不是判官。**
- 大多数情况都能找到一条主线 —— 只要有 ≥2 个 scene 在讲相关的事，就 found=true。
- found=false 应当只在 scene 之间确实毫无关联时使用。

输出严格 JSON：

【确实没有任何连接】
{ "found": false }

【找到主线】
{
  "found": true,
  "topic": "把这些 scene 串起来的那条主线，用一个具体名词短语（不超过两行）。要点出具体的项目/方向/工具/概念名字，不要用比喻、不要用泛词。",
  "scenes": ["scene_filename_1", "scene_filename_2", ...],   // ≥ 2 个，原样回传 filename
  "reasoning": "用人话简单说为什么这些 scene 在同一条主线上。不要用 '横切主题'、'隐式关切'、'隐式架构' 这种学术黑话。"
}

只输出 JSON，不要任何解释或代码块围栏。`;
