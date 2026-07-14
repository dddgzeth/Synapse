# Synapse MCP 优化改动记录

> 本次改动围绕 **MCP 跨工具记忆层** 进行优化，核心目标：
> 1. 外部工具数据不再混入 Web 聊天会话列表
> 2. 外部会话按 工具→项目→会话 三层结构展示，全量可浏览
> 3. MCP 接入流程从"按工具手动配置"改为"通用指令 + AI 代劳"
> 4. Hook 脚本传递工具原生 session_id 和项目上下文

---

## 一、Session Key 三级结构

**文件**: `app/api/[transport]/route.ts`

`extSessionKey` 从两级改为三级：

```
旧: chat_<userId>_ext_<source>
    例: chat_eq12_ext_claude-code

新: chat_<userId>_ext_<source>_<project>
    例: chat_eq12_ext_claude-code_synapse
```

- 无 `project` 参数时退化为旧格式（向后兼容已有数据）
- 每个 project 独立走 L1 管线（同项目对话关联度更高）

---

## 二、MCP 工具参数扩展

**文件**: `app/api/[transport]/route.ts`

`log_conversation` 和 `remember` 新增两个可选参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `project` | `string?` | 项目标识，由调用方从 `basename(cwd)` 派生 |
| `session_id` | `string?` | 工具原生 session ID，区分同一项目下不同对话 |

- `session_id` 有传则用工具原生 ID，没传则生成随机 UUID（向后兼容）
- 同一工具 session 多次调用会追加到同一 `session_id` 下

---

## 三、Hook 脚本传递 session 上下文

**文件**: `scripts/hooks/synapse_sync.py`

Stop 事件已包含 `session_id` 和 `cwd`，之前被丢弃。改为提取并传入：

```python
project = os.path.basename(cwd) if cwd else ""
session_id = payload.get("session_id", "")

"arguments": {
    "messages": messages,
    "source": source,
    "project": project,
    "session_id": session_id
}
```

---

## 四、侧边栏 Conversations 过滤外部会话

**文件**: `lib/memory/store.ts` — `listSessionsForUser`

SQL 查询加条件，排除外部会话：

```sql
WHERE session_key LIKE 'chat_<userId>%'
  AND session_key NOT LIKE '%\_ext\_%'
```

外部对话数据仍在 L0 中，可通过搜索访问。

---

## 五、新增 Store 查询函数

**文件**: `lib/memory/store.ts`

### `listExternalSessions(userId)`

从 L0 动态解析 `session_key` 中的 `_ext_<source>_<project>` 后缀，返回三层聚合：

```typescript
Array<{
  source: string;       // "claude-code"
  project: string;      // "synapse"
  sessionIds: Array<{
    sessionId: string;
    title: string;      // 第一条 user 消息
    messageCount: number;
    lastActive: number;
  }>;
}>
```

### `queryL0ForExternalSession(userId, source, project, sessionId, limit, offset)`

按 session_key + session_id 查询全量 L0 对话，支持分页。

---

## 六、侧边栏新增 Connected Tools 区块

**文件**: `components/sidebar.tsx`

在 Conversations 下方新增区块，三层树形结构：

```
🔌 Connected Tools
  ├─ 📂 Claude Code
  │   └─ synapse
  │       ├─ "关于FAIR数据标准的讨论" (45 msgs · 2h ago)
  │       ├─ "修复内存泄漏问题" (12 msgs · yesterday)
  │       └─ "重构搜索管线" (3 msgs · 3 days ago)
  ├─ 📂 Codex
  │   └─ synapse
  │       └─ "API设计讨论" (8 msgs · 5 days ago)
  └─ + Connect a tool
```

- **数据来源**: 从 L0 动态解析 `session_key` 中的 `_ext_<source>_<project>` 后缀
- **session 标题**: 该 session_id 下第一条 user 消息
- **点击 session** → 跳转 `/tools/<source>/<project>` 查看全量对话
- **点击 "+ Connect a tool"** → 打开 MCP 接入面板
- **来源/项目均动态发现**，不预设列表

