/**
 * GET /api/aha/last
 *
 * Returns the most recently detected Aha Insight (structured JSON) so the
 * frontend can render its evidence chain without parsing the LLM's text reply.
 *
 * Query params:
 *   - force=1 → bypass natural-detection gating and regenerate from the top
 *               priority L1 memories. Used by the mock/preview page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAhaLast, forceGenerateAha, isAhaLastSeen } from "@/lib/memory/aha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";

  if (force) {
    const fresh = await forceGenerateAha();
    if (!fresh) {
      return NextResponse.json({ aha: null, unseen: false, reason: "no_memories_or_generation_failed" });
    }
    return NextResponse.json({ aha: fresh, unseen: true, source: "force" });
  }

  const aha = getAhaLast();
  const unseen = aha ? !isAhaLastSeen() : false;
  return NextResponse.json({ aha, unseen, source: aha ? "cached" : "none" });
}
