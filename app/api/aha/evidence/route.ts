/**
 * POST /api/aha/evidence
 *
 * Body: { memoryIds: string[] }
 *
 * Returns a graph-ready payload: scenes (one per L1 scene_name) and the
 * memories inside each, plus the L0 conversations cited by those memories.
 *
 * The graph groups by **L1 scene_name** rather than L2 scene_block on
 * purpose: L2 aggressively merges related sub-topics into one mega-block
 * (e.g. "FAIR数据基础设施…" subsumes hardware, ontology, AI planning, safety,
 * TCO into a single file). For evidence visualisation the user wants
 * fine-grained scene containers, and L1 scene_name already carries that
 * natural split (each L1 extraction tagged the memory with the sub-topic it
 * belongs to). We still surface L2 summaries opportunistically — when a
 * scene_name matches an L2 file by fuzzy token overlap we lift its richer
 * summary, otherwise we synthesise one from memory snippets.
 *
 * Memories without a scene_name are dropped entirely — no "Misc" container
 * in the graph.
 */
import { NextRequest, NextResponse } from "next/server";
import { queryL1ByIds, queryL0ByIds } from "@/lib/memory/store";
import { readSceneIndex, type SceneIndexEntry } from "@/lib/tencentdb/scene/scene-index";
import { getCurrentUserId } from "@/lib/auth-session";
import { getUserDataDir } from "@/lib/memory/user-scope";
import type { MemoryRecord } from "@/lib/tencentdb/record/l1-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

/**
 * Try to lift an L2 summary for a given L1 scene_name by token overlap with
 * the L2 file's title and summary. Returns null if no L2 file overlaps
 * meaningfully — caller will synthesise one from memory snippets instead.
 */
function pickL2Summary(
  sceneName: string,
  memoryContents: string[],
  l2Index: SceneIndexEntry[],
): SceneIndexEntry | null {
  const queryTokens = new Set<string>([
    ...tokenize(sceneName),
    ...memoryContents.slice(0, 3).flatMap((c) => tokenize(c.slice(0, 200))),
  ]);
  let best: SceneIndexEntry | null = null;
  let bestScore = 0;
  for (const entry of l2Index) {
    const title = entry.filename.replace(/\.md$/, "");
    const entryTokens = new Set<string>([...tokenize(title), ...tokenize(entry.summary)]);
    let score = 0;
    for (const t of queryTokens) if (entryTokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  // Require a minimum overlap so we don't claim a totally unrelated L2 block.
  return bestScore >= 3 ? best : null;
}

function synthesiseSceneSummary(mems: MemoryRecord[]): string {
  return mems
    .slice(0, 3)
    .map((m) => m.content.replace(/\s+/g, " ").trim().slice(0, 90))
    .join("； ");
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json<EvidenceResponse>({ scenes: [], memories: [], conversations: {} }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body?.memoryIds)
    ? (body.memoryIds as string[]).filter((s) => typeof s === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json<EvidenceResponse>({ scenes: [], memories: [], conversations: {} });
  }

  // ── 1. Load L1 records, preserve request order ──
  const l1Records = queryL1ByIds(ids);
  const byId = new Map(l1Records.map((r) => [r.id, r]));
  const orderedL1 = ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r);

  // ── 2. Group by L1 scene_name — this becomes our scene container set.
  // Memories without a scene_name are dropped (no MISC bucket). ──
  const grouped = new Map<string, MemoryRecord[]>();
  for (const m of orderedL1) {
    const key = (m.scene_name ?? "").trim();
    if (!key) continue;
    const arr = grouped.get(key);
    if (arr) arr.push(m);
    else grouped.set(key, [m]);
  }

  // ── 3. Build scene payloads, lifting an L2 summary when one fuzzy-matches. ──
  const l2Index = await readSceneIndex(getUserDataDir(userId));
  const sceneNameToFile = new Map<string, string>();
  const scenes: ScenePayload[] = [];
  for (const [sceneName, mems] of grouped) {
    const l2Match = pickL2Summary(
      sceneName,
      mems.map((m) => m.content),
      l2Index,
    );
    const summary = l2Match?.summary || synthesiseSceneSummary(mems);
    // The L1 scene_name itself becomes our stable scene identifier so the
    // graph node IDs survive re-renders. Strip filesystem-unsafe chars to
    // keep the id ReactFlow-friendly.
    const sceneFile = sceneName;
    sceneNameToFile.set(sceneName, sceneFile);
    scenes.push({
      filename: sceneFile,
      title: sceneName,
      summary,
      heat: l2Match?.heat ?? mems.length,
      memoryCount: mems.length,
      maxPriority: Math.max(...mems.map((m) => m.priority ?? 0)),
    });
  }
  scenes.sort((a, b) => b.maxPriority - a.maxPriority);

  // ── 4. Build per-memory payloads (only those that landed in a scene). ──
  const memories: MemoryPayload[] = [];
  for (const m of orderedL1) {
    const key = (m.scene_name ?? "").trim();
    if (!key) continue;
    memories.push({
      id: m.id,
      type: m.type,
      priority: m.priority,
      scene_name: m.scene_name ?? "",
      sceneFilename: sceneNameToFile.get(key) ?? null,
      content: m.content,
      createdAt: m.createdAt,
      sourceMessageIds: m.source_message_ids ?? [],
    });
  }

  // ── 5. Load the L0 messages cited by any included memory. ──
  const allL0Ids = [...new Set(memories.flatMap((m) => m.sourceMessageIds))];
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
