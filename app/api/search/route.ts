import { NextRequest, NextResponse } from "next/server";
import { searchL1Fts, searchL0Fts } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const l1 = searchL1Fts(q, 15);
  const results = l1.map((m) => ({
    id: m.id,
    content: m.content,
    type: m.type,
    priority: m.priority,
    scene_name: m.scene_name,
    updatedAt: m.updatedAt,
  }));

  return NextResponse.json({ results });
}
