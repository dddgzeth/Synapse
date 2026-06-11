/**
 * GET /api/search?q=...
 *
 * Cross-session conversation search (L0). Returns matching messages with
 * enough context for the sidebar to render a clickable result that jumps
 * to the source session + message.
 */
import { NextRequest, NextResponse } from "next/server";
import { searchL0FtsForUser, queryL0HistoryForSession } from "@/lib/memory/store";
import { getCurrentUserId } from "@/lib/auth-session";
import { sessionKeyForUser } from "@/lib/memory/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchResultItem {
  recordId: string;
  sessionKey: string;
  sessionTitle: string;
  role: string;
  snippet: string;       // ~200 chars around the match
  recordedAt: string;
}

const SNIPPET_LEN = 220;

function buildSnippet(text: string, query: string): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const hit = lower.indexOf(query.toLowerCase().split(/\s+/)[0] ?? "");
  if (hit < 0 || text.length <= SNIPPET_LEN) return text.slice(0, SNIPPET_LEN);
  const start = Math.max(0, hit - 60);
  const end = Math.min(text.length, start + SNIPPET_LEN);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ results: [] });
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const prefix = sessionKeyForUser(userId);
  const rows = searchL0FtsForUser(q, prefix, 30);

  // Pre-compute one title per sessionKey so we don't redo the SELECT per row.
  const titleCache = new Map<string, string>();
  function titleFor(sessionKey: string): string {
    if (titleCache.has(sessionKey)) return titleCache.get(sessionKey)!;
    const earliest = queryL0HistoryForSession(sessionKey, 1)
      .find((r) => r.role === "user");
    const raw = earliest?.message_text ?? "";
    const cleaned = raw
      .replace(/<<<file:[^>]*>>>[\s\S]*?<<<end:[^>]*>>>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const title = cleaned.length > 40 ? cleaned.slice(0, 40) + "…" : (cleaned || "New chat");
    titleCache.set(sessionKey, title);
    return title;
  }

  const results: SearchResultItem[] = rows.map((r) => ({
    recordId: r.record_id,
    sessionKey: r.session_key,
    sessionTitle: titleFor(r.session_key),
    role: r.role,
    snippet: buildSnippet(r.message_text, q),
    recordedAt: r.recorded_at,
  }));

  return NextResponse.json({ results });
}
