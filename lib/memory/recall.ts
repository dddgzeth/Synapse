/**
 * Memory recall — retrieve relevant L1 memories + L3 persona + connection /
 * contradiction analysis before each chat turn.
 *
 * Pipeline:
 *   user message
 *     ├─ persona.md (always)
 *     ├─ FTS-recalled L1 memories (lexical match, user-scoped)
 *     └─ context-analyzer: classifies FTS hits into connection / contradiction
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
import { searchL1FtsForUser } from "./store";
import { getUserPersonaPath, sessionKeyForUser } from "./user-scope";
import { analyzeRecallContext, formatLinksForPrompt, type MemoryLink } from "./insights/context-analyzer";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

const TOP_K = 8;

export interface RecallResult {
  memories: MemoryRecord[];
  persona: string | null;
  links: MemoryLink[];
  contextText: string; // formatted for LLM system prompt injection
}

export async function recallForQuery(userText: string, userId: string): Promise<RecallResult> {
  const userPrefix = sessionKeyForUser(userId);

  // L1 memory is user-global: search across ALL of this user's sessions.
  const memories = searchL1FtsForUser(userText, userPrefix, TOP_K);

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
    const memLines = memories
      .sort((a, b) => b.priority - a.priority)
      .map((m) => `[${m.type}] ${m.content}`)
      .join("\n");
    parts.push(`<relevant-research-memories>\n${memLines}\n</relevant-research-memories>`);
  }

  const linksBlock = formatLinksForPrompt(links);
  if (linksBlock) parts.push(linksBlock);

  return parts.join("\n\n");
}
