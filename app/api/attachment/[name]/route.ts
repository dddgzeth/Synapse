/**
 * GET /api/attachment/[name] — serve a persisted chat image attachment.
 *
 * Auth-scoped: only the owning user can read their attachments (files live
 * under data/users/<userId>/attachments/). Names are validated against a
 * strict pattern in readAttachment, so no path traversal.
 */
import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth-session";
import { readAttachment } from "@/lib/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { name: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = readAttachment(userId, decodeURIComponent(params.name));
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new Response(new Uint8Array(r.buf), {
    headers: {
      "Content-Type": r.mime,
      // Attachment content never changes for a given name — cache hard.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
