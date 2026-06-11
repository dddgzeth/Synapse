/**
 * GET    /api/aha/[id] — fetch a specific historic Aha by id (per-user).
 * DELETE /api/aha/[id] — delete one Aha from history (per-user, owner-checked).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAhaFromHistory, deleteAhaInsight } from "@/lib/memory/aha";
import { getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ aha: null }, { status: 401 });
  const aha = getAhaFromHistory(userId, params.id);
  if (!aha) return NextResponse.json({ aha: null }, { status: 404 });
  return NextResponse.json({ aha });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const ok = deleteAhaInsight(userId, params.id);
  if (!ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
