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
import crypto from "node:crypto";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  queryAllL1,
  getPipelineState,
  setPipelineState,
  appendAhaHistory,
  listAhaHistory,
  getAhaById,
} from "./store";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

export interface ExternalSource {
  title: string;
  abstract: string;
  source: "semantic_scholar" | "arxiv";
  url?: string;
  year?: number;
}

export interface AhaPending {
  id: string;
  pattern: string;
  observation: string;
  hypothesis: string;
  reframe: string;
  supportingMemoryIds: string[];
  externalSources: ExternalSource[];
  detectedAt: string;
}

export interface AhaHistoryEntry {
  id: string;
  detectedAt: string;
  pattern: string;
  observation: string;
}

export function getAhaHistoryList(limit = 30): AhaHistoryEntry[] {
  return listAhaHistory(limit).map((row) => {
    try {
      const p = JSON.parse(row.payload_json) as AhaPending;
      return {
        id: row.id,
        detectedAt: row.detected_at,
        pattern: p.pattern ?? "",
        observation: p.observation ?? "",
      };
    } catch {
      return { id: row.id, detectedAt: row.detected_at, pattern: "", observation: "" };
    }
  });
}

export function getAhaFromHistory(id: string): AhaPending | null {
  const row = getAhaById(id);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as AhaPending;
  } catch {
    return null;
  }
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

// Was the most recent Aha already shown to the user (sidebar click or chat
// inject)? Returns true when there's nothing new to surface.
export function isAhaLastSeen(): boolean {
  const aha = getAhaLast();
  if (!aha) return true;
  const seenAt = getPipelineState("aha_last_seen_at") ?? "";
  return seenAt >= aha.detectedAt;
}

// Mark the current latest Aha as seen so the sidebar badge clears.
export function markAhaLastSeen(): void {
  const aha = getAhaLast();
  if (!aha) return;
  setPipelineState("aha_last_seen_at", aha.detectedAt);
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
  const serialized = JSON.stringify(aha);
  setPipelineState("aha_last", serialized);
  appendAhaHistory(aha.id, aha.detectedAt, serialized);
  if (!getPipelineState("aha_pending")) {
    setPipelineState("aha_pending", serialized);
  }
  return aha;
}

// Legacy bag-of-words check kept as a fallback when the LLM judge fails.
// Sync, no network, conservative threshold.
export function shouldFireAhaFallback(userText: string, aha: AhaPending): boolean {
  const patternWords = aha.pattern.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const queryLower = userText.toLowerCase();
  const matchCount = patternWords.filter((w) => queryLower.includes(w)).length;
  return matchCount >= Math.min(2, patternWords.length);
}

/**
 * LLM-based relevance judge — replaces the brittle bag-of-words `shouldFireAha`.
 * Decides whether to inline-inject the pending Aha into this chat turn based on
 * semantic relatedness between the user's query and the pending insight.
 *
 * Sidebar badge is the safety net: if this returns false, the Aha is still
 * reachable via the badge until the user clicks it. So we err on the side of
 * NOT injecting (avoid surprising the user with irrelevant cards).
 *
 * Budget: ~1s extra per chat when aha_pending exists. ~0 otherwise (early return).
 */
export async function shouldFireAhaLLM(userText: string, aha: AhaPending): Promise<boolean> {
  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  try {
    const result = await generateText({
      model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      system: `你是相关性判官。判断【用户当前问题】是否与【待推送的洞察】话题相关。
只回答一个字：YES 或 NO。

YES 的标准：用户问的话题和洞察涉及同一研究方向/概念/工具。
NO 的标准：完全不相关、纯闲聊、问跟洞察无关的事。

宁严不松——宁可漏推不要错推。`,
      prompt: `【用户问题】${userText}

【待推送洞察的内容】
pattern: ${aha.pattern}
observation: ${aha.observation.slice(0, 200)}

YES 或 NO?`,
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(8_000),
    });
    const verdict = result.text.trim().toUpperCase();
    return verdict.startsWith("Y");
  } catch (err) {
    console.warn("[aha] LLM judge failed, falling back to bag-of-words:", err);
    return shouldFireAhaFallback(userText, aha);
  }
}

// Backward-compat alias kept for the old sync call sites — async-only now.
export const shouldFireAha = shouldFireAhaLLM;

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
      appendAhaHistory(aha.id, aha.detectedAt, serialized);
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

  let parsed: Omit<AhaPending, "id" | "supportingMemoryIds" | "externalSources" | "detectedAt">;
  try {
    const cleaned = result.text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  // Best-effort: enrich with 1-2 external papers via Semantic Scholar / arXiv.
  // miromind itself is overkill here (it's for full deep-research with tool
  // loops); we directly hit the same source APIs and let Claude do its synthesis.
  // Failure is non-fatal — Aha still ships with empty externalSources.
  const externalSources = await fetchExternalSourcesForAha(parsed.pattern, parsed.observation)
    .catch((err) => {
      console.warn("[aha] external source fetch failed:", err);
      return [] as ExternalSource[];
    });

  return {
    id: `aha_${crypto.randomBytes(5).toString("hex")}`,
    ...parsed,
    supportingMemoryIds: memories.map((m) => m.id),
    externalSources,
    detectedAt: new Date().toISOString(),
  };
}

async function fetchExternalSourcesForAha(
  pattern: string,
  observation: string,
): Promise<ExternalSource[]> {
  // The pattern/observation are typically Chinese narrative; Semantic Scholar
  // and arXiv are keyword-based English search engines. Ask Claude to distill
  // a short English keyword query first.
  const query = await extractEnglishKeywordQuery(pattern, observation);
  if (!query || query.length < 4) return [];

  const { searchSemanticScholar, searchArxiv } = await import("@/lib/search/external");
  const [scholar, arxiv] = await Promise.allSettled([
    searchSemanticScholar(query, 1),
    searchArxiv(query, 1),
  ]);
  const out: ExternalSource[] = [];
  if (scholar.status === "fulfilled") {
    for (const r of scholar.value) {
      if (!r.title) continue;
      out.push({
        title: r.title, abstract: r.abstract ?? "",
        source: "semantic_scholar", url: r.url, year: r.year,
      });
    }
  }
  if (arxiv.status === "fulfilled") {
    for (const r of arxiv.value) {
      if (!r.title) continue;
      out.push({
        title: r.title, abstract: r.abstract ?? "",
        source: "arxiv", url: r.url, year: r.year,
      });
    }
  }
  return out.slice(0, 2);
}

async function extractEnglishKeywordQuery(pattern: string, observation: string): Promise<string> {
  const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
  const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
  const provider = createOpenAI({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  try {
    const result = await generateText({
      model: provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      system: `You distill a research-pattern description into a short English keyword query
suitable for Semantic Scholar / arXiv. Output 3-6 English keywords separated by
spaces. No commas, no quotes, no full sentences, no explanation. Only the query.`,
      prompt: `Pattern: ${pattern}\n\nObservation: ${observation.slice(0, 300)}\n\nKeyword query:`,
      maxOutputTokens: 40,
      abortSignal: AbortSignal.timeout(8_000),
    });
    return result.text.replace(/["'\n]/g, " ").trim().slice(0, 120);
  } catch (err) {
    console.warn("[aha] keyword extraction failed:", err);
    return "";
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
