# Synapse — 开发 Plan（v3，最终版）

> 一个带长期记忆的研究助理 chatbot。记忆底层完全照搬 TencentDB Agent Memory L0-L3 架构。

---

## 产品定位

研究者和 Synapse 正常对话（同步本地文件夹、提问、获得回复）。TencentDB 在后台自动：
- L0 捕获原始对话（全局，跨所有对话、跨所有文件夹）
- L1 抽取结构化研究记忆
- L2 聚合研究主题场景块
- L3 提炼稳定研究者画像

**Aha Insight**：不是用户触发的，是记忆积累到阈值后后台检测到 pattern，在某次普通对话中自然内嵌浮现——研究者不知道它什么时候会出现。

**Deep Research**：用户主动触发（额度有限），miromind 搜索 Semantic Scholar + arxiv，正常返回研究结果。外部文献写入 L0，加入全局记忆积累。

**记忆是全局的**：不属于任何单个对话或文件夹，L2/L3 始终在侧边栏可见。

---

## UI 设计 + User Journey

### 界面布局（参考 Claude.ai）

```
+---------------------+-----------------------------------------------+
|  SYNAPSE            |                                               |
+---------------------+  User: 我最近的实验记录有什么规律？            |
| [+ New Chat]        |                                               |
|                     |  Synapse: 根据你的记录，主要集中在...          |
| == 本地文件夹 ==    |                                               |
| 📁 ~/research/      |  ┌─────────────────────────────────────────┐  |
|   23 文件 · 2h前    |  │ 💡 Synapse 注意到                       │  |
| 📁 ~/lab_notes/     |  │                                         │  |
|   11 文件 · 昨天    |  │ Observation: 过去8周，你在3个不同来源里  │  |
| [+ 连接文件夹]      |  │ 反复回到同一个问题——catalyst provenance  │  |
|                     |  │ 标准化缺失。                             │  |
| == 全局记忆 ==      |  │                                         │  |
| L3 研究者画像       |  │ Hypothesis: 这不是散漫阅读，这是一个     │  |
| • FAIR data infra   |  │ 正在收敛的研究命题。                     │  |
| • Provenance gap    |  │                                         │  |
| • Chemotion ELN     |  │ Reframe: 你的 Chemotion schema 设计，   │  |
|                     |  │ 正是这个领域缺失的基础设施。             │  |
| L2 研究场景         |  │                       ▼ 查看证据链      │  |
| • Chemotion 部署    |  └─────────────────────────────────────────┘  |
| • FAIR Layer 2      |                                               |
| • Provenance gap    |  （对话继续正常进行...）                       |
|                     |                                               |
| == 对话历史 ==      |-----------------------------------------------|
| > 今天              |                                               |
| > 昨天              |  [📎 文件] [⚡ Deep Research] [输入消息...] ▶  |
+---------------------+-----------------------------------------------+
```

**关键设计原则：**
- **本地文件夹**：侧边栏独立区域，显示已连接文件夹列表 + 同步状态；File System Access API（Chrome）+ 单文件上传降级
- **全局记忆**：L2 场景块、L3 画像跨所有对话持续存在，不属于任何单个 chat
- **Aha Insight**：无声浮现在普通回复流中，不是按钮触发的产物

### User Journey

**初次使用：**
1. 打开 Synapse，左侧点击 `[+ 连接文件夹]`
2. 浏览器弹出文件夹选择（File System Access API）
3. 选择 `~/research/` → 后台扫描 ingest，写入 L0，触发 L1 抽取
4. 侧边栏显示文件夹名称 + 文件数 + 同步时间
5. 可继续连接多个文件夹（如 `~/lab_notes/`）

**日常对话：**
1. 正常提问，Claude 回复
2. 对话写入 L0，后台积累记忆，L1/L2/L3 静默更新
3. 某天问一个问题，回复里突然内嵌了一张 Aha Insight Card——研究者没有做任何特殊操作
4. 点「查看证据链」：Insight → L2 场景块 → L1 原子记忆 → L0 原始对话

