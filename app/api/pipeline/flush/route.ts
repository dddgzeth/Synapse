/**
 * POST /api/pipeline/flush — process any pending L0 turns that haven't reached
 * the L1 batch threshold yet.
 *
 * Called from SynapseApp on mount as the "user returns after a gap" recovery
 * path. Idempotent: if there's nothing pending, just returns.
 *
 * Body:
 *   { sessionKey?: string }   — defaults to "chat_main"
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { forceFlush } from "@/lib/memory/scheduler";
import { getCurrentSessionKey, getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { sessionKey?: string; sessionId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body OK
  }
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sessionKey = await getCurrentSessionKey(body.sessionKey ?? null);
  if (!sessionKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sessionId = body.sessionId ?? `flush_${crypto.randomBytes(3).toString("hex")}`;
  const result = await forceFlush(sessionKey, sessionId, userId);
  return NextResponse.json(result);
}
