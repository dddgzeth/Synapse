/**
 * GET /api/aha/last
 *
 * Returns the most recently detected Aha Insight (structured JSON) so the
 * frontend can render its evidence chain without parsing the LLM's text reply.
 * Per-user.
 *
 * Query params:
 *   - force=1 → bypass natural-detection gating and regenerate from the top
 *               priority L1 memories. Used by the mock/preview page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAhaLast, forceGenerateAha, isAhaLastSeen } from "@/lib/memory/aha";
import { getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ aha: null, unseen: false, source: "no_user" });

  const force = req.nextUrl.searchParams.get("force") === "1";

  if (force) {
    const fresh = await forceGenerateAha(userId);
    if (!fresh) {
      return NextResponse.json({ aha: null, unseen: false, reason: "no_memories_or_generation_failed" });
    }
    return NextResponse.json({ aha: fresh, unseen: true, source: "force" });
  }

  const aha = getAhaLast(userId);
  const unseen = aha ? !isAhaLastSeen(userId) : false;
  return NextResponse.json({ aha, unseen, source: aha ? "cached" : "none" });
}
