/**
 * POST /api/aha/evidence
 *
 * Body: { memoryIds: string[] }
 *
 * For the given L1 memory IDs, joins:
 *   - L1 records themselves (from sqlite l1_records)
 *   - The best-matching L2 scene block for each memory (by keyword overlap
 *     against scene_index.json — L1.scene_name doesn't literally equal the
 *     scene filename, so we fuzzy-match)
 *   - L0 raw conversation messages referenced by each L1.source_message_ids
 *
 * Returns the JSON shape the AhaCard evidence-chain UI consumes (one canvas
 * worth of data: insight → scenes → memories → conversations).
 */
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { queryL1ByIds, queryL0ByIds } from "@/lib/memory/store";
import { readSceneIndex, type SceneIndexEntry } from "@/lib/tencentdb/scene/scene-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getDataDir(): string {
  return process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
}

interface ScenePayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  memoryCount: number;
  maxPriority: number;
}

interface MemoryPayload {
  id: string;
  type: string;
  priority: number;
  scene_name: string;
  sceneFilename: string | null;
  content: string;
  createdAt: string;
  sourceMessageIds: string[];
}

interface ConversationPayload {
  role: string;
  content: string;
  sessionKey: string;
  recorded_at: string;
}

interface EvidenceResponse {
  scenes: ScenePayload[];
  memories: MemoryPayload[];
  conversations: Record<string, ConversationPayload>;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[\s　，。、,.\-_/()【】（）「」"'`!?！？:：;；]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

function pickSceneForMemory(
  memoryTokens: Set<string>,
  scenes: SceneIndexEntry[],
): SceneIndexEntry | null {
  let best: SceneIndexEntry | null = null;
  let bestScore = 0;
  for (const s of scenes) {
    const title = s.filename.replace(/\.md$/, "");
    const candidateTokens = new Set<string>([
      ...tokenize(title),
      ...tokenize(s.summary),
    ]);
    let score = 0;
    for (const t of memoryTokens) {
      if (candidateTokens.has(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body?.memoryIds) ? (body.memoryIds as string[]).filter((s) => typeof s === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json<EvidenceResponse>({ scenes: [], memories: [], conversations: {} });
  }

  // ── 1. Load L1 records by ID ──
  const l1Records = queryL1ByIds(ids);

  // Preserve request order
  const byId = new Map(l1Records.map((r) => [r.id, r]));
  const orderedL1 = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);

  // ── 2. Load scene index and assign each memory its best-matching scene ──
  const sceneIndex = await readSceneIndex(getDataDir());

  const memoryToScene = new Map<string, SceneIndexEntry | null>();
  for (const m of orderedL1) {
    const memTokens = new Set<string>([
      ...tokenize(m.scene_name ?? ""),
      ...tokenize((m.content ?? "").slice(0, 200)),
    ]);
    memoryToScene.set(m.id, pickSceneForMemory(memTokens, sceneIndex));
  }

  // ── 3. Aggregate per-scene stats ──
  const sceneAgg = new Map<string, { entry: SceneIndexEntry; memoryCount: number; maxPriority: number }>();
  for (const m of orderedL1) {
    const s = memoryToScene.get(m.id);
    if (!s) continue;
    const cur = sceneAgg.get(s.filename);
    if (cur) {
      cur.memoryCount += 1;
      cur.maxPriority = Math.max(cur.maxPriority, m.priority ?? 0);
    } else {
      sceneAgg.set(s.filename, { entry: s, memoryCount: 1, maxPriority: m.priority ?? 0 });
    }
  }

  const scenes: ScenePayload[] = [...sceneAgg.values()]
    .sort((a, b) => b.maxPriority - a.maxPriority)
    .map(({ entry, memoryCount, maxPriority }) => ({
      filename: entry.filename,
      title: entry.filename.replace(/\.md$/, ""),
      summary: entry.summary,
      heat: entry.heat,
      memoryCount,
      maxPriority,
    }));

  // ── 4. Build memory payloads ──
  const memories: MemoryPayload[] = orderedL1.map((m) => ({
    id: m.id,
    type: m.type,
    priority: m.priority,
    scene_name: m.scene_name ?? "",
    sceneFilename: memoryToScene.get(m.id)?.filename ?? null,
    content: m.content,
    createdAt: m.createdAt,
    sourceMessageIds: m.source_message_ids ?? [],
  }));

  // ── 5. Load referenced L0 conversations ──
  const allL0Ids = [...new Set(orderedL1.flatMap((m) => m.source_message_ids ?? []))];
  const l0Rows = queryL0ByIds(allL0Ids);
  const conversations: Record<string, ConversationPayload> = {};
  for (const row of l0Rows) {
    conversations[row.record_id] = {
      role: row.role,
      content: row.message_text,
      sessionKey: row.session_key,
      recorded_at: row.recorded_at,
    };
  }

  return NextResponse.json<EvidenceResponse>({ scenes, memories, conversations });
}
