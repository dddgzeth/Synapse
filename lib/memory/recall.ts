/**
 * Memory recall — retrieve relevant L1 memories + L3 persona before each chat turn.
 * Adapted from TencentDB auto-recall.ts.
 */

import path from "node:path";
import fs from "node:fs";
import { searchL1Fts } from "./store";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

const TOP_K = 8;

// ============================
// Recall result
// ============================

export interface RecallResult {
  memories: MemoryRecord[];
  persona: string | null;
  contextText: string; // formatted for LLM system prompt injection
}

// ============================
// Main recall function
// ============================

export function recallForQuery(userText: string): RecallResult {
  const memories = searchL1Fts(userText, TOP_K);

  const dataDir = process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
  const personaPath = path.join(dataDir, "persona.md");
  let persona: string | null = null;
  try {
    if (fs.existsSync(personaPath)) {
      persona = fs.readFileSync(personaPath, "utf-8").trim() || null;
    }
  } catch {
    // persona not yet generated
  }

  const contextText = formatRecallContext(memories, persona);
  return { memories, persona, contextText };
}

// ============================
// Format for system prompt
// ============================

function formatRecallContext(memories: MemoryRecord[], persona: string | null): string {
  const parts: string[] = [];

  if (persona) {
    parts.push(`<researcher-profile>\n${persona}\n</researcher-profile>`);
  }

  if (memories.length > 0) {
    const memLines = memories
      .sort((a, b) => b.priority - a.priority)
      .map((m) => `[${m.type}] ${m.content}`)
      .join("\n");
    parts.push(`<relevant-research-memories>\n${memLines}\n</relevant-research-memories>`);
  }

  return parts.join("\n\n");
}
