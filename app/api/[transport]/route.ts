/**
 * Synapse MCP server — remote Streamable HTTP endpoint at /api/mcp.
 *
 * Turns Synapse into the cross-tool memory layer: Claude Code / Codex /
 * Cursor connect here (Bearer PAT, see lib/api-tokens.ts) and get six tools
 * that are thin wrappers over the existing memory stack. External writes go
 * through the SAME pipeline as web chat (embed-queue → L1 → L2/L3 → noticed),
 * under session_key `chat_<userId>_ext_<source>` so provenance is visible.
 *
 * Plan: docs/mcp-server-plan-0711.md
 */
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v3";
import crypto from "node:crypto";
import { verifyToken, rateLimitOk } from "@/lib/api-tokens";
import { insertL0 } from "@/lib/memory/store";
import { recallForQuery } from "@/lib/memory/recall";
import { notifyTurn, forceFlush } from "@/lib/memory/scheduler";
import { getAhaHistoryList } from "@/lib/memory/aha";
import { extSessionKeyForUser } from "@/lib/memory/user-scope";
import {
  executeMemorySearch,
  formatSearchResponse,
  executeConversationSearch,
  formatConversationSearchResponse,
} from "@/lib/memory/search-tools";

export const runtime = "nodejs";
export const maxDuration = 120;

const SITE = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://synapse.cjlin.com";
const MAX_MSG_CHARS = 50_000;
const MAX_BATCH = 40;

