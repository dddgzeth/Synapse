/**
 * GET /api/aha/history — list every detected Aha (most recent first).
 * Returns lightweight metadata only; full payload via /api/aha/[id].
 */
import { NextResponse } from "next/server";
import { getAhaHistoryList } from "@/lib/memory/aha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const items = getAhaHistoryList(50);
  return NextResponse.json({ items });
}
