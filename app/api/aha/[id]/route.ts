/**
 * GET /api/aha/[id] — fetch a specific historic Aha by id.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAhaFromHistory } from "@/lib/memory/aha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const aha = getAhaFromHistory(params.id);
  if (!aha) return NextResponse.json({ aha: null }, { status: 404 });
  return NextResponse.json({ aha });
}
