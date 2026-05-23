/**
 * GET /api/memory/[id] — single L1 record + its L0 source messages.
 *
 * Used by the /memories/[id] detail page.
 */
import { NextResponse } from "next/server";
import { queryL1ByIds, queryL0ByIds } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const id = decodeURIComponent(params.id);
  const [memory] = queryL1ByIds([id]);
  if (!memory) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const l0Rows = queryL0ByIds(memory.source_message_ids ?? []);
  const conversations = l0Rows.map((r) => ({
    record_id: r.record_id,
    role: r.role,
    content: r.message_text,
    sessionKey: r.session_key,
    recorded_at: r.recorded_at,
  }));
  return NextResponse.json({ memory, conversations });
}
