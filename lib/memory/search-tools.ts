/**
 * tdai_conversation_search + tdai_memory_search — chat tools.
 *
 * Ported from `_archive/tencentdb-memory/src/core/tools/{conversation-search,memory-search}.ts`.
 *
 * The original supports hybrid (FTS5 + vector embedding via RRF). Synapse only has
 * FTS5 — the fucheers.top proxy doesn't expose embeddings — so this is the FTS-only
 * subset of the original: same tool names, same parameter shapes, same response
 * formatters. When/if embeddings are added later, the merge logic from the original
 * can be dropped back in unchanged.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  searchL0FtsForUser,
  searchL1FtsForUser,
  type L0Message,
} from "./store";
import { sessionKeyForUser } from "./user-scope";
import { searchL0HybridForUser, searchL1HybridForUser } from "./hybrid";
import { generateText } from "ai";
import { getLLMProvider } from "@/lib/llm/provider";
import { attachmentToDataUrl } from "../attachments";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

const TAG_CONV = "[synapse][tdai_conversation_search]";
const TAG_MEM  = "[synapse][tdai_memory_search]";

// ============================
// Conversation search (L0)
// ============================

export interface ConversationSearchResultItem {
  id: string;
  session_key: string;
  role: string;
  content: string;
  score: number;
  recorded_at: string;
}

export interface ConversationSearchResult {
  results: ConversationSearchResultItem[];
  total: number;
  strategy: string;
  message?: string;
}

export async function executeConversationSearch(params: {
  query: string;
  limit: number;
  userId: string;
  sessionKey?: string;
}): Promise<ConversationSearchResult> {
  const { query, limit, userId, sessionKey: sessionFilter } = params;
  if (!query || query.trim().length === 0) {
    return { results: [], total: 0, strategy: "none" };
  }
  // Hard scope: ONLY this user's sessions (default + children). Even if the
  // LLM tries to pass a sessionFilter belonging to someone else, we never
  // search outside the user's prefix.
  const userPrefix = sessionKeyForUser(userId);
  const candidateK = sessionFilter ? limit * 4 : limit * 2;
  let rows: L0Message[] = [];
  try {
    rows = await searchL0HybridForUser(query, userPrefix, candidateK);
  } catch (err) {
    console.warn(`${TAG_CONV} FTS failed:`, err);
    return { results: [], total: 0, strategy: "none" };
  }

  if (rows.length === 0) {
    return { results: [], total: 0, strategy: "fts" };
  }

  let items: ConversationSearchResultItem[] = rows.map((r, idx) => ({
    id: r.record_id,
    session_key: r.session_key,
    role: r.role,
    content: r.message_text,
    // Synthetic rank-based score (FTS5 returns rows ordered by bm25 rank).
    score: 1 / (1 + idx),
    recorded_at: r.recorded_at,
  }));

  if (sessionFilter) {
    // Honor the LLM-requested filter only if it's within this user's prefix.
    if (sessionFilter === userPrefix || sessionFilter.startsWith(`${userPrefix}_`)) {
      items = items.filter((i) => i.session_key === sessionFilter);
    }
  }

  const trimmed = items.slice(0, limit);
  return { results: trimmed, total: trimmed.length, strategy: "fts" };
}

export function formatConversationSearchResponse(result: ConversationSearchResult): string {
  if (result.message) return result.message;
  if (result.results.length === 0) return "No matching conversation messages found.";

  const lines: string[] = [`Found ${result.total} matching message(s):`, ""];
  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const dateStr = item.recorded_at ? ` [${item.recorded_at}]` : "";
    lines.push(`---`);
    lines.push(`**[${item.role}]** Session: ${item.session_key}${dateStr}${scoreStr}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ============================
// Memory search (L1)
// ============================

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  total: number;
  strategy: string;
  message?: string;
}

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  userId: string;
  type?: string;
  scene?: string;
}): Promise<MemorySearchResult> {
  const { query, limit, userId, type: typeFilter, scene: sceneFilter } = params;
  if (!query || query.trim().length === 0) {
    return { results: [], total: 0, strategy: "none" };
  }
  // Hard scope to this user (ALL of their sessions — L1 is user-global).
  // L1 records are tagged with session_key at write time, so the prefix
  // filter prevents cross-user leaks while still spanning the user's chats.
  const userPrefix = sessionKeyForUser(userId);
  const candidateK = (typeFilter || sceneFilter) ? limit * 4 : limit * 2;
  let rows: MemoryRecord[] = [];
  try {
    rows = await searchL1HybridForUser(query, userPrefix, candidateK);
  } catch (err) {
    console.warn(`${TAG_MEM} FTS failed:`, err);
    return { results: [], total: 0, strategy: "none" };
  }
  if (rows.length === 0) return { results: [], total: 0, strategy: "fts" };

  let items: MemorySearchResultItem[] = rows.map((r, idx) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    score: 1 / (1 + idx),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));

  if (typeFilter) {
    items = items.filter((i) => i.type === typeFilter);
  }
  if (sceneFilter) {
    const needle = sceneFilter.toLowerCase();
    items = items.filter((i) => i.scene_name.toLowerCase().includes(needle));
  }

  const trimmed = items.slice(0, limit);
  return { results: trimmed, total: trimmed.length, strategy: "fts" };
}

export function formatSearchResponse(result: MemorySearchResult): string {
  if (result.message) return result.message;
  if (result.results.length === 0) return "No matching memories found.";

  const lines: string[] = [`Found ${result.total} matching memories:`, ""];
  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const sceneStr = item.scene_name ? ` [scene: ${item.scene_name}]` : "";
    const priorityStr = item.priority >= 0 ? ` (priority: ${item.priority})` : " (global instruction)";
    lines.push(`- **[${item.type}]**${priorityStr}${sceneStr}${scoreStr}`);
    lines.push(`  ${item.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ============================
// Web search + URL fetch
// ============================

export async function executeWebSearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return "search_the_web unavailable: TAVILY_API_KEY not configured.";
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        max_results: 8,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.status === 429) {
      // Rate limited — wait 2s and retry once
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 6, include_answer: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!retry.ok) return `Search rate-limited. Try rephrasing or wait a moment.`;
      const data2 = await retry.json();
      return formatTavilyResult(data2);
    }
    if (!resp.ok) return `Search failed: HTTP ${resp.status}`;
    const data = await resp.json();
    return formatTavilyResult(data);
  } catch (err: any) {
    return `Search error: ${err?.message ?? String(err)}`;
  }
}

function formatTavilyResult(data: any): string {
  const lines: string[] = [];
  if (data.answer) lines.push(`**Summary:** ${data.answer}\n`);
  for (const r of (data.results ?? []) as Array<{ title: string; url: string; content: string }>) {
    lines.push(`**${r.title}**\n${r.url}\n${r.content?.slice(0, 400) ?? ""}`);
  }
  return lines.length > 0 ? lines.join("\n\n") : "No results found. Try a broader or different query.";
}

export async function executeSemanticScholarSearch(query: string): Promise<string> {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,authors,year,externalIds,openAccessPdf,tldr,publicationVenue&limit=5`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Synapse/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return `Semantic Scholar search failed: HTTP ${resp.status}`;
    const data = await resp.json();
    const papers = data.data ?? [];
    if (papers.length === 0) return "No papers found on Semantic Scholar.";
    return papers.map((p: any) => {
      const authors = (p.authors ?? []).slice(0, 3).map((a: any) => a.name).join(", ");
      const doi = p.externalIds?.DOI ? `DOI: ${p.externalIds.DOI}` : "";
      const pdf = p.openAccessPdf?.url ? `PDF: ${p.openAccessPdf.url}` : "";
      const tldr = p.tldr?.text ? `\nTL;DR: ${p.tldr.text}` : "";
      return `**${p.title}** (${p.year ?? "?"})\n${authors}\n${doi}${doi && pdf ? " | " : ""}${pdf}${tldr}`;
    }).join("\n\n");
  } catch (err: any) {
    return `Semantic Scholar error: ${err?.message ?? String(err)}`;
  }
}

export async function executeFetchUrl(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Synapse/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return `HTTP ${resp.status} ${resp.statusText} — page not found or inaccessible.`;
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text")) return `Non-text content (${contentType}), cannot display.`;
    const raw = await resp.text();
    const text = raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10_000);
    return text || "(empty page)";
  } catch (err: any) {
    return `Fetch error: ${err?.message ?? String(err)}`;
  }
}

// ============================
// AI SDK 6 tool factory
// ============================

/**
 * Re-inspect a stored image with a SPECIFIC question — the "look again"
 * primitive that closes the gap with native-vision UX. The tool loop can't
 * carry image blocks (fucheers rejects images+tools in one request), so the
 * model calls this instead: one dedicated no-tools vision request against the
 * stored original, conditioned on the exact question being asked.
 */
