/**
 * POST /api/aha/seen — mark the most recently detected Aha as seen by the user.
 * Called when sidebar badge is clicked or the chat-injected Aha is rendered.
 */
import { NextResponse } from "next/server";
import { markAhaLastSeen } from "@/lib/memory/aha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  markAhaLastSeen();
  return NextResponse.json({ ok: true });
}
