/**
 * L1 Memory Extraction Pipeline.
 *
 * Triggers after every N conversation turns (default: 5).
 * Calls Claude with TencentDB-style prompts → parses JSON → writes to SQLite.
 * Adapted from TencentDB l1-extractor.ts.
 */

import crypto from "node:crypto";
import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  formatExtractionPrompt,
  type ConversationMessage,
} from "../tencentdb/prompts/l1-extraction";
import {
  CONFLICT_DETECTION_SYSTEM_PROMPT,
  formatBatchConflictPrompt,
  type CandidateMatch,
} from "../tencentdb/prompts/l1-dedup";
import {
  generateMemoryId,
  type ExtractedMemory,
  type DedupDecision,
  type MemoryRecord,
} from "../tencentdb/record/l1-writer";
import { getLLMRunner } from "../tencentdb/adapters/standalone/llm-runner";
import {
  queryL0ForSession,
  searchL1Fts,
  upsertL1,
  deleteL1Batch,
  getPipelineState,
  setPipelineState,
  queryAllL1,
} from "./store";

const TAG = "[synapse][l1-pipeline]";
const TRIGGER_EVERY_N = 5; // L1 trigger: every 5 conversation turns
const BG_MESSAGES = 5;     // background context messages
const NEW_MESSAGES = 10;   // max new messages per L1 run

// ============================
// Turn counter
// ============================

export function incrementTurnCount(sessionKey: string): number {
  const key = `turn_count:${sessionKey}`;
  const current = parseInt(getPipelineState(key) ?? "0", 10);
  const next = current + 1;
  setPipelineState(key, String(next));
  return next;
}

export function shouldTriggerL1(sessionKey: string): boolean {
  const key = `turn_count:${sessionKey}`;
  const count = parseInt(getPipelineState(key) ?? "0", 10);
  return count > 0 && count % TRIGGER_EVERY_N === 0;
}

// ============================
// Main L1 pipeline
// ============================

export interface L1RunResult {
  newMemoryRecords: MemoryRecord[];
}

export async function runL1Pipeline(sessionKey: string, sessionId: string): Promise<L1RunResult> {
  const runner = getLLMRunner();
  const l0Messages = queryL0ForSession(sessionKey, 50);
  if (l0Messages.length === 0) return { newMemoryRecords: [] };

  // Split background vs new messages
  const bgMessages: ConversationMessage[] = l0Messages
    .slice(0, -NEW_MESSAGES)
    .slice(-BG_MESSAGES)
    .map((m) => ({
      id: m.record_id,
      role: m.role as "user" | "assistant",
      content: m.message_text,
      timestamp: m.timestamp,
    }));

  const newMessages: ConversationMessage[] = l0Messages
    .slice(-NEW_MESSAGES)
    .map((m) => ({
      id: m.record_id,
      role: m.role as "user" | "assistant",
      content: m.message_text,
      timestamp: m.timestamp,
    }));

  if (newMessages.length === 0) return { newMemoryRecords: [] };

  const previousSceneName = getPipelineState(`last_scene:${sessionKey}`) ?? undefined;

  // Step 1: Extract memories
  let rawText: string;
  try {
    rawText = await runner.run({
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      prompt: formatExtractionPrompt({ newMessages, backgroundMessages: bgMessages, previousSceneName }),
      maxTokens: 4096,
    });
  } catch (err) {
    console.error(`${TAG} L1 extraction LLM failed:`, err);
    return { newMemoryRecords: [] };
  }

  const extracted = parseExtractionResponse(rawText);
  if (extracted.length === 0) return { newMemoryRecords: [] };

  // Update last scene name
  const lastScene = extracted[extracted.length - 1].scene_name;
  if (lastScene) setPipelineState(`last_scene:${sessionKey}`, lastScene);

  const allExtracted: Array<ExtractedMemory & { record_id: string }> = extracted.map((m) => ({
    ...m,
    record_id: generateMemoryId(),
  }));

  if (allExtracted.length === 0) return { newMemoryRecords: [] };

  // Step 2: Dedup — find candidates for each new memory
  const existingTexts = queryAllL1(200).map((r) => r.content).join(" ");
  const matches: CandidateMatch[] = await Promise.all(
    allExtracted.map(async (em) => {
      const candidates = searchL1Fts(em.content, 5);
      return { newMemory: em, candidates };
    }),
  );

  const hasAnyCandidate = matches.some((m) => m.candidates.length > 0);
  let decisions: DedupDecision[];

  if (!hasAnyCandidate) {
    // No existing memories → all store
    decisions = allExtracted.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  } else {
    // Call dedup LLM
    try {
      const dedupRaw = await runner.run({
        systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
        prompt: formatBatchConflictPrompt(matches),
        maxTokens: 2048,
      });
      decisions = parseDedupResponse(dedupRaw, allExtracted);
    } catch (err) {
      console.error(`${TAG} Dedup LLM failed, defaulting to store:`, err);
      decisions = allExtracted.map((m) => ({
        record_id: m.record_id,
        action: "store" as const,
        target_ids: [],
      }));
    }
  }

  // Step 3: Apply decisions
  const now = new Date().toISOString();
  const writtenRecords: MemoryRecord[] = [];
  for (const decision of decisions) {
    if (decision.action === "skip") continue;

    const extracted = allExtracted.find((m) => m.record_id === decision.record_id);
    if (!extracted) continue;

    // Remove replaced records
    if (decision.target_ids.length > 0) {
      deleteL1Batch(decision.target_ids);
    }

    const record: MemoryRecord = {
      id: decision.record_id,
      content: decision.merged_content ?? extracted.content,
      type: (decision.merged_type ?? extracted.type) as MemoryRecord["type"],
      priority: decision.merged_priority ?? extracted.priority,
      scene_name: extracted.scene_name,
      source_message_ids: extracted.source_message_ids,
      metadata: extracted.metadata,
      timestamps: decision.merged_timestamps ?? [now],
      createdAt: now,
      updatedAt: now,
      sessionKey,
      sessionId,
    };

    upsertL1(record);
    writtenRecords.push(record);
  }

  console.log(`${TAG} L1 pipeline done: ${writtenRecords.length} memories written`);

  // L2/L3 triggering is now owned by the scheduler (lib/memory/scheduler.ts).
  // L1 just returns what it wrote.
  return { newMemoryRecords: writtenRecords };
}

// ============================
// Parsers
// ============================

interface ExtractionScene {
  scene_name: string;
  message_ids: string[];
  memories: Array<ExtractedMemory>;
}

function parseExtractionResponse(raw: string): Array<ExtractedMemory & { scene_name: string }> {
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const scenes: ExtractionScene[] = JSON.parse(cleaned);
    const result: Array<ExtractedMemory & { scene_name: string }> = [];
    for (const scene of scenes) {
      for (const mem of scene.memories ?? []) {
        result.push({
          content: mem.content,
          type: mem.type,
          priority: mem.priority,
          source_message_ids: mem.source_message_ids ?? [],
          metadata: mem.metadata ?? {},
          scene_name: scene.scene_name,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

function parseDedupResponse(
  raw: string,
  fallback: Array<ExtractedMemory & { record_id: string }>,
): DedupDecision[] {
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const arr: DedupDecision[] = JSON.parse(cleaned);
    return arr;
  } catch {
    return fallback.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}
