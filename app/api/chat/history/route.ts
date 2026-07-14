import { NextRequest } from "next/server";
import { queryL0HistoryForSession } from "@/lib/memory/store";
import { getCurrentSessionKey } from "@/lib/auth-session";
import { IMG_MARKER_RE, IMG_DESC_RE, mimeForAttachment } from "@/lib/attachments";

export const runtime = "nodejs";

// Persisted user messages carry `[img:<name>]` markers for pasted images
// (written by /api/chat). Rebuild them as file parts pointing at
// /api/attachment/<name> so MessageBubble renders the image after a reload.
function partsForMessage(text: string): Array<Record<string, unknown>> {
  const names = [...text.matchAll(IMG_MARKER_RE)].map((m) => m[1]);
  const cleaned = text.replace(IMG_DESC_RE, "").replace(IMG_MARKER_RE, "").trimEnd();
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: cleaned }];
  for (const name of names) {
    parts.push({
      type: "file",
      mediaType: mimeForAttachment(name),
      filename: name,
      url: `/api/attachment/${name}`,
    });
  }
  return parts;
}

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
      parts: partsForMessage(row.message_text),
      metadata: {
        sessionId: row.session_id,
        recordedAt: row.recorded_at,
        timestamp: row.timestamp,
      },
    }));

  return Response.json({ messages });
}
