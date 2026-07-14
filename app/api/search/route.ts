/**
 * GET /api/search?q=...
 *
 * Cross-session conversation search (L0). Returns matching messages with
 * enough context for the sidebar to render a clickable result that jumps
 * to the source session + message.
 */
import { NextRequest, NextResponse } from "next/server";
import { queryL0HistoryForSession } from "@/lib/memory/store";
import { searchL0HybridForUser } from "@/lib/memory/hybrid";
import { getCurrentUserId } from "@/lib/auth-session";
import { sessionKeyForUser, parseExtSessionKey } from "@/lib/memory/user-scope";
import { IMG_MARKER_RE } from "@/lib/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchResultItem {
  recordId: string;
  sessionKey: string;
  sessionTitle: string;
  role: string;
  snippet: string;       // ~200 chars around the match
  recordedAt: string;
  sessionId: string;     // L0 session_id (for scrolling within an archive)
  sourceLabel?: string;  // e.g. 'Claude Code / synapse' for external-tool hits
  source?: string;       // slug, present only for external-tool hits
  project?: string;      // slug, present only for external-tool hits
}

const SNIPPET_LEN = 220;

function buildSnippet(text: string, query: string): string {
  if (!text) return "";
  // Image markers live in L0 text ([img:name] + [img-desc]…[/img-desc]).
  // Keep the transcript CONTENT (a hit inside it is a legit match the user
  // should see) but swap the raw markers for a readable label.
  text = text
    .replace(IMG_MARKER_RE, "")
    .replace(/\[img-desc\]/g, "〔图片内容〕")
    .replace(/\[\/img-desc\]/g, "")
    .trim();
  const lower = text.toLowerCase();
  const hit = lower.indexOf(query.toLowerCase().split(/\s+/)[0] ?? "");
  if (hit < 0 || text.length <= SNIPPET_LEN) return text.slice(0, SNIPPET_LEN);
  const start = Math.max(0, hit - 60);
  const end = Math.min(text.length, start + SNIPPET_LEN);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function extLabel(source: string): string {
  const m: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", mcp: "MCP" };
  return m[source] ?? source;
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ results: [] });
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const prefix = sessionKeyForUser(userId);
  const rows = await searchL0HybridForUser(q, prefix, 30);

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

  const results: SearchResultItem[] = rows.map((r) => {
    const ext = parseExtSessionKey(r.session_key);
    return {
      recordId: r.record_id,
      sessionKey: r.session_key,
      sessionTitle: titleFor(r.session_key),
      role: r.role,
      snippet: buildSnippet(r.message_text, q),
      recordedAt: r.recorded_at,
      sessionId: r.session_id,
      // Provenance for hits that came from an external tool (Claude Code/etc).
      sourceLabel: ext ? `${extLabel(ext.source)}${ext.project ? ` / ${ext.project}` : ""}` : undefined,
      source: ext?.source,
      project: ext?.project,
    };
  });

  return NextResponse.json({ results });
}
