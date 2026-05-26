import { NextRequest } from "next/server";
import { queryL0HistoryForSession } from "@/lib/memory/store";
import { getCurrentSessionKey } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionKey = await getCurrentSessionKey(searchParams.get("sessionKey") || "chat_main");
  if (!sessionKey) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawLimit = Number(searchParams.get("limit") || "100");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;

  const rows = queryL0HistoryForSession(sessionKey, limit);
  const messages = rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      id: row.record_id,
      role: row.role,
      parts: [{ type: "text", text: row.message_text }],
      metadata: {
        sessionId: row.session_id,
        recordedAt: row.recorded_at,
        timestamp: row.timestamp,
      },
    }));

  return Response.json({ messages });
}
