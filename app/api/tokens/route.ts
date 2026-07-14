/**
 * /api/tokens — personal access token management (cookie-authed, web UI only).
 *
 * GET    → list this user's tokens (hashes + metadata, never plaintext)
 * POST   → create one; response carries the plaintext EXACTLY ONCE
 * DELETE → revoke by tokenHash
 *
 * The MCP endpoint itself authenticates with these tokens (lib/api-tokens.ts);
 * this route is how users mint/revoke them from the settings UI.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth-session";
import { createToken, listTokens, revokeToken } from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ tokens: listTokens(userId) });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const label = typeof body?.label === "string" ? body.label.slice(0, 60) : "";
  if (listTokens(userId).length >= 10) {
    return NextResponse.json({ error: "too_many_tokens" }, { status: 400 });
  }
  const token = createToken(userId, label);
  return NextResponse.json({ token, tokens: listTokens(userId) });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const tokenHash = typeof body?.tokenHash === "string" ? body.tokenHash : "";
  if (!tokenHash) return NextResponse.json({ error: "missing_tokenHash" }, { status: 400 });
  const ok = revokeToken(userId, tokenHash);
  return NextResponse.json({ ok, tokens: listTokens(userId) });
}
