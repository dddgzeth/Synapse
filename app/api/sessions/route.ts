/**
 * GET  /api/sessions          — list this user's chat sessions
 * DELETE /api/sessions?key=…  — delete one session (L0 + L1 rows for that
 *                                session_key). L2/L3 are per-user, untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { listSessionsForUser, deleteSession } from "@/lib/memory/store";
import { getCurrentUserId } from "@/lib/auth-session";
import { sessionKeyForUser } from "@/lib/memory/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ sessions: [] });
  const prefix = sessionKeyForUser(userId);
  const sessions = listSessionsForUser(prefix, 100);
  return NextResponse.json({ sessions, defaultSessionKey: prefix });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const target = req.nextUrl.searchParams.get("key");
  if (!target) return NextResponse.json({ ok: false, error: "missing_key" }, { status: 400 });

  const prefix = sessionKeyForUser(userId);
  // Defence-in-depth: only allow deleting sessions owned by this user.
  if (target !== prefix && !target.startsWith(`${prefix}_`)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const result = deleteSession(target);
  return NextResponse.json({ ok: true, deleted: result });
}