function uidOf(extra: { authInfo?: AuthInfo }): string {
  const uid = extra.authInfo?.extra?.userId;
  if (typeof uid !== "string" || !uid) throw new Error("unauthorized");
  return uid;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function guard(extra: { authInfo?: AuthInfo }): { userId: string } | { error: ReturnType<typeof text> } {
  const userId = uidOf(extra);
  if (!rateLimitOk(userId)) {
    return { error: text("Rate limit exceeded (60 requests/min). Slow down and retry.") };
  }
  return { userId };
}


function writeL0(sessionKey: string, sessionId: string, role: "user" | "assistant", content: string, ts: number) {
  insertL0({
    record_id: `l0_${ts}_${role === "user" ? "u" : "a"}_${crypto.randomBytes(3).toString("hex")}`,
    session_key: sessionKey,
    session_id: sessionId,
    role,
    message_text: content.slice(0, MAX_MSG_CHARS),
    recorded_at: new Date(ts).toISOString(),
    timestamp: ts,
  });
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_context",
      {
        title: "Get user context",
        description:
          "Load the user's persona and most relevant long-term memories from Synapse (their cross-tool second memory). " +
          "CALL THIS FIRST when a conversation touches the user personally: their research direction, ongoing projects, " +
          "preferences, or anything referencing their history. Local project files only cover the current repo; " +
          "Synapse covers the person across all tools and months of work. Optionally pass a topic to focus the recall.",
        inputSchema: {
          topic: z.string().optional().describe("Optional topic to focus recall on, e.g. 'SDL data infrastructure'"),
        },
      },
      async ({ topic }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const recall = await recallForQuery(topic?.trim() || "当前研究方向与近期工作重点", g.userId);
        return text(recall.contextText || "No memories stored yet — this user's Synapse memory is empty so far.");
      },
    );

    server.registerTool(
      "search_memory",
      {
        title: "Search long-term memories",
        description:
          "Search the user's distilled long-term memories (facts, claims, methods, findings, goals) in Synapse. " +
          "Hybrid keyword + semantic search — paraphrases work. Use for 'what did I conclude about X', " +
          "'my preferences on Y', 'have I worked on Z before'.",
        inputSchema: {
          query: z.string().describe("What to look for — natural language is fine"),
          limit: z.number().int().min(1).max(30).optional().describe("Max results (default 8)"),
          type: z.enum(["claim", "method", "observation", "dataset", "experiment", "finding", "question", "goal"])
            .optional().describe("Optional memory-type filter"),
        },
      },
      async ({ query, limit, type }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const res = await executeMemorySearch({ query, limit: limit ?? 8, userId: g.userId, type });
        return text(formatSearchResponse(res));
      },
    );

    server.registerTool(
      "search_conversations",
      {
        title: "Search raw conversation history",
        description:
          "Full-text + semantic search over the user's RAW conversation archive across all tools and the Synapse app. " +
          "Use when the user asks about something they said or discussed before ('那次我们聊的…', 'last month I mentioned…').",
        inputSchema: {
          query: z.string().describe("Keywords or phrase to search for"),
          limit: z.number().int().min(1).max(30).optional().describe("Max results (default 8)"),
        },
      },
      async ({ query, limit }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const res = await executeConversationSearch({ query, limit: limit ?? 8, userId: g.userId });
        return text(formatConversationSearchResponse(res));
      },
    );

    server.registerTool(
      "remember",
      {
        title: "Remember something",
        description:
          "Store one important piece of information in the user's Synapse memory, immediately. " +
          "Call when the user says 'remember this / 记住…', states a durable preference, decision, or fact " +
          "they'll want available in every future session across all their AI tools.",
        inputSchema: {
          content: z.string().describe("The information to remember, as a self-contained statement"),
          source: z.string().optional().describe("Client name, e.g. 'claude-code', 'codex' (default 'mcp')"),
          project: z.string().optional().describe("Project name, e.g. basename of the working directory"),
        },
      },
      async ({ content, source, project }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const sessionKey = extSessionKeyForUser(g.userId, source ?? "mcp", project);
        const sessionId = `ext_${crypto.randomUUID()}`;
        writeL0(sessionKey, sessionId, "user", content, Date.now());
        await notifyTurn(sessionKey, sessionId, g.userId);
        const res = await forceFlush(sessionKey, sessionId, g.userId);
        return text(
          `Remembered. Extracted ${res.newMemories} structured memor${res.newMemories === 1 ? "y" : "ies"} — ` +
          `searchable across all connected tools and at ${SITE}.`,
        );
      },
    );

    server.registerTool(
      "log_conversation",
      {
        title: "Log a conversation into memory",
        description:
          "Archive an exchange (user + assistant turns) into the user's Synapse memory so it becomes searchable and " +
          "feeds pattern discovery. Call after a substantive discussion — design decisions, research reasoning, " +
          "conclusions worth keeping. Skip trivial back-and-forth.",
        inputSchema: {
          messages: z.array(z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          })).min(1).max(MAX_BATCH).describe("Turns in chronological order"),
          source: z.string().describe("Client name, e.g. 'claude-code', 'codex', 'cursor'"),
          project: z.string().optional().describe("Project name, e.g. basename of the working directory"),
          session_id: z.string().optional().describe("The tool's native session id, so repeated calls append to the same conversation"),
        },
      },
      async ({ messages, source, project, session_id }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const sessionKey = extSessionKeyForUser(g.userId, source, project);
        const sessionId = session_id?.trim() || `ext_${crypto.randomUUID()}`;
        const base = Date.now() - messages.length; // preserve given order
        messages.forEach((m, i) => writeL0(sessionKey, sessionId, m.role, m.content, base + i));
        let turns = 0;
        for (const m of messages) {
          if (m.role === "user") { await notifyTurn(sessionKey, sessionId, g.userId); turns++; }
        }
        return text(`Logged ${messages.length} messages (${turns} turns) from ${source} into Synapse memory.`);
      },
    );

    server.registerTool(
      "get_insights",
      {
        title: "Get Synapse noticed insights",
        description:
          "Fetch the user's latest 'Synapse noticed' insights — patterns Synapse passively detected across their " +
          "conversations over time. Use when the user asks what patterns/threads have emerged in their thinking.",
        inputSchema: {
          limit: z.number().int().min(1).max(10).optional().describe("Max insights (default 3)"),
        },
      },
      async ({ limit }, extra) => {
        const g = guard(extra); if ("error" in g) return g.error;
        const list = getAhaHistoryList(g.userId, limit ?? 3);
        if (list.length === 0) return text("No insights yet — they appear as the memory accumulates.");
        const body = list.map((e) =>
          `• [${e.detectedAt.slice(0, 10)}] ${e.pattern}\n  ${e.observation.slice(0, 200)}${e.observation.length > 200 ? "…" : ""}\n  Evidence: ${SITE}/aha/${encodeURIComponent(e.id)}`,
        ).join("\n\n");
        return text(body);
      },
    );
  },
  {},
  { basePath: "/api", maxDuration: 120, verboseLogs: false },
);

const authed = withMcpAuth(
  handler,
  async (_req, bearer) => {
    const userId = verifyToken(bearer);
    if (!userId) return undefined;
    return {
      token: bearer!,
      clientId: userId,
      scopes: ["memory"],
      extra: { userId },
    } satisfies AuthInfo;
  },
  { required: true },
);

export { authed as GET, authed as POST, authed as DELETE };