---

## 七、全量对话浏览器页面

**文件**: `app/tools/[source]/[project]/page.tsx` (新建)

- 只读对话浏览，ReactMarkdown 渲染消息
- 顶部显示来源/项目名 + 消息数
- 按 session_id 分组，支持分页加载
- 无输入框，标注"只读归档"

---

## 八、连接状态 API

**文件**: `app/api/tools/status/route.ts` (新建)

```
GET /api/tools/status
```

返回外部工具会话的层级聚合：

```json
[
  {
    "source": "claude-code",
    "projects": [
      { "project": "synapse", "messageCount": 45, "lastActive": "2026-07-13T..." },
      { "project": "data-pipeline", "messageCount": 12, "lastActive": "2026-07-12T..." }
    ]
  }
]
```

数据来源：L0 按 `_ext_<source>_<project>` 分组聚合。

---

## 九、外部会话消息 API

**文件**: `app/api/tools/messages/route.ts` (新建)

```
GET /api/tools/messages?source=claude-code&project=synapse&session=abc-123&limit=50&offset=0
```

返回某个外部会话的全量 L0 消息，供对话浏览器页面使用。

---

## 十、McpTokensModal 改版

**文件**: `components/mcp-tokens-modal.tsx`

从"按工具列出配置片段"改为"通用连接指令"三步流程：

### Step 1: 创建 Token
- 生成 `syn_xxx` token，仅显示一次

### Step 2: 粘贴连接指令给 AI 工具
- 一段通用自然语言指令，包含 URL + Token
- 不预设工具列表，任何 MCP 兼容工具收到后自行配置
- 复制到剪贴板

### Step 3: (可选) 自动同步对话
- 下载 sync hook 脚本
- 或粘贴 hook 安装指令给 AI，让 AI 自己安装

要点：
- **不限定工具列表**（Claude Code / Codex / Cursor / 未来工具均适用）
- **不生成 shell 脚本**，而是自然语言让 AI 自行完成配置
- Token 管理功能保留（撤销、查看最后使用时间）

---

## 十一、搜索结果来源标记

**文件**: `app/api/search/route.ts`

搜索结果中 `session_key` 包含 `_ext_` 的记录，新增 `sourceLabel` 字段：

```json
{
  "sourceLabel": "Claude Code / synapse",
  "sessionTitle": "关于FAIR数据标准的讨论"
}
```

从 `session_key` 解析 `source` 和 `project` 拼接，前端显示为来源标签。

---

## 十二、i18n 补充

**文件**: `components/i18n.tsx`

新增翻译 key：

| Key | 中文 | English |
|---|---|---|
| `readOnlyArchive` | 只读归档 | Read-only archive |

---

## 改动文件清单

| # | 文件 | 操作 | 说明 |
|---|---|---|---|
| 1 | `app/api/[transport]/route.ts` | 修改 | session_key 三级结构 + MCP 工具加 project/session_id 参数 |
| 2 | `scripts/hooks/synapse_sync.py` | 修改 | 传递 session_id + project |
| 3 | `lib/memory/store.ts` | 修改 | 过滤外部会话 + 新增 listExternalSessions / queryL0ForExternalSession |
| 4 | `components/sidebar.tsx` | 修改 | 新增 Connected Tools 区块 + 搜索结果来源标签 |
| 5 | `components/mcp-tokens-modal.tsx` | 修改 | 改版为通用连接指令 |
| 6 | `app/api/search/route.ts` | 修改 | 搜索结果加 sourceLabel |
| 7 | `components/i18n.tsx` | 修改 | 新增 readOnlyArchive 翻译 |
| 8 | `app/tools/[source]/[project]/page.tsx` | 新建 | 全量对话浏览器（只读） |
| 9 | `app/api/tools/status/route.ts` | 新建 | 连接状态 API |
| 10 | `app/api/tools/messages/route.ts` | 新建 | 外部会话消息 API |


---

## 数据流全景

