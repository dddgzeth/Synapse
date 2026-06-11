/**
 * PipelineManager (scheduler) — count-based + mutex-based throttling for
 * L0 → L1 → L2 → L3 memory pipeline. NO time-based logic (no idle timers,
 * no min-interval clocks — pure event-driven counts + in-memory mutex).
 *
 * Why:
 *   Without throttling, every chat turn / file event triggers a full L1+L2+L3
 *   run, causing 5-50 LLM calls per event and concurrent SQLite/file races.
 *   This manager batches: only after N turns (or explicit flush) does L1 fire;
 *   only after K new memories does L2 fire; L2 holds a per-session mutex so
 *   two L2 agentic loops never race on scene_blocks/*.md.
 *
 * Public API (all called from /api/chat onFinish or /api/pipeline/flush):
 *   - notifyTurn(sessionKey, sessionId): record one conversation turn.
 *     Fires L1 (and possibly L2/L3) only if the turn-count threshold is met.
 *   - forceFlush(sessionKey, sessionId): consume any pending buffered turns
 *     and fire L1/L2/L3 NOW regardless of count. Used for the "user resumes
 *     after a gap" recovery path.
 *
 * Persistence:
 *   - turn_count:<sessionKey>          (existing) — incremented on each turn
 *   - mems_since_l2:<sessionKey>       — new memories since last L2 run
 *   - l2_running / l2_dirty            — kept in-memory only (per-process,
 *                                        OK since Node serves all chat reqs
 *                                        from one process)
 */

import { getPipelineState, setPipelineState } from "./store";
import { runL1Pipeline, type L1RunResult } from "./l1-pipeline";
import { runL2L3Pipeline } from "./l2-l3-pipeline";
import { runAhaDetection } from "./aha";

const TAG = "[synapse][scheduler]";

// ─────────────────────────────────────
// Tunables (pure counts, no time)
// ─────────────────────────────────────

const TURNS_PER_L1 = 5;          // every 5 chat turns → 1 L1 batch
const NEW_MEMS_PER_L2 = 3;       // ≥ 3 new L1 memories since last L2 → trigger L2

// ─────────────────────────────────────
// In-memory mutex state (per session)
// ─────────────────────────────────────

const l2Running = new Set<string>();
const l2Dirty   = new Set<string>();

// ─────────────────────────────────────
// Persistent counters
// ─────────────────────────────────────

function getTurnCount(sk: string): number {
  return parseInt(getPipelineState(`turn_count:${sk}`) ?? "0", 10);
}
function setTurnCount(sk: string, n: number): void {
  setPipelineState(`turn_count:${sk}`, String(n));
}
function getMemsSinceL2(sk: string): number {
  return parseInt(getPipelineState(`mems_since_l2:${sk}`) ?? "0", 10);
}
function setMemsSinceL2(sk: string, n: number): void {
  setPipelineState(`mems_since_l2:${sk}`, String(n));
}

// ─────────────────────────────────────
// Public API
// ─────────────────────────────────────

export interface NotifyResult {
  triggeredL1: boolean;
  newMemories: number;
  triggeredL2: boolean;
}

/**
 * Call after a chat turn is fully committed to L0.
 * Increments turn count; fires L1 batch only when threshold met.
 * Async but safe to fire-and-forget (or await for tests).
 */
export async function notifyTurn(sessionKey: string, sessionId: string, userId: string): Promise<NotifyResult> {
  const next = getTurnCount(sessionKey) + 1;
  setTurnCount(sessionKey, next);
  if (next < TURNS_PER_L1) {
    return { triggeredL1: false, newMemories: 0, triggeredL2: false };
  }
  console.log(`${TAG} [${sessionKey}] turn threshold reached (${next}/${TURNS_PER_L1}) → firing L1`);
  return runL1AndMaybeL2(sessionKey, sessionId, userId);
}

/**
 * Bypass the turn-count threshold and run L1 right now if there's anything to
 * process. Used when the user returns to chat after a gap — the SynapseApp
 * mount calls this so any leftover turns get digested.
 */
