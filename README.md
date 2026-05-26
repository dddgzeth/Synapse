# Synapse

> 带长期记忆的研究助理 chatbot。本地跑、本地存，所有对话沉淀成可溯源的研究画像。

研究者像和 Claude 一样正常聊天、挂本地文件夹、提问。Synapse 在后台把对话切成结构化记忆（L0→L1→L2→L3），偶尔在普通回复里悄悄浮出一段「我注意到你最近的想法在收敛于 X」的观察 — 不是按钮触发的，是积累到一定厚度后被动出现。

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制并填值）
cp .env.local.example .env.local   # 见下方变量清单

# 3. 启动开发服务器
npm run dev      # http://localhost:3000

# 测试
npm test                         # vitest 单测
node scripts/test-scheduler.mjs  # 端到端 scheduler 测试（需先 npm run dev）
npm run acceptance               # 完整接受测试
```

### 环境变量（`.env.local`）

```
# 主对话 + 所有 L1/L2/L3 抽取 + Aha 合成
ANTHROPIC_BASE_URL=https://www.fucheers.top
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6

# Deep Research（用户主动触发）
MIROMIND_BASE_URL=https://api.miromind.ai/v1
MIROMIND_API_KEY=sk-xxx
MIROMIND_MODEL=mirothinker-1-7-deepresearch-mini