```
Claude Code (session_id=abc, cwd=/home/user/Synapse)
  └─ Stop hook (synapse_sync.py)
      └─ log_conversation(source="claude-code", project="synapse", session_id="abc")
          └─ session_key = chat_user_ext_claude-code_synapse
          └─ session_id  = abc
          └─ L0 写入 → embed-queue → scheduler → L1 → L2/L3 → Aha

侧边栏:
  Conversations (不含 _ext_)
  Connected Tools
    └─ Claude Code → synapse → "对话标题" (abc, 45 msgs)
                                           └─ 点击 → /tools/claude-code/synapse
                                                     → GET /api/tools/messages
                                                     → 全量对话渲染（只读）

MCP 接入:
  McpTokensModal → Step 1: 生成 token
                 → Step 2: 复制通用指令 → 粘贴给任意 AI 工具
                 → Step 3: (可选) 安装 sync hook
```

---

# LLM 后端解耦 & 长会话上下文管理

> 以下改动围绕 **方向 D：LLM 后端解耦** 和 **长会话上下文管理** 进行，
> 核心目标：
> 1. 抽象 LLMProvider 接口，fucheers / anthropic / openai 三种后端对等支持
> 2. 去掉 fucheers 代理后，图片+工具可同时发送，流式 tool_call 正常工作
> 3. 50+ 轮长对话不再撑爆 context window，预防性摘要自动触发

---

## 十四、LLMProvider 接口抽象

**文件**: `lib/llm/provider.ts` (新建)

统一三种 LLM 后端的调用接口，所有 LLM 调用方不再直接拼 `baseURL` / `createOpenAI` / 判断 `/v1` 后缀。

### 接口定义

```typescript
interface LLMProvider {
  config: LLMConfig;
  capabilities: LLMCapabilities;  // streamingToolCalls, imagesWithTools
  chat(params): Promise<ChatResult>;    // 一次性调用（带可选工具）
  createModel(): any;                    // 供 generateText/streamText 使用
}
```

### 三种后端

| 后端 | 实现 | capabilities | 说明 |
|---|---|---|---|
| `fucheers` | `OpenAICompatibleProvider` | `streamingToolCalls: false`<br>`imagesWithTools: false` | OpenAI 兼容代理，非流式工具循环 + 图片转写 workaround |
| `anthropic` | `AnthropicProvider` | `streamingToolCalls: true`<br>`imagesWithTools: true` | 直连 Anthropic API，`@ai-sdk/anthropic` |
| `openai` | `OpenAICompatibleProvider` | `streamingToolCalls: true`<br>`imagesWithTools: true` | 直连 OpenAI API，`@ai-sdk/openai` |

### 能力驱动的差异处理

`capabilities` 标志让调用方无需 if/else 判断后端类型：

- `imagesWithTools = false`（仅 fucheers）→ 图片先转写为文字再进工具循环
- `imagesWithTools = true`（anthropic / openai）→ 图片直接发给模型，跳过转写

### 环境变量配置

