/**
 * Hybrid search — FTS5 (lexical) + sqlite-vec (semantic), merged with
 * Reciprocal Rank Fusion. This is what makes "上周那个催化剂效率的想法"
 * findable even when no literal word overlaps with the stored memory.
 *
 * Degrades cleanly: if the embedding model is missing or the query embed
 * fails, results are exactly the old FTS-only behaviour.
 */
import {
  searchL0FtsForUser,
  searchL1FtsForUser,
  searchL0VecForUser,
  searchL1VecForUser,
  type L0Message,
} from "./store";
import { embedText, vecToBuffer } from "./embedding";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

// Standard RRF constant — dampens the head so one list can't dominate.
const RRF_K = 60;

/**
 * Merge two rank-ordered lists by RRF; earlier rank ⇒ larger contribution.
 * `boost` adds a per-item bonus AFTER fusion — used to pull literal keyword /
 * phrase matches above semantically-similar-but-not-matching neighbours.
 */
function rrfMerge<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  limit: number,
  boost?: (item: T) => number,
): T[] {
  const score = new Map<string, { item: T; s: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = keyOf(item);
      const inc = 1 / (RRF_K + rank + 1);
      const cur = score.get(key);
      if (cur) cur.s += inc;
      else score.set(key, { item, s: inc });
    });
  }
  if (boost) for (const e of score.values()) e.s += boost(e.item);
  return [...score.values()]
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((e) => e.item);
}

/**
 * Lexical relevance bonus. A full-phrase substring hit (0.05) outweighs the
 * max possible RRF score (≈2/61 ≈ 0.033), so an exact keyword match always
 * ranks first; partial token coverage adds a smaller nudge.
 */
function lexicalBoost<T>(query: string, textOf: (t: T) => string): (t: T) => number {
  const phrase = query.trim().toLowerCase();
  const tokens = [...new Set(phrase.split(/\s+/).filter((t) => t.length >= 2))];
  return (item) => {
    const text = (textOf(item) || "").toLowerCase();
    if (!text) return 0;
    let b = 0;
    if (phrase.length >= 2 && text.includes(phrase)) b += 0.05;
    for (const tok of tokens) if (text.includes(tok)) b += 0.004;
    return b;
  };
}

export async function searchL1HybridForUser(
  query: string,
  sessionKeyPrefix: string,
  limit = 15,
): Promise<MemoryRecord[]> {
  const fts = searchL1FtsForUser(query, sessionKeyPrefix, limit);
  const boost = lexicalBoost<MemoryRecord>(query, (m) => m.content);
  const qv = await embedText(query);
  if (!qv) return rrfMerge([fts], (m) => m.id, limit, boost);
  const vec = searchL1VecForUser(vecToBuffer(qv), sessionKeyPrefix, limit);
  return rrfMerge([fts, vec], (m) => m.id, limit, boost);
}

export async function searchL0HybridForUser(
  query: string,
  sessionKeyPrefix: string,
  limit = 30,
): Promise<L0Message[]> {
  const fts = searchL0FtsForUser(query, sessionKeyPrefix, limit);
  const boost = lexicalBoost<L0Message>(query, (m) => m.message_text);
  const qv = await embedText(query);
  if (!qv) return rrfMerge([fts], (m) => m.record_id, limit, boost);
  const vec = searchL0VecForUser(vecToBuffer(qv), sessionKeyPrefix, limit);
  return rrfMerge([fts, vec], (m) => m.record_id, limit, boost);
}
