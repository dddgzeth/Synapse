# Synapse — Product Strategy

## 核心痛点

研究者有一个根本矛盾：

> **你在积累信息，但你没有在积累理解。**

你读了 50 篇论文，但说不清你"知道"了什么。你跑了 20 个实验，但看不出 pattern。你写了 3 个月 weekly report，但不知道自己在向哪里收敛。

每一篇论文、每一条笔记都是孤岛。连接它们的工作——综合、归纳、找 pattern——你必须手动做，而且几乎不做。

不是因为懒，是因为没有工具帮你做这件事。

---

## 现有工具的缺口

| 工具 | 能做什么 | 缺什么 |
|---|---|---|
| Notion / Obsidian | 存信息、手动链接 | 不会主动综合，不跨时间 |
| ChatGPT / Claude | 一次对话的洞察 | 没有记忆，下次对话从零开始 |
| Zotero / Mendeley | 管理引用 | 不读内容，不出洞见 |
| Google NotebookLM | 上传文档问答 | 一次性，不积累 |
| Mem0 | 个人记忆 | 没有研究级结构，没有 provenance |
| Elicit / Consensus | 文献问答 | 只检索，不跨时间，不联系你自己的材料 |

**共同缺口：没有一个工具能在你积累了几个月的材料之后，主动告诉你：你其实一直在处理同一个问题——并且同时从外部文献里找到佐证。**

---

## PMF 假设

> **研究者囤积了大量无法被自己充分利用的材料——因为跨时间综合太难，而且总是缺一块外部视角。**

如果一个系统能在你提问时，同时检索你的私有积累和外部最新文献，并告诉你：

> "你过去 8 周读的 14 篇论文、你的 3 份 weekly report、你 4 月 22 日的 meeting notes——它们都在指向同一个问题：catalyst preparation 的 provenance 标准化缺失。与此同时，Semantic Scholar 上近期有 3 篇 RSC/Wiley 论文正在讨论同一个 gap，但用了不同的术语。你不是在散漫地读论文，你在收敛一个有外部验证的论文题目。"

然后点开，每一句都有证据链，每一条都能追到原始材料或外部来源——

**这就是 PMF 命中的时刻。**

---

## 目标用户

**最精准的一层：**
- PhD 学生 / 博士后 / PI
- 在做 literature-heavy + experiment-heavy 的研究
- 材料来源同时有：论文 PDF、实验记录、会议笔记、周报
- 正在写论文或做方向决策的阶段（最需要跨时间综合 + 外部验证）

**核心验证：** 产品作者本人就是这个用户——做 FAIR data infrastructure for automated biomass chemistry（SCCB / MPI / NTU），同时积累了论文、Chemotion 实验记录、weekly reports、meeting notes。自己的痛点就是 PMF 的最强验证。

---

## 一句话定位

> Synapse 是研究者的长期记忆层——把你的私有积累和外部最新文献连接在一起，在某个时刻给你一个你自己没想到的洞察。

不是搜索工具（找已知的），不是摘要工具（压缩单篇），是**跨时间 + 内外联动的 pattern surfacer**。

---

## 核心功能

### 1. 本地研究材料导入
- **文件夹导入**（Chrome）：打开本地 research 文件夹，侧边栏展示文件树，点击即 ingest
- **文件上传**（所有浏览器）：拖拽或选择文件，支持 `.md` / `.txt` / `.pdf` / 图片
- **支持格式**：Markdown、PDF（包含图表）、纯文本、截图、实验记录
- PDF 和图片直接发给 Claude 解析，不依赖本地 OCR 库

### 2. 结构化记忆构建（自动，用户不感知）
- 每次导入自动触发：分块 → Claude Haiku 抽取 → 生成结构化 Memory（类型 / 摘要 / ontology 标签 / 置信度）
- 跨 memory 自动建立关系（基于语义相似度 + tag 重叠）
- Memory 类型：`claim / method / observation / dataset / experiment / finding / question / goal`
- Schema 对齐 PROV-O，每条记忆可追溯到原始 chunk