```bash
LLM_PROVIDER=fucheers  # "fucheers" | "anthropic" | "openai"

# fucheers（默认，向后兼容）
ANTHROPIC_BASE_URL=https://www.fucheers.top
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6

# anthropic 直连
ANTHROPIC_API_KEY=   # 复用上面的值
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ANTHROPIC_BASE_URL=  # 留空 = 官方 API

# openai 直连
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 工厂 & 单例

```typescript
getLLMProvider()                        // 从环境变量创建单例
createLLMProviderFromOverride(settings) // 从前端设置覆盖创建临时实例
```

---

## 十五、全站 LLM 调用重构

### chat-loop.ts — 工具循环主入口

**改动**:
- 移除 raw `fetch` 到 `/chat/completions` 的直接调用
- 移除 `ApiResponseError` 类
- `RunChatLoopParams` 从 `baseURL, apiKey, model, fetchImpl` 改为 `provider: LLMProvider`
- `callFucheers` → `callLLM`，统一用 `provider.chat()`
- `compactOnce` 也改用 `provider.chat()` 做摘要
- 工具调用解析从 `tc.function.name` 改为 `tc.name`（`ChatResult` 格式）

### chat/route.ts — 主聊天路由

**改动**:
- 移除手动 `createOpenAI` + `createProxyFetch()`
- 改用 `createLLMProviderFromOverride(apiSettings)` 一行创建 provider
- 图片转写改为**按 capability 条件触发**：

```typescript
const needsTranscription = !provider.capabilities.imagesWithTools;
// fucheers → needsTranscription = true（保持原行为）
// anthropic/openai → needsTranscription = false（跳过转写，图片直接发）
```

- 视觉转写调用改用 `provider.createModel()` 而非 `provider.chat(model)`

### 其他 6 个文件统一改用 getLLMProvider()

| 文件 | 原调用方式 | 改后 |
|---|---|---|
| `lib/memory/insights/context-analyzer.ts` | `createOpenAI` (未导入，编译报错) | `getLLMProvider()` |
| `lib/memory/insights/theme-detector.ts` | 同上 | `getLLMProvider()` |
| `lib/tencentdb/runtime/tool-runner.ts` | 手动 `createOpenAI` + model 创建 | `getLLMProvider()` |
| `app/api/page-render/route.ts` | 已用 `createLLMProviderFromOverride` | 加 `provider` 字段 |
| `lib/memory/llm-runner.ts` | 手动创建 | `getLLMProvider()` |
| `lib/memory/aha.ts` | 手动创建 | `getLLMProvider()` |

---

## 十六、前端 Provider 选择面板

**文件**: `components/sidebar.tsx`, `components/i18n.tsx`

在 API 设置弹窗中新增 Provider 下拉选择：

```
┌─ API Settings ─────────────────────┐
│ Provider: [默认（环境变量）      ▼] │
│   ├ 默认（环境变量）                │
│   ├ fucheers（代理）                │
│   ├ Anthropic（直连）               │
│   └ OpenAI（直连）                  │
│ API Key:  [_______________]         │
│ Base URL: [_______________]         │
│ Model:    [_______________]         │
└─────────────────────────────────────┘
```

- `ApiSettings` 接口新增 `provider: string` 字段
- `getApiSettingsForRequest` 传递 `provider` 到后端
- 留空 = 使用服务器环境变量配置（向后兼容）
- 中英文翻译已添加

---

## 十七、长会话上下文管理 — 预防性对话摘要

**文件**: `lib/memory/chat-loop.ts`

### 问题

原 `compactOnce` 只在 API 返回 context-window 错误时**反应式**压缩单个工具结果。50+ 轮长对话的历史消息会直接撑满 context window，没有预防机制。

### 两层防御

| 层级 | 函数 | 触发时机 | 作用对象 |
|---|---|---|---|
| **预防层**（新） | `compactConversationHistory` | 每次 LLM 调用前，总字符 > 100k | 旧的用户/助手对话消息 |
| **反应层**（原有） | `compactOnce` | API 返回 context 错误时 | 单个最大的工具结果 |

### compactConversationHistory 设计

```
阈值: 100,000 字符（对 128k token GPT-4o 和 200k token Claude 都安全）
保留窗口: 最近 6 条消息始终完整保留
安全切分: findSafeSplitPoint 确保不在 tool_call → tool_result 之间切断
累积摘要: 旧摘要消息会被包含在新摘要中，支持多次叠加
降级兜底: 摘要 LLM 失败 → 保留首尾各 2 条消息做硬截断
```

流程：
```
messages = [msg1, msg2, ..., msg20, msg21, ..., msg26]
                                        ↑ splitIdx（安全切分点）
           └─── oldMessages ───┘  └── recentMessages ──┘
                    │                       │
                    ▼                       │
           provider.chat(摘要)              │
                    │                       │
                    ▼                       │
           [摘要消息] + recentMessages ─────┘
