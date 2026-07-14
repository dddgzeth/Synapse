/**
 * Memory recall — retrieve relevant L1 memories + L3 persona + connection /
 * contradiction analysis before each chat turn.
 *
 * Pipeline:
 *   user message
 *     ├─ persona.md (always)
 *     ├─ recalled L1 memories (lexical match, user-scoped)
 *     │    → recency decay + near-duplicate drop + char budget (quality gate)
 *     └─ context-analyzer: classifies recalled hits into connection / contradiction
 *
 * The analyzer is what turns Connection-Suggester and Contradiction-Finder
 * from "two more LLM features" into a single typed-relationship layer on top
 * of recall. The main chat LLM sees structured links and decides organically
 * when to weave them in.
 *
 * Returns synchronously-formatted context for direct system prompt injection.
 * Async because of the analyzer call.
 */

import fs from "node:fs";
import { searchL1HybridForUser } from "./hybrid";
import { getUserPersonaPath, sessionKeyForUser } from "./user-scope";
import { analyzeRecallContext, formatLinksForPrompt, type MemoryLink } from "./insights/context-analyzer";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

const TOP_K = 8;
// Over-fetch so decay/dedup have candidates to drop before cutting to TOP_K.
const FETCH_K = 20;
// Total char budget for the injected memories block (persona/links excluded).
const MEMORIES_CHAR_BUDGET = 2000;
// e-folding time for recency decay: a 30-day-old memory scores ~0.37 on recency.
const RECENCY_EFOLD_DAYS = 30;
// Char-bigram Jaccard above this ⇒ near-duplicate; keep the newer one.
const DEDUP_JACCARD = 0.8;

export interface RecallResult {
  memories: MemoryRecord[];
  persona: string | null;
  links: MemoryLink[];
  contextText: string; // formatted for LLM system prompt injection
}

export async function recallForQuery(userText: string, userId: string): Promise<RecallResult> {
  const userPrefix = sessionKeyForUser(userId);

  // L1 memory is user-global: search across ALL of this user's sessions.
  // Hybrid (FTS + vector RRF), over-fetched, then re-ranked: lexical rank
  // alone ignores WHEN a memory was made, so a stale conclusion could outrank
  // the revision that superseded it.
  const candidates = await searchL1HybridForUser(userText, userPrefix, FETCH_K);
  const memories = selectMemories(candidates);

  // Persona — always injected if it exists, independent of FTS match. This is
  // what made the bug "no record of your research direction" so bad: persona
  // was being skipped because of a wrong userId path. The fix is structural:
  // persona doesn't need to "match" anything; it IS the always-on profile.
  let persona: string | null = null;
  try {
    const personaPath = getUserPersonaPath(userId);
    if (fs.existsSync(personaPath)) {
      persona = fs.readFileSync(personaPath, "utf-8").trim() || null;
    }
  } catch {
    // persona not yet generated
  }

  // Semantic classification of the recalled memories — separated from FTS so
  // the spam-control logic (bias to skip) lives in one place.
  const links = await analyzeRecallContext(userText, memories);

  const contextText = formatRecallContext(memories, persona, links);
  return { memories, persona, links, contextText };
}

// ── Quality gate: score → dedup → budget ────────────────────────────

/**
 * Re-rank FTS candidates with lexical rank + recency + priority, drop
 * near-duplicates (keep the newer), and cut to TOP_K.
 */
function selectMemories(candidates: MemoryRecord[]): MemoryRecord[] {
  if (candidates.length === 0) return [];

  const now = Date.now();
  const scored = candidates.map((m, idx) => {
    // FTS returns rank-ordered rows; position is our lexical relevance proxy.
    const lexical = 1 / (idx + 1);
    const ageDays = Math.max(0, (now - Date.parse(m.createdAt || "")) / 86_400_000);
    const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / RECENCY_EFOLD_DAYS) : 0.5;
    const priority = Math.min(Math.max(m.priority ?? 3, 1), 5) / 5;
    return { m, score: lexical * 0.55 + recency * 0.3 + priority * 0.15 };
  });
  scored.sort((a, b) => b.score - a.score);

  // Near-duplicate drop: L1 extraction re-runs produce lightly reworded copies
  // of the same fact; without this they crowd out distinct memories.
  const kept: Array<{ m: MemoryRecord; grams: Set<string> }> = [];
  for (const { m } of scored) {
    const grams = bigrams(m.content);
    const dup = kept.find((k) => jaccard(grams, k.grams) >= DEDUP_JACCARD);
    if (!dup) {
      kept.push({ m, grams });
    } else if (Date.parse(m.createdAt || "") > Date.parse(dup.m.createdAt || "")) {
      dup.m = m; // same fact, newer version wins
      dup.grams = grams;
    }
    if (kept.length >= TOP_K) break;
  }
  return kept.map((k) => k.m);
}

/** Char bigrams — language-neutral (works for CJK where word splits don't). */
function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function formatRecallContext(
  memories: MemoryRecord[],
  persona: string | null,
  links: MemoryLink[],
): string {
  const parts: string[] = [];

  if (persona) {
    parts.push(`<researcher-profile>\n${persona}\n</researcher-profile>`);
  }

  if (memories.length > 0) {
    // Budget: keep whole lines (priority-then-score order preserved from
    // selectMemories) until the block would exceed MEMORIES_CHAR_BUDGET.
    const lines: string[] = [];
    let used = 0;
    for (const m of [...memories].sort((a, b) => b.priority - a.priority)) {
      const line = `[${m.type}] ${m.content}`;
      if (used + line.length > MEMORIES_CHAR_BUDGET && lines.length > 0) break;
      lines.push(line);
      used += line.length + 1;
    }
    parts.push(`<relevant-research-memories>\n${lines.join("\n")}\n</relevant-research-memories>`);
  }

  const linksBlock = formatLinksForPrompt(links);
  if (linksBlock) parts.push(linksBlock);

  return parts.join("\n\n");
}