**Deep Research（主动触发，按需使用）：**
1. 点击 `⚡ Deep Research` 按钮
2. 输入 query，miromind 搜索外部文献，正常返回结果
3. 外部文献写入 L0，进入全局记忆积累（可能在未来触发 Aha）

### Aha Moment 触发机制

```
L2 更新后，后台检测：
  IF 同一 pattern 出现在 ≥3 个不同来源
  AND 时间跨度 ≥2 周
  THEN 标记 aha_pending = true，存储 pattern 摘要

下次对话请求时：
  IF aha_pending = true
  AND 当前 query 与该 pattern 语义相关
  THEN 在正常回复中内嵌 Aha Insight Card
  AND 重置 aha_pending = false
```

Aha 是**被动的、惊喜的**：研究者不知道它什么时候出现。

### LLM 分工

| 场景 | 模型 |
|---|---|
| 普通对话回复 | claude-sonnet-4-6（fucheers.top）|
| L1/L2/L3 记忆 pipeline | claude-sonnet-4-6（fucheers.top）|
| Deep Research + Aha Insight | mirothinker-1-7-deepresearch-mini（miromind）|
| UI 相关代码生成辅助 | [次]gemini-3.1-pro-preview（novaiapi）|

```
GEMINI_API_KEY=sk-xlywPd7btDWlPfct30FH5WxXRikIEPBgTRoW8OWMxsbbjOz4
GEMINI_MODEL=[次]gemini-3.1-pro-preview
GEMINI_BASE_URL=https://us.novaiapi.com/v1
```

---

## 技术决策

| 决策 | 结论 |
|---|---|
| 部署 | VPS（195.7.7.17）+ Nginx + PM2 + 自有域名 |
| 存储 | **SQLite + sqlite-vec**（TencentDB 原生，本地跑，无需 Supabase）|
| Embedding | **本地 GGUF 模型**（`node-llama-cpp`，TencentDB 原生，无需外部 API）|
| 记忆 pipeline LLM | **claude-sonnet-4-6** via `https://www.fucheers.top`（L1/L2/L3）|
| Auto Research + Insight LLM | **mirothinker-1-7-deepresearch-mini** via `https://api.miromind.ai/v1` |
| 前端框架 | Next.js（`next start` 跑在 VPS 上，PM2 管理）|
| 记忆架构 | **TencentDB Agent Memory L0-L3，代码文件命名完全照搬** |

---

## 环境变量（`.env.local`）

```
# 记忆 pipeline（L1/L2/L3 抽取）
ANTHROPIC_BASE_URL=https://www.fucheers.top
ANTHROPIC_API_KEY=sk-uKSfNT0XebOhBZtZNz2uGEwCbcA3JogNPg0ibvS8Jw4Lz1lq
ANTHROPIC_MODEL=claude-sonnet-4-6

# Auto Research + Aha Insight
MIROMIND_BASE_URL=https://api.miromind.ai/v1
MIROMIND_API_KEY=sk-INv0taQR2irle7YCe4NvXdKzppnoDn5JjyBGsxZHHVM=
MIROMIND_MODEL=mirothinker-1-7-deepresearch-mini

# 数据目录（VPS 上的持久路径）
TDAI_DATA_DIR=/opt/synapse/data
```

---

## 记忆架构（TencentDB L0-L3，照搬）

```
L0  原始对话（研究者 ↔ Synapse 的所有消息）
    ↓ L1 抽取（claude-sonnet-4-6，每 N 条对话触发）
L1  原子研究记忆（claim/method/observation/dataset/
    experiment/finding/question/goal + ontology_label）
    ↓ L2 聚合（claude-sonnet-4-6，定时触发）
L2  研究主题场景块（scene_blocks/*.md）
    ↓ L3 提炼（claude-sonnet-4-6，每 50 条记忆触发）
L3  研究者画像（persona.md）
```

