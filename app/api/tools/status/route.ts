/**
 * GET /api/tools/status — the user's connected external tools, as a
 * source → project → sessions tree. Powers the sidebar "Connected Tools".
 */
import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth-session";
import { sessionKeyForUser } from "@/lib/memory/user-scope";
import { listExternalSessions } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ sources: [] }, { status: 401 });

  const groups = listExternalSessions(sessionKeyForUser(userId));
  // Re-shape flat (source,project) groups into source → [projects] for the tree.
  const bySource = new Map<string, {
    source: string;
    projects: Array<{ project: string; sessions: typeof groups[number]["sessions"]; messageCount: number; lastActive: string }>;
  }>();
  for (const g of groups) {
    let s = bySource.get(g.source);
    if (!s) { s = { source: g.source, projects: [] }; bySource.set(g.source, s); }
    const messageCount = g.sessions.reduce((n, x) => n + x.messageCount, 0);
    const lastActive = g.sessions.reduce((m, x) => (x.lastActive > m ? x.lastActive : m), "");
    s.projects.push({ project: g.project, sessions: g.sessions, messageCount, lastActive });
  }
  return NextResponse.json({ sources: [...bySource.values()] });
}
