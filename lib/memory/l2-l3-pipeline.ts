/**
 * L2 + L3 pipeline orchestration — wires TencentDB's SceneExtractor and
 * PersonaGenerator into Synapse's L1 pipeline.
 *
 * Flow (called after L1 writes new memories):
 *   1. runL2(newMemories)                — SceneExtractor agentically writes
 *                                          to data/scene_blocks/*.md
 *   2. checkL3Trigger() → shouldGenerate — PersonaTrigger evaluates 5 priority
 *                                          rules against the checkpoint
 *   3. if yes: runL3(reason)             — PersonaGenerator agentically updates
 *                                          data/persona.md
 *
 * Both extractors use the same CleanContextRunner singleton (tool-enabled,
 * sandboxed to the scene_blocks / data directory respectively).
 */

import path from "node:path";
import { SceneExtractor } from "../tencentdb/scene/scene-extractor";
import { PersonaTrigger } from "../tencentdb/persona/persona-trigger";
import { PersonaGenerator } from "../tencentdb/persona/persona-generator";
import { CleanContextRunner } from "../tencentdb/runtime/tool-runner";
import { CheckpointManager } from "../tencentdb/utils/checkpoint";

const TAG = "[synapse][l2l3-pipeline]";

function getDataDir(): string {
  return process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
}

const consoleLogger = {
  debug: (m: string) => console.log(m),
  info:  (m: string) => console.log(m),
  warn:  (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

let _runner: CleanContextRunner | null = null;
function getToolRunner(): CleanContextRunner {
  if (!_runner) {
    _runner = new CleanContextRunner({ enableTools: true, logger: consoleLogger, maxSteps: 25 });
  }
  return _runner;
}

let _extractor: SceneExtractor | null = null;
function getExtractor(): SceneExtractor {
  if (!_extractor) {
    _extractor = new SceneExtractor({
      dataDir: getDataDir(),
      config: {},
      maxScenes: 15,
      sceneBackupCount: 5,
      timeoutMs: 300_000,
      logger: consoleLogger,
      llmRunner: getToolRunner(),
    });
  }
  return _extractor;
}

let _personaGen: PersonaGenerator | null = null;
function getPersonaGenerator(): PersonaGenerator {
  if (!_personaGen) {
    _personaGen = new PersonaGenerator({
      dataDir: getDataDir(),
      config: {},
      backupCount: 3,
      logger: consoleLogger,
      llmRunner: getToolRunner(),
    });
  }
  return _personaGen;
}

let _personaTrigger: PersonaTrigger | null = null;
function getPersonaTrigger(): PersonaTrigger {
  if (!_personaTrigger) {
    _personaTrigger = new PersonaTrigger({
      dataDir: getDataDir(),
      interval: 5,    // generate persona every 5 new memories since last persona
      logger: consoleLogger,
    });
  }
  return _personaTrigger;
}

export interface L2L3Input {
  /** L1 memories just upserted by the L1 pipeline. */
  newMemories: Array<{ id: string; content: string; createdAt: string }>;
}

/**
 * Run L2 scene extraction + L3 persona check/generation in sequence.
 *
 * Designed to be called after L1 pipeline completes. Safe to fail —
 * errors are logged but don't propagate (L1 results are already committed).
 */
export async function runL2L3Pipeline(input: L2L3Input): Promise<void> {
  if (input.newMemories.length === 0) {
    console.log(`${TAG} skipped: no new memories`);
    return;
  }

  // ── L2: scene extraction ──
  const extractor = getExtractor();
  const memoriesForL2 = input.newMemories.map((m) => ({
    id: m.id,
    content: m.content,
    created_at: m.createdAt,
  }));

  let l2Ok = false;
  try {
    const res = await extractor.extract(memoriesForL2);
    l2Ok = res.success;
    console.log(`${TAG} L2 done: processed=${res.memoriesProcessed} success=${res.success}${res.error ? ` error=${res.error}` : ""}`);
  } catch (err) {
    console.error(`${TAG} L2 threw:`, err);
  }

  // ── Bump L3 input counters ──
  const dataDir = getDataDir();
  const cpMgr = new CheckpointManager(dataDir, consoleLogger);
  try {
    if (l2Ok) {
      // Increment scenes_processed counter (used by PersonaTrigger P3 condition)
      await cpMgr.incrementScenesProcessed();
    }
    // Bump memories_since_last_persona (used by PersonaTrigger P4 threshold)
    // Use markL1ExtractionComplete to advance the counter.
    await cpMgr.markL1ExtractionComplete("__synapse__", input.newMemories.length);
  } catch (err) {
    console.error(`${TAG} checkpoint update failed:`, err);
  }

  // ── L3: persona trigger evaluation + generation ──
  try {
    const trigger = getPersonaTrigger();
    const verdict = await trigger.shouldGenerate();
    if (!verdict.should) {
      console.log(`${TAG} L3 not triggered`);
      return;
    }
    console.log(`${TAG} L3 triggered: ${verdict.reason}`);
    const gen = getPersonaGenerator();
    const ok = await gen.generate(verdict.reason);
    console.log(`${TAG} L3 done: updated=${ok}`);
  } catch (err) {
    console.error(`${TAG} L3 threw:`, err);
  }
}
