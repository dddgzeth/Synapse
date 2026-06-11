/**
 * GET /api/aha/history — list every detected Aha (most recent first).
 * Returns lightweight metadata only; full payload via /api/aha/[id].
 * Per-user.
 */
import { NextResponse } from "next/server";
import { getAhaHistoryList } from "@/lib/memory/aha";
import { getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ items: [] });
  const items = getAhaHistoryList(userId, 50);
  return NextResponse.json({ items });
}
