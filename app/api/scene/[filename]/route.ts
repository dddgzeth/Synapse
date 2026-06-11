/**
 * GET /api/scene/[filename] — single scene block + its full markdown content.
 *
 * Used by the /scenes/[filename] detail page.
 */
import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { parseSceneBlock } from "@/lib/tencentdb/scene/scene-format";
import { readSceneIndex } from "@/lib/tencentdb/scene/scene-index";
import { getCurrentUserId } from "@/lib/auth-session";
import { getUserDataDir, getUserSceneBlocksDir } from "@/lib/memory/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { filename: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const filename = decodeURIComponent(params.filename);
  // Defence-in-depth: reject path traversal.
  if (filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "invalid_filename" }, { status: 400 });
  }
  const dataDir = getUserDataDir(userId);
  const filePath = path.join(getUserSceneBlocksDir(userId), filename);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const block = parseSceneBlock(raw, filename);
    const index = await readSceneIndex(dataDir);
    const entry = index.find((e) => e.filename === filename);
    return NextResponse.json({
      filename,
      title: filename.replace(/\.md$/, ""),
      summary: entry?.summary ?? block.meta.summary ?? "",
      heat: entry?.heat ?? 0,
      created: entry?.created ?? "",
      updated: entry?.updated ?? "",
      content: block.content,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