# SQLite 数据目录（默认 ./data）
TDAI_DATA_DIR=/Users/you/synapse-data
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
│                                                            │
│  /api/chat           ── 主对话 + Aha judge + L0 落库      │
│  /api/pipeline/flush ── 强制冲 L1（用户回归时）           │
│  /api/aha/*          ── 历史 / 详情 / evidence            │
│  /api/memories       ── 侧栏拉记忆 + 场景 + persona       │
│  /api/scene/[name]   ── 场景块详情                        │
│  /api/insight        ── Deep Research (miromind)          │
│                                                            │
│  scheduler.notifyTurn  ─→  l1-pipeline                     │
│        ↓ (≥5 turn 或 flush)        ↓ (≥3 new mem 后)      │
│        计数+互斥锁              l2-l3-pipeline + aha 检测  │
│                                                            │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  本地存储                                                  │
│  • SQLite (data/memory.db) ── L0 对话 / L1 记忆 / state   │
│  • scene_blocks/*.md       ── L2 场景块                   │
│  • persona.md              ── L3 画像                     │
│  • backup/                 ── 自动版本快照                │
│                                                            │
│  外部 API（按需）                                          │
│  • fucheers.top  ── Claude 主对话 + 所有抽取              │
│  • miromind      ── Deep Research                         │
│  • Semantic Scholar / arXiv ── Aha 外部文献补足           │
└────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
Synapse/
├── app/                       Next.js 14 App Router
│   ├── api/                   服务端路由
│   │   ├── chat/              主对话流（onFinish 触发 scheduler）
│   │   ├── pipeline/flush/    用户回归时强冲 L1 batch
│   │   ├── aha/               Aha 全部接口
│   │   │   ├── last/          最新一条 + unseen 标志
│   │   │   ├── history/       历史列表（最近 50 条）
│   │   │   ├── [id]/          按 id 取具体 Aha
│   │   │   ├── evidence/      取 supportingMemoryIds → 场景 + 记忆 + 对话
│   │   │   └── seen/          标记已看，清侧边栏徽章
│   │   ├── memories/          侧边栏数据（L0/L1 count + L2/L3 + 最近 L1）
│   │   ├── memory/[id]/       单条 L1 详情（modal 用）
│   │   ├── scene/[filename]/  单个 L2 场景块详情
│   │   ├── search/            FTS 搜索（L0+L1 trigram）
│   │   └── insight/           Deep Research 入口（miromind）
│   ├── page.tsx               主页（聊天）
│   ├── persona/page.tsx       L3 画像独立页
│   ├── scenes/[filename]/page.tsx  L2 场景块独立页
│   ├── memories/[id]/page.tsx      L1 记忆独立页
│   ├── aha-mock/page.tsx      Aha 调试预览页
│   └── layout.tsx             AppShell 包装（侧栏 + AhaModal 全局挂载）
│
├── components/                React 组件
│   ├── synapse-app.tsx        聊天列（mount 时调 flush）
│   ├── chat-panel.tsx         useChat + 工具回路 + 附件管理
│   ├── message-bubble.tsx     单条消息渲染（含 inline Aha 卡）
│   ├── sidebar.tsx            侧边栏（文件夹/历史发现/场景/记忆）
│   ├── app-shell.tsx          全局壳（挂 AhaModal、DetailModal、DeepResearchModal）
│   ├── aha-modal.tsx          Aha 浮层（监听 synapse:open-aha）
│   ├── evidence-graph.tsx     证据图（xyflow，可拖拽，无重叠）
│   ├── evidence-drawer.tsx    点节点弹出的右侧详情抽屉
│   ├── detail-modal.tsx       L1 记忆 / L2 场景的浮层
│   └── deep-research-modal.tsx Deep Research 浮层
│
├── lib/
│   ├── memory/                Synapse 自写的记忆调度层
│   │   ├── store.ts           SQLite schema + L0/L1/state/aha_history 操作
│   │   ├── scheduler.ts       计数+互斥锁，无时间触发
│   │   ├── l1-pipeline.ts     对话 → 原子记忆（含 dedup）
│   │   ├── l2-l3-pipeline.ts  记忆 → 场景块 → persona
│   │   ├── aha.ts             Aha 检测 + LLM judge + 外部文献补足
│   │   ├── recall.ts          召回（hybrid: FTS + 最近 + 高优先级）
│   │   ├── chat-loop.ts       fucheers 代理流式 + tool_call 的手写循环
│   │   ├── search-tools.ts    LLM 可调用的 tool: 搜对话/搜记忆
│   │   └── synced-file-tools.ts LLM 可调用的 tool: list/read 同步文件
│   │
│   ├── tencentdb/             从 TencentDB Agent Memory 移植的核心模块
│   │   ├── prompts/           L1 抽取/dedup/场景/画像 prompt（已改成研究语境）
│   │   ├── record/l1-writer.ts L1 写入 + MemoryRecord 类型
│   │   ├── scene/             场景抽取 / 格式化 / 索引 / 导航
│   │   ├── persona/           画像生成 + 触发条件
│   │   ├── runtime/           工具运行时（LLM-as-tool 调度）
│   │   ├── store/search-utils.ts FTS 查询构造
│   │   └── utils/             backup + checkpoint + sanitize
│   │
│   ├── search/external.ts     Semantic Scholar + arXiv 客户端
│   ├── folder-cache.ts        IndexedDB 文件夹句柄缓存
│   ├── synced-files.ts        文件树扫描 + 元数据收集
│   ├── synced-files-cache.ts  PDF 解析结果 IndexedDB 缓存
│   ├── synced-files-bus.ts    同步文件总线（sidebar → chat-panel）
│   └── synced-files-types.ts  共享类型
│
├── data/                      本地存储（SQLite + 场景块 + persona）
│   ├── memory.db              主数据库
│   ├── scene_blocks/*.md      L2 场景块（每个主题一文件）
│   ├── persona.md             L3 画像
│   └── backup/                自动版本快照
│
├── scripts/                   一次性脚本 + 端到端测试
│   ├── acceptance.ts          完整接受测试套件
│   ├── test-scheduler.mjs     scheduler 行为验证
│   ├── test-stream.mjs        fucheers 流式 sanity check
│   ├── test-toolcall.mjs      工具调用回路验证
│   ├── test-external.mjs      Semantic Scholar + arXiv
│   ├── test-miromind.mjs      Deep Research 联通性
│   ├── vision-test.mjs        图片附件回归测试
│   └── trigger-l2l3.ts        手动触发 L2/L3 pipeline
│
├── docs/
│   └── MEMORY-CHAIN.md        详细记忆链文档（mermaid 图 + 调试入口）
│
├── public/                    静态资源（logo 等）
├── _archive/                  弃用的旧实现（不进入构建）
└── 文档
    ├── README.md              当前文件
    ├── PLAN.md                产品执行计划
    ├── PRODUCT.md             产品定位
    └── todo plan.md           活动工单列表
```

---

## 记忆系统：L0 → L1 → L2 → L3

照搬 TencentDB Agent Memory 的四层结构，只改两处：L1 类型换成研究语境、加 `ontology_label` 元数据。

| 层 | 是什么 | 物理存储 | 谁写 | 谁读 |
|---|---|---|---|---|
| **L0** | 原始对话（每条 user / assistant message） | SQLite `l0_conversations` + FTS5 trigram | `/api/chat` onFinish | recall、Aha evidence |
| **L1** | 原子研究记忆（claim/method/observation/dataset/experiment/finding/question/goal） | SQLite `l1_records` + FTS5 trigram | `l1-pipeline`（每 5 turn 或 flush） | 侧边栏、recall、Aha 检测 |
| **L2** | 主题场景块（围绕一个研究方向聚合相关 L1） | `data/scene_blocks/*.md` | `l2-l3-pipeline`（每攒够 3 条新 L1） | 侧边栏、evidence graph |
| **L3** | 稳定研究者画像 | `data/persona.md` | `persona-generator`（场景累计变化达阈值） | 主对话 system prompt |

### 触发：纯计数 + 互斥锁，无时间

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

不存在「10 分钟空闲触发」之类的定时器。用户回到 chat 时 `synapse-app.tsx` 自动 POST `/api/pipeline/flush` 一次，把残留 turn 冲掉。

详细规则、所有可调参数、故障模式都在 `docs/MEMORY-CHAIN.md`。

---

## Aha：被动浮出的研究观察

不是「按钮 → 生成」，是后台扫描 L1 时发现「这条思路在多个时间、多个对话里反复出现」时，自动合成一段三段式（observation / hypothesis / reframe），等用户下次发了相关问题时 inline 推送，并往侧边栏挂一个 ✨「新发现」徽章。

**完整链路：**

1. `runAhaDetection`（L1 完成后跑）扫 L1，找跨源记忆 ≥3 条 + 跨度 ≥3 天 → 写 `aha_pending` + `aha_last` + `aha_history`
2. 用户下次发消息时 `shouldFireAhaLLM`（Claude 判官）判断当前 query 是否相关 → YES 才 inline 注入
3. 侧边栏轮询 `/api/aha/last` 看 unseen → 显示 ✨「新发现」脉冲徽章
4. 点徽章 → `AhaModal` 浮层 + `EvidenceGraph` 拖拽式证据图
5. 侧边栏「✨ 历史发现」区永久列出每条 Aha，随时回看

**外部文献补足**：合成 Aha 时还会把中文 pattern 蒸馏成英文关键词去 Semantic Scholar + arXiv 各捞 1 条，挂在 `externalSources` 上 — 失败不影响 Aha 本身。

---

## 文件同步：仅元数据 + LLM 主动 tool call

**关键约束**：文件夹同步**不会**自动把文件内容塞进 L0。

```
连接文件夹 → 浏览器 File System Access API → IndexedDB 缓存 handle
扫描树 → 收集 metadata（路径/大小/扩展名） → 推送 synced-files-bus
chat 请求 body 只带 metadata（≤5KB）

如果 LLM 觉得需要某个文件，主动调 read_synced_file(path)
→ 服务端流暂停 → 浏览器 FileSystemFileHandle 读文件 → 走两轮 HTTP 回客户端
→ 再恢复 LLM 流，把内容当 tool result 喂回去
```

只有当用户**实际让 LLM 读过**某文件、并在这次对话里讨论了，对话本身才作为 L0 落库 — 文件本身永远不进 L0。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 14.2.30（App Router） | RSC + Route Handlers |
| 主对话 LLM | `claude-sonnet-4-6` via fucheers.top | OpenAI 兼容代理；流式 + tool_call 有 bug，已用 `chat-loop.ts` 手写绕过 |
| Deep Research LLM | miromind | 用户主动触发 |
| AI SDK | `ai` v6 + `@ai-sdk/openai` v3 + `@ai-sdk/react` v3 | `useChat` + `DefaultChatTransport` |
| 数据库 | `better-sqlite3` v12 + FTS5 trigram tokenizer | 支持中文搜索 |
| 图可视化 | `@xyflow/react` v12 | Aha 证据图 |
| PDF 解析 | `pdfjs-dist` v5 | 浏览器端懒加载 |
| 外部检索 | Semantic Scholar API + arXiv API | 直接 fetch，无 SDK |

---

## 常见操作

```bash
# 查看本地 SQLite
sqlite3 data/memory.db ".tables"
sqlite3 data/memory.db "SELECT COUNT(*) FROM l1_records;"

# 查看 L2 场景块
ls data/scene_blocks/

# 查看 L3 画像
cat data/persona.md

# 手动触发 L2/L3 pipeline
npx tsx scripts/trigger-l2l3.ts

# 强制生成一条 Aha（即使没到阈值）
curl -X POST "http://localhost:3000/api/aha/last?force=1"

# 看 Aha 历史
curl http://localhost:3000/api/aha/history | jq

# 清空所有数据（手动删 data/ 然后重启 dev server）
```

---

## 已知约束 / 故意不做

- **完全本地化**：所有数据在 `data/` 下；没有云数据库、没有用户系统、跨设备不同步
- **单用户**：没有 auth、没有 multi-tenant
- **未部署**：当前只跑 `next dev`，VPS + Nginx + HTTPS 部署是 out-of-scope
- **i18n**：UI 全中文，没有英文版
- **fucheers 流式 bug**：图片在流式下被剥离；tool_call argument 在流式下被截断 → 已用 `chat-loop.ts` 切换到非流式 + 手动 UI stream 包装

---

## 更多文档

- `docs/MEMORY-CHAIN.md` — 完整记忆链、所有 LLM 调用、调参表、调试入口
- `PRODUCT.md` — 产品定位 + 目标用户
- `PLAN.md` — 历史执行计划
- `todo plan.md` — 活跃工单列表

