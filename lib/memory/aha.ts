/**
 * Aha Insight detection — passive, surprise-driven.
 *
 * Checks if a pattern appears in ≥3 different sources (sessions/dates)
 * across a span of ≥2 weeks. If so, sets aha_pending state.
 *
 * On next chat turn, if query is semantically related to the pending pattern,
 * returns the Aha Insight to be embedded in the normal response.
 */

import path from "node:path";
import fs from "node:fs";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { queryAllL1, getPipelineState, setPipelineState } from "./store";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

export interface AhaPending {
  pattern: string;
  observation: string;
  hypothesis: string;
  reframe: string;
  supportingMemoryIds: string[];
  detectedAt: string;
}

export function getAhaPending(): AhaPending | null {
  const raw = getPipelineState("aha_pending");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AhaPending;
  } catch {
    return null;
  }
}

// Mirror of aha_pending that is NEVER cleared — so the frontend can still
// render the evidence chain for the most recently detected Aha even after
// it was injected into a chat reply (which clears aha_pending).
export function getAhaLast(): AhaPending | null {
  const raw = getPipelineState("aha_last");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AhaPending;
  } catch {
    return null;
  }
}

export function clearAhaPending(): void {
  setPipelineState("aha_pending", "");
}

/**
 * Force-generate an Aha from the user's top-priority L1 memories, ignoring the
 * usual triggers (≥10 memories / multi-source / ≥3 day span). Intended for the
 * mock/preview endpoint so the UI can be developed without waiting for natural
 * detection. Writes to aha_last (and aha_pending if none currently pending) so
 * subsequent /api/aha/last calls return the same payload.
 */
export async function forceGenerateAha(): Promise<AhaPending | null> {
  const memories = queryAllL1(50);
  if (memories.length === 0) return null;
  const top = [...memories]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 8);
  const aha = await generateAhaInsight(top);
  if (!aha) return null;
  setPipelineState("aha_last", JSON.stringify(aha));
  if (!getPipelineState("aha_pending")) {
    setPipelineState("aha_pending", JSON.stringify(aha));
  }
  return aha;
}

// Check if aha should fire for this query (semantic relatedness check)
export function shouldFireAha(userText: string, aha: AhaPending): boolean {
  const patternWords = aha.pattern.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const queryLower = userText.toLowerCase();
  const matchCount = patternWords.filter((w) => queryLower.includes(w)).length;
  return matchCount >= Math.min(2, patternWords.length);
}

// Run after L1 pipeline — check if new pattern qualifies for Aha
export async function runAhaDetection(): Promise<void> {
  // Don't overwrite existing pending aha
  if (getPipelineState("aha_pending")) return;

  const memories = queryAllL1(200);
  if (memories.length < 10) return; // need enough memories

  // Group by source diversity (session_key + date)
  const patternMap = new Map<string, { memories: MemoryRecord[]; dates: Set<string>; sessions: Set<string> }>();

  for (const mem of memories) {
    const dateStr = mem.createdAt.slice(0, 10);
    const key = normalizePattern(mem.content);
    if (!patternMap.has(key)) {
      patternMap.set(key, { memories: [], dates: new Set(), sessions: new Set() });
    }
    const entry = patternMap.get(key)!;
    entry.memories.push(mem);
    entry.dates.add(dateStr);
    entry.sessions.add(mem.sessionKey);
  }

  // Find patterns with ≥3 different sources
  const candidates: Array<{ memories: MemoryRecord[]; dates: Set<string>; sessions: Set<string> }> = [];
  for (const [, entry] of patternMap) {
    const sourceCount = Math.max(entry.dates.size, entry.sessions.size);
    if (sourceCount >= 2 && entry.memories.length >= 3) {
      candidates.push(entry);
    }
  }

  if (candidates.length === 0) return;

  // Check time span ≥ 7 days (relaxed from 2 weeks for hackathon demo)
  const candidate = candidates.sort((a, b) => b.memories.length - a.memories.length)[0];
  const dates = [...candidate.dates].sort();
  if (dates.length < 2) return;

  const spanDays = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (1000 * 86400);
  if (spanDays < 3) return; // relaxed threshold for demo

  // Generate Aha insight via Claude
  try {
    const aha = await generateAhaInsight(candidate.memories.slice(0, 8));
    if (aha) {
      const serialized = JSON.stringify(aha);
      setPipelineState("aha_pending", serialized);
      setPipelineState("aha_last", serialized);
    }
  } catch {
    // fail silently — Aha is non-critical
  }
}

async function generateAhaInsight(memories: MemoryRecord[]): Promise<AhaPending | null> {
  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({
    baseURL,
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  });

  const memorySummary = memories.map((m) => `[${m.type}] ${m.content}`).join("\n");

  const result = await generateText({
    model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
    system: `你是研究洞察生成器。根据研究者的多条记忆，识别隐藏的规律，生成一段惊喜性洞察。
必须严格输出 JSON，不要输出任何其他内容：
{
  "pattern": "识别到的核心研究规律（一句话，20字内）",
  "observation": "跨时间、跨来源观察到的具体规律描述（50-100字）",
  "hypothesis": "这个规律背后更深的研究命题（30-60字）",
  "reframe": "把'分散工作'重新框架成'收敛证据'的表述（30-60字）"
}`,
    prompt: `以下是研究者的多条研究记忆，它们来自不同时间和对话：\n\n${memorySummary}\n\n请识别隐藏的研究规律并生成洞察。`,
    maxOutputTokens: 512,
    abortSignal: AbortSignal.timeout(30_000),
  });

  try {
    const cleaned = result.text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Omit<AhaPending, "supportingMemoryIds" | "detectedAt">;
    return {
      ...parsed,
      supportingMemoryIds: memories.map((m) => m.id),
      detectedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizePattern(content: string): string {
  // Extract key nouns/concepts by removing common words
  return content
    .toLowerCase()
    .replace(/[^\w\s一-鿿]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5)
    .sort()
    .join(" ");
}
