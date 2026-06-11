/**
 * Memory thread detector.
 *
 * A "thread" is a chronologically ordered sequence of L1 memories that all
 * belong to the same L2 scene. Threads are the structural primitive that
 * Aha (trajectory) and the in-chat context-analyzer both build on top of.
 *
 * The detector does NO semantic judgement and NO hardcoded "interestingness"
 * scoring beyond minimal viability. The LLM downstream decides whether a
 * thread is worth surfacing — this module's job is to surface candidates.
 *
 * Why L2 scenes (not trigram clustering)?
 *   The L2 pipeline already groups L1 memories into research topics. Reusing
 *   those groupings gives us topic-coherent threads for free, instead of
 *   trying to re-cluster by bag-of-words trigrams (which loses temporal and
 *   semantic structure).
 */
import { queryL1ThreadsForUser } from "../store";
import { sessionKeyForUser } from "../user-scope";
import type { MemoryRecord } from "../../tencentdb/record/l1-writer";

/** A chronologically ordered chain of L1 memories within one scene. */
export interface MemoryThread {
  sceneName: string;
  memories: MemoryRecord[];      // sorted ascending by createdAt
  firstAt: string;
  lastAt: string;
  spanMs: number;                // last − first, ms
}

/**
 * Build all candidate threads for a user. No filtering by "importance" —
 * just basic viability (≥2 memories with non-zero time gap, so there's
 * something to narrate).
 */
export function detectThreadsForUser(userId: string): MemoryThread[] {
  const prefix = sessionKeyForUser(userId);
  const grouped = queryL1ThreadsForUser(prefix);
  const threads: MemoryThread[] = [];
  for (const [sceneName, memories] of grouped) {
    // ≥2 memories is the only structural gate. Span can be 0 (all extracted
    // in one L1 batch) — the LLM judges from the content whether that's a
    // meaningful trajectory or just co-occurring facts.
    if (memories.length < 2) continue;
    const firstAt = memories[0].createdAt;
    const lastAt = memories[memories.length - 1].createdAt;
    const spanMs = Math.max(0, Date.parse(lastAt) - Date.parse(firstAt));
    threads.push({ sceneName, memories, firstAt, lastAt, spanMs });
  }
  return threads;
}

/**
 * Rank candidate threads. Length + span + recency-decay, no magic constants
 * that imply "this is the threshold of interestingness".
 *
 * The ranking exists purely to pick which candidate to feed to the LLM
 * first — the LLM still has the right to decide "this isn't worth
 * surfacing" and return null.
 */
export function rankThreads(threads: MemoryThread[]): MemoryThread[] {
  const now = Date.now();
  return [...threads].sort((a, b) => scoreThread(b, now) - scoreThread(a, now));
}

function scoreThread(t: MemoryThread, now: number): number {
  // length: more memories on the same topic = stronger thread signal
  // span:  longer time span = more "evolution" to narrate (log-dampened)
  // recency: newer = more relevant for the user right now (gentle decay)
  const lengthScore = Math.log1p(t.memories.length);
  const spanDays = t.spanMs / (1000 * 60 * 60 * 24);
  const spanScore = Math.log1p(spanDays);
  const daysSinceLast = (now - Date.parse(t.lastAt)) / (1000 * 60 * 60 * 24);
  const recencyScore = 1 / (1 + daysSinceLast / 30);  // half-life ~ a month
  return lengthScore * 2 + spanScore + recencyScore;
}

/**
 * Format a thread for an LLM prompt — one line per memory with [date] prefix
 * so the model can reason about temporal evolution explicitly.
 */
export function formatThreadForPrompt(thread: MemoryThread): string {
  const lines = thread.memories.map((m) => {
    const date = m.createdAt.slice(0, 10);
    return `[${date}] (${m.type}) ${m.content}`;
  });
  return `Scene: ${thread.sceneName}\n${lines.join("\n")}`;
}