### 3. 自动化研究（Auto Research）✦ 核心差异化功能
用户提问时，系统自动决定是否向外部学术数据库补充检索：

**触发方式：** 用户输入 research query，Claude 自主判断是否需要外部补充

**数据源：**
- **Semantic Scholar**（覆盖 Wiley / RSC / ACS / Nature / Springer 等，返回摘要）
- **arxiv**（预印本，提供全文 PDF 链接）

**工作方式：**
```
用户 query
  → Claude 检索私有记忆（向量召回 + 关系扩展）
  → Claude 自主决定调用 search_semantic_scholar / search_arxiv
  → 搜索结果自动 ingest 进记忆库（摘要作为新 memory）
  → 合并私有记忆 + 外部文献 → 生成三段式 insight
```

**结果：** insight 既引用你自己的笔记，也引用外部论文——私有视角 + 外部视角的交叉验证

> 注：Wiley/RSC 付费全文无法自动获取，但摘要已足够 pattern surfacing。用户可通过机构账号下载 PDF 放入本地文件夹，由 Synapse 读取全文。

### 4. 三段式 Aha Insight + 证据链
每次查询产出：

| 段落 | 内容 |
|---|---|
| **Observation** | 跨时间、跨来源观察到的事实（引用具体材料） |
| **Hypothesis** | 这个 pattern 背后可能是什么更深的东西 |
| **Reframe** | 把你以为是"问题"的东西重新框架成"证据" |

每段可展开查看 supporting memories，每条 memory 可追溯到原始 source chunk。

### 5. 记忆库视图
- **Memory Cards**：所有结构化记忆，按类型/时间/来源筛选
- **Timeline**：按时间排列的 sources / memories / insights，展示研究演化轨迹
- **Graph Snapshot**：memory 节点和关系的可视化，展示知识结构

---

## 产品差异化

| 维度 | Synapse | Notion/Obsidian | NotebookLM | Elicit |
|---|---|---|---|---|
| 跨时间 pattern | ✅ | ❌ 手动 | ❌ | ❌ |
| 私有 + 外部联动 | ✅ | ❌ | ❌ | 仅外部 |
| Provenance 可追溯 | ✅ | ❌ | 部分 | 部分 |
| 持续积累 | ✅ | ✅ 手动 | ❌ | ❌ |
| 研究级 schema | ✅ PROV-O | ❌ | ❌ | ❌ |

---

## Aha Moment 示例

> *"在你过去 8 周的 weekly reports、14 篇论文笔记和 4 月会议记录中，你反复回到 catalyst preparation provenance 的标准化缺失。这不只是你自己观察到的 gap——Semantic Scholar 上近期 3 篇来自 RSC 和 Wiley 的论文（2025-2026）正在用不同术语描述同一个问题。你在 Chemotion 上做的 segment schema 设计，正是这个领域缺失的基础设施。你不是在散漫地读论文，你在独立收敛一个有外部验证的研究命题。"*

---

## 赛道定位（miromind 黑客松）

**赛道：** Deep Research / AI Application / 自动化研究系统

**对应分类：** 生物 / 化学研究助手 + 任何有价值的 AI Use Case

**赛道亮点：**
- **Deep Research**：自动检索 Semantic Scholar + arxiv，私有记忆 + 外部文献联动
- **Tool Use**：Claude 自主调用 search tools，不是 hardcoded pipeline
- **自动化研究系统**：从导入到 insight 全流程自动化，用户只需提问
- **Application**：不是 agent demo，是解决真实研究痛点的产品

---

## 交付物

- **网站**：部署在域名下，支持本地文件夹导入 + Auto Research + 三段式 insight
- **GitHub Repo**：清晰 README，schema 对齐 PROV-O，代码结构清晰
- **演示视频**：2-3 分钟，分两条路径展示：
  - **核心路径（必须）**：打开本地研究文件夹 → 点击导入材料 → 输入 query → 三段式 aha insight → 展开证据链追溯到原始材料
  - **扩展路径（加分）**：在核心路径基础上，展示 Claude 自动补充检索 Semantic Scholar / arxiv → insight 同时引用私有记忆和外部文献
