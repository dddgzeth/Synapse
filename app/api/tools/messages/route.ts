/**
 * GET /api/tools/messages?source=&project=&session=&limit=&offset=
 * Full L0 for one external tool conversation — read-only browser page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth-session";
import { sessionKeyForUser } from "@/lib/memory/user-scope";
import { queryL0ForExternalSession } from "@/lib/memory/store";
import { IMG_MARKER_RE, IMG_DESC_RE } from "@/lib/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// source/project arrive already-slugged from /api/tools/status; only guard
// against underscores (would break session_key reconstruction) + length.
const clean = (s: string | null) => (s ?? "").replace(/_/g, "").slice(0, 60);

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ messages: [] }, { status: 401 });

  const q = req.nextUrl.searchParams;
  const source = clean(q.get("source"));
  const project = clean(q.get("project"));
  const session = q.get("session")?.trim() || undefined;
  if (!source) return NextResponse.json({ messages: [] });
  const limit = Math.min(Math.max(Number(q.get("limit") || "300"), 1), 500);
  const offset = Math.max(Number(q.get("offset") || "0"), 0);

  const rows = queryL0ForExternalSession(sessionKeyForUser(userId), source, project, session, limit, offset);
  const messages = rows.map((r) => ({
    id: r.record_id,
    role: r.role,
    // Strip internal image markers for a clean read-only view.
    content: r.message_text.replace(IMG_DESC_RE, "").replace(IMG_MARKER_RE, "").trim(),
    sessionId: r.session_id,
    recordedAt: r.recorded_at,
  }));
  return NextResponse.json({ messages, source, project });
}