```

### 每步检查

在 `runChatLoop` 的**每个 step** 开头调用 `compactConversationHistory`（不仅仅是 step 0），因为工具结果会在循环中持续增大上下文。检查本身很便宜（字符计数），只有超阈值时才触发 LLM 摘要调用。

---

## 十八、对话摘要 UI 反馈

**文件**: `components/message-bubble.tsx`, `components/i18n.tsx`, `app/api/chat/route.ts`

新增 `conversation-summarized` 事件类型，与工具结果压缩（`compaction`）区分：

```typescript
| { kind: "conversation-summarized"; beforeChars: number; afterChars: number; summarizedMessages: number }
```

前端渲染蓝色提示条（区别于工具压缩的黄色提示条）：

```
🗜️ 上下文超出预算，已压缩 · 120k → 65k (-46%)    ← 工具结果压缩（黄色）
📝 长对话已自动摘要 · 120k → 65k (-46%)           ← 对话摘要（蓝色）
```

- `SummaryRow` 组件：蓝色背景，显示前后字符数 + 压缩比
- 中英文翻译：`conversationSummarized: "长对话已自动摘要"` / `"Long conversation summarized"`
- Route handler 将事件通过 `data-progress` SSE 推送到浏览器

---

## 改动文件清单（LLM 解耦 + 长会话管理）

| # | 文件 | 操作 | 说明 |
|---|---|---|---|
| 1 | `lib/llm/provider.ts` | **新建** | LLMProvider 接口 + 三种后端实现 + 工厂/单例 |
| 2 | `lib/memory/chat-loop.ts` | 修改 | provider.chat() 替换 fetch + 新增 compactConversationHistory |
| 3 | `app/api/chat/route.ts` | 修改 | createLLMProviderFromOverride + 图片转写按 capability 条件触发 |
| 4 | `lib/memory/insights/context-analyzer.ts` | 修改 | 修复 createOpenAI 缺失 → getLLMProvider() |
| 5 | `lib/memory/insights/theme-detector.ts` | 修改 | 同上 |
| 6 | `lib/tencentdb/runtime/tool-runner.ts` | 修改 | getLLMProvider() |
| 7 | `app/api/page-render/route.ts` | 修改 | ApiSettingsOverride 加 provider 字段 |
| 8 | `lib/memory/llm-runner.ts` | 修改 | getLLMProvider() |
| 9 | `lib/memory/aha.ts` | 修改 | getLLMProvider() |
| 10 | `components/sidebar.tsx` | 修改 | Provider 下拉选择 + ApiSettings 类型 |
| 11 | `components/i18n.tsx` | 修改 | provider 翻译 + conversationSummarized 翻译 |
| 12 | `components/message-bubble.tsx` | 修改 | conversation-summarized 事件 + SummaryRow 组件 |
| 13 | `.env.example` | 修改 | 新增 LLM_PROVIDER / OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL |
| 14 | `tsconfig.json` | **新建** | Next.js 14 标准 TypeScript 配置 |

---

## LLM 调用数据流

```
环境变量 (LLM_PROVIDER=anthropic)
  └─ getLLMConfig() → LLMConfig { type, baseURL, apiKey, model }
      └─ createLLMProvider() → AnthropicProvider | OpenAICompatibleProvider
          └─ getLLMProvider() → 单例

前端设置 (provider="openai", apiKey="sk-...")
  └─ createLLMProviderFromOverride(apiSettings)
      └─ 临时 provider 实例（不污染单例）

chat-loop.ts:
  ┌─ compactConversationHistory(messages, provider)  ← 预防性摘要
  │   └─ 总字符 > 100k? → provider.chat(摘要) → 替换旧消息
  ├─ provider.chat({ systemPrompt, messages, tools })
  │   ├─ fucheers/openai: raw fetch /chat/completions
  │   └─ anthropic: generateText + @ai-sdk/anthropic
  ├─ 有 tool_calls? → 执行工具 → 追加 tool_result → 循环
  └─ 无 tool_calls? → 返回最终文本
      └─ 如果途中 API 返回 context 错误:
          └─ compactOnce(provider.chat 压缩最大工具结果) → 重试
```
