/**
 * GET /api/memories/export — download the signed-in user's COMPLETE memory as
 * a single JSON file. Unlike /api/memories (which is limited + shaped for the
 * sidebar), this returns every layer in full:
 *
 *   l0  — all raw conversation turns (user + assistant), chronological
 *   l1  — all atomic research memories
 *   l2  — all scene blocks (markdown bodies + meta)
 *   l3  — full persona.md
 *   aha — every detected "Synapse noticed" insight (full payload)
 *
 * Scope is strictly the authenticated user (never trust the client). The
 * response carries a Content-Disposition header so the browser saves it.
 */

import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import {
  queryAllL0ForUser,
  queryAllL1ForUser,
  listAhaHistory,
} from "@/lib/memory/store";
import { readSceneIndex } from "@/lib/tencentdb/scene/scene-index";
import { parseSceneBlock } from "@/lib/tencentdb/scene/scene-format";
import { stripSceneNavigation } from "@/lib/tencentdb/scene/scene-navigation";
import { getCurrentUserId } from "@/lib/auth-session";
import {
  getUserDataDir,
  getUserPersonaPath,
  getUserSceneBlocksDir,
  sessionKeyForUser,
} from "@/lib/memory/user-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// No practical cap on a personal export — pick a ceiling high enough that no
// real user hits it, while still bounding a runaway query.
const EXPORT_L1_LIMIT = 100_000;
const EXPORT_AHA_LIMIT = 10_000;

async function readScenesFull(userId: string) {
  const dataDir = getUserDataDir(userId);
  const blocksDir = getUserSceneBlocksDir(userId);
  try {
    const index = await readSceneIndex(dataDir);
    const scenes = [];
    for (const entry of index) {
      try {
        const raw = await fs.promises.readFile(path.join(blocksDir, entry.filename), "utf-8");
        const block = parseSceneBlock(raw, entry.filename);
        scenes.push({
          filename: entry.filename,
          title: entry.filename.replace(/\.md$/, ""),
          summary: entry.summary || block.meta.summary,
          heat: entry.heat,
          updated: entry.updated,
          content: block.content,
        });
      } catch {
        // skip missing/unreadable scene file
      }
    }
    scenes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return scenes;
  } catch {
    return [];
  }
}

function readPersonaFull(userId: string): string | null {
  try {
    const personaPath = getUserPersonaPath(userId);
    if (!fs.existsSync(personaPath)) return null;
    const body = stripSceneNavigation(fs.readFileSync(personaPath, "utf-8")).trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const prefix = sessionKeyForUser(userId);

  const l0 = queryAllL0ForUser(prefix);
  const l1 = queryAllL1ForUser(prefix, EXPORT_L1_LIMIT);
  const [l2] = await Promise.all([readScenesFull(userId)]);
  const l3 = readPersonaFull(userId);
  const aha = listAhaHistory(userId, EXPORT_AHA_LIMIT)
    .map((row) => {
      try { return JSON.parse(row.payload_json); }
      catch { return null; }
    })
    .filter(Boolean);

  const payload = {
    schema: "synapse.memory.export/v1",
    exportedAt: new Date().toISOString(),
    userId,
    counts: { l0: l0.length, l1: l1.length, l2: l2.length, aha: aha.length },
    l0,
    l1,
    l2,
    l3,
    aha,
  };

  const filename = `synapse-memory-${userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