export async function forceFlush(sessionKey: string, sessionId: string, userId: string): Promise<NotifyResult> {
  const pending = getTurnCount(sessionKey);
  if (pending === 0) {
    return { triggeredL1: false, newMemories: 0, triggeredL2: false };
  }
  console.log(`${TAG} [${sessionKey}] forceFlush with ${pending} pending turn(s) → firing L1`);
  return runL1AndMaybeL2(sessionKey, sessionId, userId);
}

// ─────────────────────────────────────
// Internals
// ─────────────────────────────────────

async function runL1AndMaybeL2(sessionKey: string, sessionId: string, userId: string): Promise<NotifyResult> {
  // Always reset the turn counter BEFORE awaiting L1 to prevent two concurrent
  // notifies from both crossing the threshold and double-firing.
  setTurnCount(sessionKey, 0);

  let l1Out: L1RunResult;
  try {
    l1Out = await runL1Pipeline(sessionKey, sessionId, userId);
  } catch (err) {
    console.error(`${TAG} [${sessionKey}] L1 pipeline threw:`, err);
    return { triggeredL1: true, newMemories: 0, triggeredL2: false };
  }

  const newCount = l1Out.newMemoryRecords.length;
  if (newCount === 0) {
    return { triggeredL1: true, newMemories: 0, triggeredL2: false };
  }

  const newSinceL2 = getMemsSinceL2(sessionKey) + newCount;
  setMemsSinceL2(sessionKey, newSinceL2);

  if (newSinceL2 < NEW_MEMS_PER_L2) {
    return { triggeredL1: true, newMemories: newCount, triggeredL2: false };
  }

  // Threshold met → queue L2 with mutex protection.
  const queued = maybeRunL2(sessionKey, userId, l1Out.newMemoryRecords);
  return { triggeredL1: true, newMemories: newCount, triggeredL2: queued };
}

/**
 * Fire L2 if no L2 is currently running for this session. If one IS running,
 * mark dirty so we re-fire once it finishes — protects scene_blocks/*.md from
 * concurrent writes by two L2 agentic loops on the same session.
 */
function maybeRunL2(sessionKey: string, userId: string, newMemories: Array<{ id: string; content: string; createdAt: string }>): boolean {
  if (l2Running.has(sessionKey)) {
    l2Dirty.add(sessionKey);
    console.log(`${TAG} [${sessionKey}] L2 already running → marked dirty`);
    return true;
  }
  l2Running.add(sessionKey);
  console.log(`${TAG} [${sessionKey}] L2 lock acquired → starting`);
  void runL2WithDirtyCheck(sessionKey, userId, newMemories);
  return true;
}

async function runL2WithDirtyCheck(
  sessionKey: string,
  userId: string,
  newMemories: Array<{ id: string; content: string; createdAt: string }>,
): Promise<void> {
  try {
    await runL2L3Pipeline({ userId, newMemories });
    setMemsSinceL2(sessionKey, 0);
    // Aha detection piggy-backs on L2 completion — exact same trigger model
    // as before (just no longer fired from inside L1).
    runAhaDetection(userId).catch((err) => console.error(`${TAG} aha detection failed:`, err));
  } catch (err) {
    console.error(`${TAG} [${sessionKey}] L2 pipeline threw:`, err);
  } finally {
    l2Running.delete(sessionKey);
    console.log(`${TAG} [${sessionKey}] L2 lock released`);

    // If anyone tried to fire L2 while we were busy, give it a chance now.
    if (l2Dirty.has(sessionKey)) {
      l2Dirty.delete(sessionKey);
      const accumulated = getMemsSinceL2(sessionKey);
      if (accumulated >= NEW_MEMS_PER_L2) {
        console.log(`${TAG} [${sessionKey}] re-firing L2 (dirty + ${accumulated} accumulated)`);
        maybeRunL2(sessionKey, userId, []);
      }
    }
  }
}
