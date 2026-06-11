/**
 * L2 + L3 pipeline orchestration — wires TencentDB's SceneExtractor and
 * PersonaGenerator into Synapse's L1 pipeline.
 *
 * Per-user: each signed-in user gets their own dataDir at
 *   ${TDAI_DATA_DIR}/users/<userId>/
 *     ├── scene_blocks/*.md
 *     ├── persona.md
 *     └── .metadata/  (checkpoints, scene index)
 *
 * Extractor / PersonaGenerator / PersonaTrigger / CheckpointManager instances
 * are cached per userId so we don't rebuild them on every call.
 */

import { SceneExtractor } from "../tencentdb/scene/scene-extractor";
import { PersonaTrigger } from "../tencentdb/persona/persona-trigger";
import { PersonaGenerator } from "../tencentdb/persona/persona-generator";
import { CleanContextRunner } from "../tencentdb/runtime/tool-runner";
import { CheckpointManager } from "../tencentdb/utils/checkpoint";
import { getUserDataDir } from "./user-scope";

const TAG = "[synapse][l2l3-pipeline]";

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

const _extractors = new Map<string, SceneExtractor>();
function getExtractor(userId: string): SceneExtractor {
  const cached = _extractors.get(userId);
  if (cached) return cached;
  const inst = new SceneExtractor({
    dataDir: getUserDataDir(userId),
    config: {},
    maxScenes: 15,
    sceneBackupCount: 5,
    timeoutMs: 300_000,
    logger: consoleLogger,
    llmRunner: getToolRunner(),
  });
  _extractors.set(userId, inst);
  return inst;
}

const _personaGens = new Map<string, PersonaGenerator>();
function getPersonaGenerator(userId: string): PersonaGenerator {
  const cached = _personaGens.get(userId);
  if (cached) return cached;
  const inst = new PersonaGenerator({
    dataDir: getUserDataDir(userId),
    config: {},
    backupCount: 3,
    logger: consoleLogger,
    llmRunner: getToolRunner(),
  });
  _personaGens.set(userId, inst);
  return inst;
}

const _personaTriggers = new Map<string, PersonaTrigger>();
function getPersonaTrigger(userId: string): PersonaTrigger {
  const cached = _personaTriggers.get(userId);
  if (cached) return cached;
  const inst = new PersonaTrigger({
    dataDir: getUserDataDir(userId),
    interval: 5,
    logger: consoleLogger,
  });
  _personaTriggers.set(userId, inst);
  return inst;
}

export interface L2L3Input {
  /** Owner of the memories — used to scope dataDir & checkpoint. */
  userId: string;
  /** L1 memories just upserted by the L1 pipeline. */
  newMemories: Array<{ id: string; content: string; createdAt: string }>;
}

/**
 * Run L2 scene extraction + L3 persona check/generation in sequence for
 * one user. Errors are logged but don't propagate (L1 results are already
 * committed).
 */
export async function runL2L3Pipeline(input: L2L3Input): Promise<void> {
  const { userId } = input;
  if (input.newMemories.length === 0) {
    console.log(`${TAG} [${userId}] skipped: no new memories`);
    return;
  }

  // ── L2: scene extraction ──
  const extractor = getExtractor(userId);
  const memoriesForL2 = input.newMemories.map((m) => ({
    id: m.id,
    content: m.content,
    created_at: m.createdAt,
  }));

  let l2Ok = false;
  try {
    const res = await extractor.extract(memoriesForL2);
    l2Ok = res.success;
    console.log(`${TAG} [${userId}] L2 done: processed=${res.memoriesProcessed} success=${res.success}${res.error ? ` error=${res.error}` : ""}`);
  } catch (err) {
    console.error(`${TAG} [${userId}] L2 threw:`, err);
  }

  // ── Bump L3 input counters ──
  const cpMgr = new CheckpointManager(getUserDataDir(userId), consoleLogger);
  try {
    if (l2Ok) {
      await cpMgr.incrementScenesProcessed();
    }
    await cpMgr.markL1ExtractionComplete("__synapse__", input.newMemories.length);
  } catch (err) {
    console.error(`${TAG} [${userId}] checkpoint update failed:`, err);
  }

  // ── L3: persona trigger evaluation + generation ──
  try {
    const trigger = getPersonaTrigger(userId);
    const verdict = await trigger.shouldGenerate();
    if (!verdict.should) {
      console.log(`${TAG} [${userId}] L3 not triggered`);
      return;
    }
    console.log(`${TAG} [${userId}] L3 triggered: ${verdict.reason}`);
    const gen = getPersonaGenerator(userId);
    const ok = await gen.generate(verdict.reason);
    console.log(`${TAG} [${userId}] L3 done: updated=${ok}`);
  } catch (err) {
    console.error(`${TAG} [${userId}] L3 threw:`, err);
  }
}