### 唯二改动（其余照搬 TencentDB）

1. **L1 memory type**：`persona/episodic/instruction` → `claim/method/observation/dataset/experiment/finding/question/goal`
2. **MemoryRecord.metadata 扩展**：加 `ontology_label`（如 `prov:Entity`、`iao:information-content-entity`）

---

## 文件结构（命名与 TencentDB 一致）

```
tencentdb-memory/          ← clone 的原始 repo，直接 import
lib/
├── store/
│   └── supabase.ts        ← 唯一自写：IMemoryStore 的 SQLite 实现（直接用 TencentDB 的 sqlite.ts）
├── prompts/
│   ├── l1-extraction.ts   ← 改研究类型，其余照搬
│   ├── l1-dedup.ts        ← 直接复制 TencentDB
│   ├── scene-extraction.ts ← 直接复制 TencentDB
│   └── persona-generation.ts ← 直接复制 TencentDB
├── search-tools.ts        ← Semantic Scholar + arxiv（Auto Research）
└── insight.ts             ← Aha Insight 三段式合成（miromind）
app/
├── api/
│   ├── chat/route.ts      ← 主聊天接口，L0 录入 + 触发记忆 pipeline
│   │                         Claude 可调用 conversation-search / memory-search tool
│   ├── upload/route.ts    ← 文件内容作为 L0 消息写入
│   └── insight/route.ts   ← 触发 Auto Research
components/
├── chat.tsx               ← 主聊天界面（搜索也在这里，不跳页面）
├── insight-card.tsx       ← Aha Insight 浮现卡片 + 证据链展开
└── file-upload.tsx        ← 文件上传 + 文件夹同步组件
```

---

## L1 Prompt 改动（仅改类型，其余照搬）

TencentDB 原版 system prompt 的记忆类型：
```
persona | episodic | instruction
```

Synapse 替换为：
```
claim       → 研究声明/结论
method      → 方法/技术路线
observation → 实验观察/数据现象
dataset     → 数据集/数据描述
experiment  → 实验设计/执行
finding     → 发现/结果
question    → 开放问题/research gap
goal        → 研究目标/方向
```

metadata 加一行：
```json
{ "ontology_label": "prov:Entity | iao:information-content-entity | obi:investigation | ..." }
```

---

## 交互式历史搜索（TencentDB 原生工具，照搬）

用户在聊天里自然提问，Claude 调用工具搜索，返回完整对话回合，用户可继续追问。

**搜索工具（直接照搬 TencentDB）：**
- `tdai_conversation_search`（`src/core/tools/conversation-search.ts`）：搜索 L0 原始对话
- `tdai_memory_search`（`src/core/tools/memory-search.ts`）：搜索 L1 原子记忆

**返回格式（完整对话回合，不是片段）：**
```
用户问：帮我找3月份关于 FAIR data 的对话

Synapse 搜索 L0 → 找到 3 段相关对话：

─── 2026-03-20 ───────────────────────────
你：FAIR data 的四个原则分别是什么？
Synapse：Findable 指数据可被发现...

─── 2026-03-27 ───────────────────────────
你：Chemotion 里怎么配置 ontology 映射？
Synapse：在 segment 字段里可以绑定...

─── 2026-04-10 ───────────────────────────
你：为什么 catalyst provenance 标准化这么难？
Synapse：主要问题在于...

你还想进一步了解哪段？
```

用户可以继续追问，整个过程就是普通对话，不跳页面，不切换 UI。

---

## Auto Research（miromind）

用户提问时，用 `mirothinker-1-7-deepresearch-mini` 自主决定是否搜外部：

```typescript
// 两个 tool 挂载给 miromind
search_semantic_scholar  // 覆盖 Wiley/RSC/ACS/Nature 摘要
search_arxiv             // 预印本全文链接
```

