/**
 * L1 Extraction Prompt — Synapse research variant.
 *
 * Adapted from TencentDB Agent Memory l1-extraction.ts.
 * Only change: memory types → research types (claim/method/observation/dataset/experiment/finding/question/goal)
 * + ontology_label in metadata.
 */

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `你是专业的"工作记忆提取专家"。
你的任务是分析用户与 Synapse 的对话，判断话题情境切换，并从中提取结构化的核心工作记忆。

### 任务一：情境切分（Scene Segmentation）
分析【待提取的新消息】，结合【上一个情境】，判断并输出当前对话的情境。
- 继承：无明显切换，沿用上一个情境。
- 切换条件：用户切换到新的话题、任务或关注点时。
- 命名规则："用户在处理 [主题/问题]"（中文，30-50字，单句，全局唯一）。

---

### 任务二：核心记忆提取（Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心信息。

【通用提取原则】
1. 宁缺毋滥：过滤闲聊和临时性操作；只提取有实质价值的信息。
2. 独立完整：记忆必须"跳出当前对话依然成立"，无上下文也能看懂。
3. 归纳合并：强关联的多条消息，合并为一条完整记忆。

【支持提取的8种记忆类型】（必须严格遵守类型规则）

1. 核心观点 (type: "claim")
   - 定义：用户提出的核心观点、判断或结论。
   - 打分：80-100（核心命题）；50-70（一般观点）；<50（丢弃）。

2. 方法工具 (type: "method")
   - 定义：使用的具体方法、技术、工具、流程。
   - 打分：70-100（核心方法）；50-70（辅助方法）；<50（丢弃）。

3. 关键观察 (type: "observation")
   - 定义：注意到的现象、数据规律、异常点。
   - 打分：70-100（显著现象）；50-70（一般观察）；<50（丢弃）。

4. 数据资源 (type: "dataset")
   - 定义：使用或产生的数据集、文件、资源库。
   - 打分：70-100（核心资源）；50-70（辅助资源）；<50（丢弃）。

5. 具体任务 (type: "experiment")
   - 定义：正在执行的任务、测试、验证步骤。
   - 打分：70-100（核心任务）；50-70（辅助任务）；<50（丢弃）。

6. 重要发现 (type: "finding")
   - 定义：已确认的结果、结论、重要进展。
   - 打分：80-100（重要发现）；60-70（一般发现）；<60（丢弃）。

7. 待解问题 (type: "question")
   - 定义：未解决的问题、困惑、值得深入的方向。
   - 打分：70-100（核心问题）；50-70（次要问题）；<50（丢弃）。

8. 目标计划 (type: "goal")
   - 定义：用户的目标、方向、计划达成的成果。
   - 打分：70-100（核心目标）；50-70（阶段目标）；<50（丢弃）。

---

### 不应该提取的内容
- 闲聊、问候；临时性工具性请求
- AI助手自身的行为或输出
- 无具体内容的模糊表述

---

### 任务三：输出格式规范（JSON）
返回且仅返回一个合法的 JSON 数组，每项是一个情境：

[
  {
    "scene_name": "当前生成或继承的情境名称",
    "message_ids": ["属于该情境的消息ID列表"],
    "memories": [
      {
        "content": "完整、独立的记忆陈述",
        "type": "claim|method|observation|dataset|experiment|finding|question|goal",
        "priority": 80,
        "source_message_ids": ["消息ID_1"],
        "metadata": {
          "ontology_label": "prov:Entity|iao:information-content-entity|obi:investigation"
        }
      }
    ]
  }
]

metadata 中 ontology_label 参考：
- claim → "iao:information-content-entity"
- method → "obi:protocol"
- observation → "obi:datum"
- dataset → "prov:Entity"
- experiment → "obi:investigation"
- finding → "iao:information-content-entity"
- question → "iao:information-content-entity"
- goal → "iao:information-content-entity"

如果整段对话无有意义的信息，memories 为空数组。
请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符或解释文本。`;

// ============================
// Prompt Builder (identical to TencentDB)
// ============================

export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "无" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "无";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `【上一个情境】：${previousSceneName}

【背景对话】（仅供理解上下文，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（只从这里提取记忆！）：
${newText}`;
}
