/**
 * L1 Conflict Detection Prompt — copied from TencentDB Agent Memory.
 *
 * Only change: type names in prompt text → research types.
 */

import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `你是研究记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

## 核心规则

- **跨 type 合并**：不同 type 的记忆如果语义上描述同一事实/研究内容，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。

## 判断逻辑

1. **判断是否同一研究内容**：主体相同、主题一致、scene_name 相似

2. **选择动作**：
   - "store"：新信息，新增当前记忆。
   - "skip"：已有记忆更好，忽略当前记忆。
   - "update"：同一事实，新记忆更优（更具体、更晚或纠错）。
   - "merge"：同一研究内容，多条记忆互补，合并成一条更完整记忆。

3. **timestamp 处理**：merge/update 时，merged_timestamps 包含所有相关记忆的时间戳并集。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type（claim|method|observation|dataset|experiment|finding|question|goal）",
    "merged_priority": 85,
    "merged_timestamps": ["时间戳数组（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID 数组。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：合并后的 type。
- merged_priority：合并后优先级（0-100 整数）。
- merged_timestamps：收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;

// ============================
// Types + Prompt Builder (identical to TencentDB)
// ============================

export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  const poolSection = poolList.length === 0
    ? "## 统一候选记忆池\n\n（空，所有新记忆直接 store）"
    : `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${JSON.stringify(poolList, null, 2)}`;

  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote = relatedIds.length > 0
      ? JSON.stringify(relatedIds)
      : "[]（无相似候选，直接 store）";

    const memStr = JSON.stringify({
      record_id: m.newMemory.record_id,
      content: m.newMemory.content,
      type: m.newMemory.type,
      priority: m.newMemory.priority,
    }, null, 2);

    return `### 新记忆 ${idx + 1}\n${memStr}\n相关候选 ID：${relatedNote}`;
  });

  return `${poolSection}\n\n---\n\n## 待处理的新记忆（共 ${matches.length} 条）\n\n${memoryParts.join("\n\n")}`;
}
