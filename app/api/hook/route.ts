/**
 * GET /api/hook — serve the auto-capture Stop-hook script (public, no auth).
 *
 * The "connect" instruction tells the target AI tool to `curl` this URL and
 * install the result as a Stop hook, so users never copy the script by hand.
 * Single source of truth: scripts/hooks/synapse_sync.py.
 */
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const p = path.join(process.cwd(), "scripts", "hooks", "synapse_sync.py");
    const body = fs.readFileSync(p, "utf8");
    return new Response(body, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return new Response("# hook script unavailable", { status: 404 });
  }
}
