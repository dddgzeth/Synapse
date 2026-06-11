/**
 * /api/memories — sidebar data feed (per-user).
 *
 * Returns:
 *   - l0Count / l1Count           — counts scoped to the signed-in user
 *   - persona                     — L3 persona.md for this user
 *   - scenes                      — L2 scene blocks for this user
 *   - recentMemories              — L1 records for this user
 */

import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import {
  queryAllL1ForUser,
  countL1ForUser,
  countL0ForUser,
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

interface SceneBlockPayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  updated: string;
  content: string;
}

async function readScenes(userId: string): Promise<SceneBlockPayload[]> {
  const dataDir = getUserDataDir(userId);
  const blocksDir = getUserSceneBlocksDir(userId);
  try {
    const index = await readSceneIndex(dataDir);
    const scenes: SceneBlockPayload[] = [];
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
        // skip missing/unreadable file
      }
    }
    scenes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return scenes;
  } catch {
    return [];
  }
}

function readPersona(userId: string): string | null {
  const personaPath = getUserPersonaPath(userId);
  try {
    if (!fs.existsSync(personaPath)) return null;
    const raw = fs.readFileSync(personaPath, "utf-8");
    const body = stripSceneNavigation(raw).trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({
      l0Count: 0, l1Count: 0, persona: null, scenes: [], recentMemories: [],
    });
  }
  const userPrefix = sessionKeyForUser(userId);
  // L1 memory is user-global (spans every session for this user).
  const memories = queryAllL1ForUser(userPrefix, 100);
  const l1Count = countL1ForUser(userPrefix);
  const l0Count = countL0ForUser(userPrefix);
  const [scenes, persona] = await Promise.all([
    readScenes(userId),
    Promise.resolve(readPersona(userId)),
  ]);

  return NextResponse.json({
    l0Count,
    l1Count,
    persona,
    scenes,
    recentMemories: memories.slice(0, 30).map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      priority: m.priority,
      scene_name: m.scene_name,
      updatedAt: m.updatedAt,
    })),
  });
}