Tool use loop：
```
用户 query
  → 召回 L1 + L2 记忆（私有上下文）
  → miromind 自主决定调用 search_semantic_scholar / search_arxiv
  → 合并私有记忆 + 外部文献
  → 输出三段式 Aha Insight JSON
  → 搜索结果异步写入 L0（下次查询时进入记忆）
```

---

## Aha Insight 三段式

```json
{
  "observation": "跨时间、跨来源观察到的 pattern（引用具体 L1 记忆 ID + 外部文献）",
  "hypothesis": "这个 pattern 背后更深的研究命题",
  "reframe": "把'散漫工作'重新框架成'收敛证据'",
  "supportingMemoryIds": ["m_xxx", "m_yyy"],
  "externalSources": [{ "title": "...", "abstract": "...", "source": "semantic_scholar" }]
}
```

证据链下钻（TencentDB 原生支持）：
```
Aha Insight → L2 场景块 → L1 原子记忆 → L0 原始对话
```

---

## 部署（VPS）

```bash
# 1. VPS 上 clone repo
git clone <repo> /opt/synapse
cd /opt/synapse
npm install

# 2. 安装 TencentDB 依赖（含 node-llama-cpp 本地 embedding）
npm install @tencentdb-agent-memory/memory-tencentdb

# 3. 下载 GGUF embedding 模型（TencentDB 自动处理）
# 4. PM2 启动
pm2 start npm --name synapse -- run start
pm2 save

# 5. Nginx 配置反向代理 + SSL（Certbot）
```

---

## 新增依赖

```bash
npm install @tencentdb-agent-memory/memory-tencentdb
npm install @anthropic-ai/sdk   # fucheers.top proxy 兼容
```

---

## 执行顺序

**Phase 1：把 TencentDB 跑起来**
1. `npm install @tencentdb-agent-memory/memory-tencentdb`
2. 用 StandaloneHostAdapter 初始化，配置 fucheers.top 作为 LLM runner
3. 验证 L0 写入、L1 抽取正常（跑一条测试对话）

**Phase 2：改 L1 Prompt 为研究语境**
4. 复制 `l1-extraction.ts`，替换 memory type 为研究类型，加 `ontology_label`
5. 验证 L1 抽取出 `claim/observation/finding` 等类型

**Phase 3：接入聊天界面**
6. 写 `app/api/chat/route.ts`：收消息 → 写 L0 → 触发 L1 pipeline → 返回 Claude 回复
7. 写 `components/chat.tsx`：基础 chatbot UI
8. 写 `app/api/upload/route.ts`：文件内容作为 L0 消息写入

**Phase 4：Auto Research + Aha Insight**
9. 写 `lib/search-tools.ts`：Semantic Scholar + arxiv
10. 写 `lib/insight.ts`：miromind tool use loop → 三段式 JSON
11. 写 `app/api/insight/route.ts`
12. 写 `components/insight-card.tsx`：三段式展示 + 证据链展开

**Phase 5：部署**
13. VPS 环境配置（Node 22+、PM2、Nginx、SSL）
14. 域名指向 VPS，HTTPS 配好

**Phase 6：自测体验（不可跳过）**
15. 研究者自己用：上传真实文件 → 对话 → 触发 Deep Research → 验证 Aha Insight 质量
16. 根据体验调整 prompt / UI / 交互细节

---

## 验证清单

- [ ] 对话写入 L0，L1 抽取出研究类型记忆（含 ontology_label）
- [ ] L2 场景块生成，L3 画像更新
- [ ] 证据链可下钻：Insight → L2 → L1 → L0
- [ ] Auto Research 触发 Semantic Scholar / arxiv 搜索
- [ ] Aha Insight 同时引用私有记忆和外部文献
- [ ] 文件上传后内容进入对话上下文和记忆
- [ ] VPS 公网可访问，HTTPS 正常
- [ ] 不存在任何"树洞""心理医生"文字
