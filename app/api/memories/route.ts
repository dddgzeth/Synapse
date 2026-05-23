/**
 * /api/memories — sidebar data feed.
 *
 * Returns:
 *   - l0Count / l1Count           — raw counts
 *   - persona                     — L3 persona.md body (nav stripped)
 *   - scenes                      — L2 scene blocks (data/scene_blocks/*.md)
 *                                   with META + full content for expand-on-click
 *   - recentMemories              — L1 records (for the "最近记忆" list)
 */

import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { queryAllL1, countL1, countL0 } from "@/lib/memory/store";
import { readSceneIndex } from "@/lib/tencentdb/scene/scene-index";
import { parseSceneBlock } from "@/lib/tencentdb/scene/scene-format";
import { stripSceneNavigation } from "@/lib/tencentdb/scene/scene-navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getDataDir(): string {
  return process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
}

interface SceneBlockPayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  updated: string;
  content: string;
}

async function readScenes(): Promise<SceneBlockPayload[]> {
  const dataDir = getDataDir();
  const blocksDir = path.join(dataDir, "scene_blocks");
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
    // newest first
    scenes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return scenes;
  } catch {
    return [];
  }
}

function readPersona(): string | null {
  const personaPath = path.join(getDataDir(), "persona.md");
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
  const memories = queryAllL1(100);
  const l1Count = countL1();
  const l0Count = countL0();
  const [scenes, persona] = await Promise.all([
    readScenes(),
    Promise.resolve(readPersona()),
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
