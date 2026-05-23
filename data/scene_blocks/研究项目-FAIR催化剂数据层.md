-----META-START-----
created: 2026-05-23T08:46:32.897Z
updated: 2026-05-23T08:46:32.897Z
summary: 用户致力于化学催化剂溯源标准化研究，计划2026年底发表FAIR catalyst data layer论文，使用PROV-O本体扩展Chemotion ELN schema，填补领域级结构性数据缺口。
heat: 1
-----META-END-----

## 用户基础信息
- 职业：化学/数据科学研究者（方向：研究数据管理、催化化学）
- 当前项目：FAIR catalyst data layer 论文，计划2026年底发表

## 用户核心特征
用户具备跨领域整合能力，能将数据科学基础设施（FAIR原则、PROV-O本体）与化学实验研究（催化剂表征、ELN系统）结合。其研究风格注重结构性问题的系统性论证——通过8周内3篇论文的交叉观察来确立领域级缺口，而非依赖单一案例。

## 用户偏好
- 工具栈：Chemotion ELN（主要实验数据平台）、PROV-O本体
- 评估数据集：RSC期刊2020-2024年催化反应数据
- 研究笔记管理：acceptance-notes.md

## 隐性信号
- 用户选择"扩展现有系统"而非"重建系统"的方法论，暗示其对工程可行性和社区采纳率有清醒认知——激进重构在学术基础设施领域阻力极大。
- 连续在3篇独立论文中观察同一缺口，说明用户有系统性文献追踪习惯，且对"结构性 vs 偶发性"的论证标准要求较高，这将是论文说服力的核心。

## 核心叙事
**触发**：用户在过去8周内阅读3篇独立催化化学论文时，反复发现相同的数据缺口——催化剂仅被作为普通试剂记录（名称+用量），缺乏活化历史、批次信息、载体来源、表征数据引用等provenance字段。这与FAIR原则中Reusable的要求直接冲突，且根源不在于研究者习惯，而在于Chemotion等主流ELN系统底层schema本身未设计相应字段机制。

**行动**：用户决定以此为切入点，计划发表一篇FAIR catalyst data layer论文。方法上选择使用PROV-O本体（prov:Entity / prov:Activity / prov:Agent三元组）对Chemotion现有sample/reaction schema进行语义叠加扩展：将催化剂样品映射为prov:Entity（含批次、载体来源、前驱体），将合成/活化/表征步骤映射为prov:Activity，将合成者/供应商映射为prov:Agent，通过wasGeneratedBy、wasAttributedTo、used等关系串联完整provenance链。评估集选用RSC期刊2020-2024年催化反应数据。

**结果（进行中）**：研究框架已成型，当前推进基于acceptance-notes.md展开。核心待解问题是：3篇论文中缺失的provenance字段是否高度重叠（如activation history、batch/supplier info、合成者信息、使用前处理步骤），以将"结构性缺口"论点从观察升级为可量化的实证支撑。

## 理论背景速览
FAIR原则（2016年发表于《Scientific Data》，G20杭州峰会背书）：Findable（持久唯一标识符+丰富元数据）、Accessible（开放标准协议）、Interoperable（标准格式/词汇/本体）、Reusable（清晰许可证+溯源信息+质量说明）。核心推动组织：GO FAIR、CODATA、RDA、LIBER。补充框架：CARE原则（2019-2020，原住民数据治理）、2020年索邦宣言。

## 演变轨迹
（暂无重大观念转变记录）

## 待确认/矛盾点
- [2026-05-23] 3篇论文中缺失的catalyst provenance字段是否高度重叠，尚待系统性比对确认——这是"领域级结构性缺口"核心论点的实证基础。