export async function executeViewImage(userId: string, attachment: string, question: string): Promise<string> {
  const dataUrl = attachmentToDataUrl(userId, attachment);
  if (!dataUrl) {
    return `view_image error: attachment "${attachment}" not found. Use the exact name from the [用户发送的图片：att_….png] marker.`;
  }
  const provider = getLLMProvider();
  try {
    const gen = await generateText({
      model: provider.createModel(),
      system: "你是图像分析助手。仔细观察图片，针对用户的问题给出准确、具体的回答。看不清或图中没有的信息如实说明，不要编造。",
      messages: [{
        role: "user",
        content: [
          { type: "image", image: dataUrl },
          { type: "text", text: question },
        ],
      }] as never,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return gen.text.trim() || "view_image: (empty response)";
  } catch (err) {
    return `view_image error: ${(err as Error).message}`;
  }
}

/**
 * Returns the two tools as an `ai`-SDK-6 `tools` record, ready to pass into
 * `streamText({ tools, stopWhen: stepCountIs(N) })` / `generateText({ tools, ... })`.
 *
 * Tool names match the TencentDB originals so existing system-prompt conventions
 * and downstream LLM training carry over.
 */
export function buildChatTools(userId: string) {
  return {
    // NOTE: named `search_the_web`, NOT `web_search` — the fucheers proxy
    // hijacks any tool literally named `web_search` with its own built-in
    // search (returns SSE + "无法提取搜索关键词"), so our Tavily-backed tool
    // never runs. The rename dodges that interception.
    search_the_web: tool({
      description:
        "Search the web via Tavily. Use when the user asks about external information, " +
        "wants to find a GitHub repo, paper, tool, or any public resource. " +
        "Returns titles, URLs, and snippets. After searching, use fetch_url to read the actual page.",
      inputSchema: z.object({
        query: z.string().describe("Search query, e.g. 'BAMresearch MINERVA github' or 'FAIR data chemotion ELN'"),
      }),
      execute: async ({ query }) => executeWebSearch(query),
    }),

    fetch_url: tool({
      description:
        "Fetch and read the text content of a URL. Use to: verify a link exists, " +
        "read a GitHub README, fetch a paper abstract page, check a DOI landing page. " +
        "Returns up to 10k chars of page text. If the page returns HTTP 404/403, the link is invalid.",
      inputSchema: z.object({
        url: z.string().describe("Full URL to fetch, e.g. 'https://github.com/BAMresearch/MINERVA'"),
      }),
      execute: async ({ url }) => executeFetchUrl(url),
    }),

    search_papers: tool({
      description:
        "Search academic papers on Semantic Scholar. Returns title, authors, year, DOI, open-access PDF link, and TL;DR. " +
        "Use when the user asks about research papers, wants to find a paper's DOI/PDF, or needs to find associated code repos. " +
        "Better than search_the_web for academic queries. After finding a paper, use fetch_url on its DOI or GitHub link.",
      inputSchema: z.object({
        query: z.string().describe("Paper title, author name, or topic, e.g. 'MINERVA self-driving lab nanomaterials BAM'"),
      }),
      execute: async ({ query }) => executeSemanticScholarSearch(query),
    }),

    view_image: tool({
      description:
        "Look at one of the user's uploaded images AGAIN with a specific question. " +
        "Every uploaded image appears in the conversation as a [用户发送的图片：att_….png] block " +
        "containing a text transcript. When that transcript is NOT enough — visual details like " +
        "colors, layout, counts, small text, chart values, spatial relations — call this with the " +
        "attachment file name and a precise question. Returns a fresh vision analysis of the original image.",
      inputSchema: z.object({
        attachment: z.string().describe("Attachment file name from the image marker, e.g. 'att_1783704435668_ab12cd34.png'"),
        question: z.string().describe("The specific visual question to answer, e.g. '表格第三行的数值是多少？' "),
      }),
      execute: async ({ attachment, question }) => executeViewImage(userId, attachment, question),
    }),

    tdai_conversation_search: tool({
      description:
        "Search the user's stored RAW CONVERSATION history (L0) by keywords. " +
        "Returns matching messages with role, session, timestamp, and content. " +
        "Use when the user asks about something they said/discussed in past chats. " +
        "Returns individual messages, not full turns — issue follow-up calls with " +
        "different keywords or with `sessionKey` to gather more context from the " +
        "same conversation.",
      inputSchema: z.object({
        query: z.string().describe("Keywords or phrase to search for (FTS5 trigram)."),
        limit: z.number().int().min(1).max(30).optional()
          .describe("Max results to return (default 8)."),
        sessionKey: z.string().optional()
          .describe("Optional: restrict to one chat session by its sessionKey."),
      }),
      execute: async ({ query, limit, sessionKey }) => {
        const res = await executeConversationSearch({
          query,
          limit: limit ?? 8,
          userId,
          sessionKey,
        });
        return formatConversationSearchResponse(res);
      },
    }),

    tdai_memory_search: tool({
      description:
        "Search the user's structured MEMORIES (L1: distilled facts the system " +
        "extracted from past conversations). Use when the user asks about their " +
        "preferences, ongoing projects, research findings, methods, datasets, etc. " +
        "Each memory has a type (claim/method/observation/dataset/experiment/" +
        "finding/question/goal) and a scene_name. Returns more semantically " +
        "useful results than tdai_conversation_search for fact/preference lookups.",
      inputSchema: z.object({
        query: z.string().describe("Keywords or phrase to search for (FTS5 trigram)."),
        limit: z.number().int().min(1).max(30).optional()
          .describe("Max results to return (default 8)."),
        type: z.enum([
          "claim", "method", "observation", "dataset",
          "experiment", "finding", "question", "goal",
        ]).optional().describe("Optional: restrict to one memory type."),
        scene: z.string().optional()
          .describe("Optional: substring match against scene_name."),
      }),
      execute: async ({ query, limit, type, scene }) => {
        const res = await executeMemorySearch({
          query,
          limit: limit ?? 8,
          userId,
          type,
          scene,
        });
        return formatSearchResponse(res);
      },
    }),
  };
}
