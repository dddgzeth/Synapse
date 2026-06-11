# Synapse — 你的第二记忆

> 带长期记忆的研究助理 chatbot。本地跑、本地存，所有对话沉淀成可溯源的研究画像。

像和普通助手聊天一样正常对话——挂载本地文件夹、提问、获得回答。Synapse 在后台把对话切成结构化记忆（L0→L1→L2→L3）。偶尔，在一次很平常的回复里，它会悄悄浮出一段话：*「Synapse 注意到——过去 9 天里，你在 10 个不同的研究线索里反复触碰同一个未解问题……」*——不是按钮触发的，是积累到一定厚度后被动出现的。

**[English README → README.md](README.md)**

---

## Demo 视频

[![Demo Video](https://img.youtube.com/vi/3FjaOnHsJBY/maxresdefault.jpg)](https://www.youtube.com/watch?v=3FjaOnHsJBY)

▶ **[在 YouTube 观看 72 秒产品 Demo](https://www.youtube.com/watch?v=3FjaOnHsJBY)**

---

## 界面截图

### 主页 — 空状态，随时连接你的本地文件夹

![主页](public/screenshots/home.jpg)

### 对话 — 每条回复都基于记忆召回

Synapse 在每次回复前都会搜索你积累的记忆，搜索过程内联显示，你可以看到具体用了哪些上下文。

![对话中的记忆搜索](public/screenshots/chat-thinking.jpg)

![对话回复](public/screenshots/chat-response.jpg)

### Deep Research — 按需触发的文献 + 网络检索

点击 ⚡ **Deep Research**，把当前问题发给一个自主研究模型，它会搜索 Semantic Scholar、arXiv 和网络，再结合你已有的记忆综合分析。

![Deep Research 进行中](public/screenshots/deep-research-progress.jpg)

![Deep Research — 15 条并行搜索](public/screenshots/deep-research-steps.jpg)

![Deep Research — 结构化报告输出](public/screenshots/deep-research-result.jpg)

### Aha — 被动浮现的研究发现

对话积累到一定量后，Synapse 在后台扫描跨来源的模式。当你下次提问触及相关方向，一张 **「Synapse 注意到」** 卡片会内联出现——并附带一张可拖拽的证据图，把每条洞察追溯到原始来源。

![Aha 时刻与证据图](public/screenshots/aha-evidence.jpg)

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env.local   # 填入下方的变量值

# 3. 启动开发服务器
npm run dev      # http://localhost:3000
```

### 环境变量（`.env.local`）

```
# 主对话 + 所有 L1/L2/L3 抽取 + Aha 合成
ANTHROPIC_BASE_URL=https://你的-claude-代理/
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6

# Deep Research（用户主动触发）
MIROMIND_BASE_URL=https://api.miromind.ai/v1
MIROMIND_API_KEY=sk-xxx
MIROMIND_MODEL=mirothinker-1-7-deepresearch-mini

# SQLite 数据目录（默认 ./data）
TDAI_DATA_DIR=/你的/synapse-data路径
```

---

## 整体架构

```
┌─────────────────── 浏览器（Client）─────────────────────┐
│                                                          │
│  Sidebar           ChatPanel             AhaModal        │
│  • 本地文件夹       • useChat hook        • 浮层证据图   │
│  • 历史发现         • 工具回路 (toolUI)   • xyflow 节点  │
│  • 记忆 / 场景      • 文件 attach        • 可拖拽       │
│                                                          │
│  IndexedDB:                                              │
│  • synapse_folders  (FileSystemDirectoryHandle 缓存)     │
│  • synapse_pdf_cache (PDF 解析结果)                      │
│                                                          │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP (Next.js Route Handlers)
┌──────────────────────────▼───────────────────────────────┐
│                      Server (Node)                        │
│                                                           │
│  /api/chat           ── 主对话 + Aha judge + L0 落库      │
│  /api/pipeline/flush ── 强制冲 L1（用户回归时）           │
│  /api/aha/*          ── 历史 / 详情 / evidence            │
│  /api/memories       ── 侧栏数据（L0/L1/L2/L3）           │
│  /api/scene/[name]   ── 场景块详情                        │
│  /api/insight        ── Deep Research                     │
│                                                           │
│  scheduler.notifyTurn  ─→  l1-pipeline                    │
│        ↓ (≥5 turn 或 flush)        ↓ (≥3 new mem 后)      │
│        计数+互斥锁              l2-l3-pipeline + aha 检测  │
│                                                           │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  本地存储                                                  │
│  • SQLite (memory.db)   ── L0 对话 / L1 记忆 / state      │
│  • scene_blocks/*.md    ── L2 场景块                      │
│  • persona.md           ── L3 画像                        │
│  • backup/              ── 自动版本快照                   │
│                                                           │
│  外部 API（按需）                                          │
│  • Claude 兼容代理  ── 主对话 + 所有抽取                  │
│  • miromind         ── Deep Research                      │
│  • Semantic Scholar / arXiv ── Aha 外部文献补足           │
└────────────────────────────────────────────────────────────┘
```

---

## 记忆系统：L0 → L1 → L2 → L3

照搬 [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 的四层结构，只改两处：L1 类型换成研究语境、`MemoryRecord.metadata` 加 `ontology_label`。

| 层 | 是什么 | 物理存储 | 谁写 | 谁读 |
|---|---|---|---|---|
| **L0** | 原始对话（每条 user / assistant message） | SQLite `l0_conversations` + FTS5 trigram | `/api/chat` onFinish | recall、Aha evidence |
| **L1** | 原子研究记忆（claim / method / observation / dataset / experiment / finding / question / goal） | SQLite `l1_records` + FTS5 trigram | `l1-pipeline`（每 5 turn 或 flush） | 侧边栏、recall、Aha 检测 |
| **L2** | 主题场景块（围绕一个研究方向聚合相关 L1） | `scene_blocks/*.md` | `l2-l3-pipeline`（每攒够 3 条新 L1） | 侧边栏、evidence graph |
| **L3** | 稳定研究者画像 | `persona.md` | `persona-generator`（场景累计变化达阈值） | 主对话 system prompt |

### 触发：纯计数 + 互斥锁，无时间触发

```
每次 /api/chat onFinish:
  scheduler.notifyTurn(sessionKey)
    turnCount++
    if turnCount >= 5:
       runL1Pipeline()  ← 加 l1Running mutex
       if newMemoriesSinceLastL2 >= 3:
         runL2L3Pipeline()  ← 加 l2Running mutex
         runAhaDetection()
       turnCount = 0
```

不存在「空闲 N 分钟触发」之类的定时器。用户回到 chat 时 `synapse-app.tsx` 自动 POST `/api/pipeline/flush` 一次，把残留 turn 冲掉。

---

## 记忆召回：让每条回复都有依据

每轮对话前，Synapse 都会召回相关记忆并决定怎么用——这跟后台的 Aha 检测是两套独立逻辑，召回是**每轮**都跑、给回复打底。分三层：

**1. 召回 (`lib/memory/recall.ts`)** —— 每条用户消息进来：
- **L3 画像** (`persona.md`)：永远注入，不需要匹配——它是常驻的「你是谁」档案。
- **L1 记忆**：用 FTS 搜出与当前消息最相关的 8 条（用户级全局，跨所有会话）。
- 把两者交给关系分析器。

**2. 关系分析 (`lib/memory/insights/context-analyzer.ts`)** —— 一次轻量 LLM 调用，给每条召回记忆打标签：
- `connection` 🔗 —— 有信息量的关联（同项目的早期决策、同概念的较早讨论）。
- `contradiction` ⚠️ —— 真冲突（你改了主意、用了相反方案）。
- 其余一律丢弃——prompt 强制「宁缺毋滥」，空结果合法且常见。

**3. 注入** —— `formatRecallContext` 把 `<researcher-profile>` + `<relevant-research-memories>` + `<noteworthy-links>` 拼好，`/api/chat` 再接进 system prompt。其中 `<noteworthy-links>` 明确指示主对话 LLM：**在回答完主要问题之后**，用很轻的笔触自然地点一下 1-2 条关联或冲突（「顺便注意到，这跟你之前的 X 有连续性」／「上次你倾向 A，这次改主意了吗？」），如果都不自然就全部忽略。

这是即时的「我记得你提过…」那一层，跟 Aha 不同：召回每轮都跑、给回复打底；Aha 在后台跑、把跨场景模式做成卡片浮现。

---

## Aha：被动浮出的研究观察

不是「按钮 → 生成」，是后台扫描 L1 时发现「同一想法跨 ≥3 个来源、跨度 ≥3 天反复出现」时，自动合成一段三段式（observation / hypothesis / reframe），等用户下次发了相关问题时 inline 推送，并往侧边栏挂一个 ✨「新发现」徽章。

**完整链路：**

1. `runAhaDetection`（L1 完成后跑）扫 L1，找跨源记忆 ≥3 条 + 跨度 ≥3 天 → 写 `aha_pending` + `aha_last` + `aha_history`
2. 用户下次发消息时 `shouldFireAhaLLM`（LLM 判官）判断当前 query 是否相关 → YES 才 inline 注入
3. 侧边栏轮询 `/api/aha/last` 看 unseen → 显示 ✨「新发现」脉冲徽章
4. 点徽章 → `AhaModal` 浮层 + `EvidenceGraph` 拖拽式证据图
5. 侧边栏「✨ 历史发现」区永久列出每条 Aha，随时回看

**外部文献补足**：合成 Aha 时把 pattern 蒸馏成英文关键词去 Semantic Scholar + arXiv 各捞一条支撑文献，挂在 `externalSources` 上——失败不影响 Aha 本身。

---

## 文件同步：仅元数据 + LLM 主动读取

**关键约束**：文件夹同步**不会**自动把文件内容塞进数据库。

```
连接文件夹 → 浏览器 File System Access API → IndexedDB 缓存 handle
扫描树 → 收集 metadata（路径/大小/扩展名） → 推送 synced-files-bus
chat 请求 body 只带 metadata（≤5KB）

如果 LLM 觉得需要某个文件，主动调 read_synced_file(path)
→ 服务端流暂停 → 浏览器 FileSystemFileHandle 读文件 → 走两轮 HTTP 回客户端
→ 再恢复 LLM 流，把内容当 tool result 喂回去
```

只有当用户**实际让 LLM 读过**某文件、并在这次对话里讨论了，对话本身才作为 L0 落库——文件本身永远不进 L0。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 14（App Router） | RSC + Route Handlers |
| 主对话 LLM | `claude-sonnet-4-6` via OpenAI 兼容代理 | 流式 + tool_call 有 bug，已用 `lib/memory/chat-loop.ts` 手写绕过 |
| Deep Research LLM | `mirothinker-1-7-deepresearch-mini` | 用户主动触发 |
| AI SDK | `ai` v6 + `@ai-sdk/openai` v3 | `useChat` + `DefaultChatTransport` |
| 数据库 | `better-sqlite3` + FTS5 trigram tokenizer | 支持中文全文搜索 |
| 图可视化 | `@xyflow/react` v12 | Aha 证据图 |
| PDF 解析 | `pdfjs-dist` v5 | 浏览器端懒加载 |
| 外部检索 | Semantic Scholar API + arXiv API | 直接 fetch，无 SDK |
