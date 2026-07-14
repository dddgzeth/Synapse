
  ❌ PLAN 里写了但还没实现

  Plan 条目: tdai_conversation_search / tdai_memory_search 工具给主 chat 
    Claude（PLAN 223-252）
  严重度: 🔴 重要
  说明: 这是 PLAN 里专门划一节的核心功能：用户在普通对话里说"帮我找 3 月份关于
    FAIR data 的对话"，Claude 应该能 tool-call 搜 L0/L1
    并把完整对话回合粘贴回来。_archive/tencentdb-memory/src/core/tools/conversati
  on-search.ts
     + memory-search.ts 现成 569 行可以移植。目前主 chat 没注册任何 tools。
  ────────────────────────────────────────
  Plan 条目: Aha Insight 证据链下钻 UI（PLAN 75, 290-293）
  严重度: 🟡 中
  说明: Aha Card 应该有「▼ 查看证据链」可展开：Insight → 列出 supportingMemoryIds

    → 点 memory → 跳到对应 L2 scene → 跳到 L0 原文。AhaCard
    现在只渲染文本，没有展开链。
  ────────────────────────────────────────
 /1，不调 miromind 取外部论文，输出 JSON 里
    externalSources 字段是空的。
  ────────────────────────────────────────
  Plan 条目: Aha 触发逻辑用 LLM 判官（无硬编码阈值）
  严重度: 🟡 中
  说明: 上次和你讨论过的新方案，没动手；现在仍然是 bag-of-words normalizePattern
  +
    字面字串包含的 shouldFireAha。
  ────────────────────────────────────────
  Plan 条目: MIROMIND Aha Insight 生成器（PLAN 105）
  严重度: 🟡 中
  说明: PLAN 表里 "Aha Insight" 这一栏指定用 miromind 而非 claude；现在 aha
  用的是
    fucheers Claude。
  ────────────────────────────────────────
  Plan 条目: L2 scene_blocks 同时跨多 session 聚合（PLAN 19 "记忆是全局的"）
  严重度: 🟢 已正确
  说明: sceneExtractor 拿到的是所有 sessionKey 的 L1，已经全局
  ────────────────────────────────────────
  Plan 条目: L1 memory 跨 session 全局可见（PLAN 19）
  严重度: 🟢 已正确
  说明: recall 不按 sessionKey 过滤
  ────────────────────────────────────────
  Plan 条目: Gemini 用作 UI 代码生成辅助（PLAN 106-112）
  严重度: 🟢 N/A
  说明: 是给我（写代码的工具）用的，不是运行时功能
  ────────────────────────────────────────
  Plan 条目: VPS 部署 + Nginx + HTTPS（PLAN 297-314）
  严重度: 🟢 OOS
  说明: 部署任务，不算实现漏项
  ────────────────────────────────────────
  Plan 条目: L2 scene_blocks 同时跨多 session 聚合（PLAN 19 "记忆是全局的"）
  严重度: 🟢 已正确
  说明: sceneExtractor 拿到的是所有 sessionKey 的 L1，已经全局
  ────────────────────────────────────────
  Plan 条目: L1 memory 跨 session 全局可见（PLAN 19）
  严重度: 🟢 已正确
  说明: recall 不按 sessionKey 过滤
  ────────────────────────────────────────
  Plan 条目: Gemini 用作 UI 代码生成辅助（PLAN 106-112）
  严重度: 🟢 N/A
  说明: 是给我（写代码的工具）用的，不是运行时功能
  ────────────────────────────────────────
  Plan 条目: VPS 部署 + Nginx + HTTPS（PLAN 297-314）
  严重度: 🟢 OOS
  说明: 部署任务，不算实现漏项

  ---
  建议下一步动手顺序

  我倾向：

  1. 优先做 tdai_conversation_search + tdai_memory_search（最高 ROI，PLAN
  里独立一节，原版 569 行可直接移植）
  2. Aha Insight 重写（用 LLM 判官 + 融合外部文献 + 写入 supportingMemoryIds
  让前端能下钻）
  3. AhaCard 加证据链下钻 UI

  三个加一起估 2-3 小时。哪一个先动？还是按顺序全做？




   你重新叙述一下之前的A的问题，A的完整流程，尤其是耗时长的 
  每一步在干什么，再补充一下A的环节，每一步调用LLM在干什么 

⏺ 好，从头到尾重新讲，每一步都说**"在干啥 / 多久 /
  谁调的"，所有 LLM 调用单独列出来说"问 LLM
  什么、要它出什么"**。

  ---
  A 问题的完整流程

  整体时间线（11 个文件 × 平均 8KB）

  T+0s         你按下「+ 连接文件夹」
  T+~0.2s      Stage 0 完，浏览器选择器收到 handle
  T+~0.3s      Stage 1 完，scanTree + flatten 完成
  T+~0.3s      Stage 2 启动：客户端开始串行 POST × 11
  T+~2.5s      Stage 2 完，11 次 HTTP POST 串完，UI
  显示"同步中 11/11"
  T+~2.5s      Stage 3 也同时完了（嵌在 Stage 2 里，每个
  POST 服务端耗时 ~50ms）
  T+~2.5s      Stage 4 启动：11 个 L1 pipeline 已在 Node
  进程里并发起跑（fire-and-forget）
  T+~30-60s    Stage 4 完（11 个 L1 串过 fucheers proxy
  的队列）
  T+~30s 起    Stage 5 启动：每个 L1 完成时触发自己的 L2 +
  L3，11 路雪崩
  T+~120-180s  Stage 5 完，全部消化结束

  用户看到的：UI 在 T+2.5s 就显示"同步完成
  11/11"，但实际后台还要再忙 2-3
  分钟才"真消化完"，期间记忆数会慢慢涨、聊天框响应会卡。

  ---
  Stage 0 — 浏览器，弹系统文件夹选择器（~200ms）

  代码：components/sidebar.tsx:117
  const handle = await (window as
  any).showDirectoryPicker({ mode: "read" });

  Chrome 调系统 file picker → 用户选 ELN/ → 浏览器创建
  FileSystemDirectoryHandle 给 JS。返回的 handle
  还没去读任何文件——只是一个授权过的"指针"。

  无 LLM。

  ---
  Stage 1 — 浏览器，递归遍历目录（~50ms）

  代码：components/sidebar.tsx:124, scanTree() at :475-498

  for await (const [name, h] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    if (h.kind === "directory") children.push(await
  scanTree(h, childPath));
    else children.push({ name, path, handle: h, isText,
  isImage });
  }

  只是异步迭代目录条目，构建 TreeNode
  树结构。没读文件内容，没碰服务端。

  无 LLM。

  ---
  Stage 2 — 浏览器串行 POST（~2-3s）

  代码：components/sidebar.tsx:505-531

  for (const node of files) {                          // ❶
   串行
    if (!node.isText) continue;
    const file = await node.handle.getFile();          //
  5ms
    const content = await file.text();                 //
  5-50ms 读文件
    await fetch("/api/upload", { ... });               // ❷
   await，等服务端返回
    done++;
    onProgress(done);
  }

  关键问题：for 循环 + await
  fetch——浏览器一次只发一个请求，下一个文件要等上一个 HTTP
  完整返回。11 × 200ms ≈ 2-3 秒。

  无 LLM。

  ---
  Stage 3 — 服务端 /api/upload 每次干什么（~50-100ms / 次）

  代码：app/api/upload/route.ts:16-67

  // 1. 切块（按段落边界，每块 ≤ 2000 字符）
  const chunks = splitIntoChunks(content, 2000);       //
  route.ts:31

  // 2. 同步写 L0（每个 chunk 一行 + 1 个 ack）
  for (let i = 0; i < chunks.length; i++) {
    insertL0({ role: "user", message_text: ...,
  session_key: "files", session_id: <folderName> });
  }
  insertL0({ role: "assistant", message_text: "已读取文件
  X..." });  // route.ts:47

  // 3. 服务端轮次计数器+1
  incrementTurnCount("files");                         //
  route.ts:58

  // 4. 触发 L1 pipeline（fire-and-forget，不 await）
  if (shouldTriggerL1("files")) {
    runL1Pipeline("files", sessionId).catch(...);     //
  route.ts:60
  } else {
    // 注释写"Always trigger after file
  upload"——两个分支干同一件事
    runL1Pipeline("files", sessionId).catch(...);     //
  route.ts:63
  }

  // 5. 立刻 return
  return NextResponse.json({ ok: true, ... });        //
  route.ts:66

  insertL0 内部：INSERT INTO l0_conversations + FTS5
  trigger 自动写 l0_fts 索引。better-sqlite3 在 WAL
  模式下单条 INSERT ~1-3ms。

  关键：第 4 步触发的 L1 pipeline 是 fire-and-forget
  的——HTTP 响应已经飞回浏览器了，但 Node 进程里那个 Promise
   还在跑。所以11 次 POST 在服务端启动了 11 个并发后台
  pipeline。

  无 LLM（在这一步）。

  ---
  Stage 4 — 11 个 L1 pipeline 并发跑（~30-60s）

  代码：lib/memory/l1-pipeline.ts:65-205

  每个 runL1Pipeline("files", sessionId) 干这些：

  4.1 拉最近 50 条 L0（同步，~5ms）

  const l0Messages = queryL0ForSession("files", 50);   //
  l1-pipeline.ts:67

  ⚠️  第一个设计问题：所有 11 个文件都共享 sessionKey =
  "files"。所以：
  - 第 1 个 L1 看到 1 个文件的 L0
  - 第 5 个 L1 看到前 5 个文件的 L0
  - 第 11 个看到全部 11 个文件的 L0

  → 同一批 L0 被重复抽取很多遍。

  4.2 切分 background（前 5 条上下文）+ new（最近 10
  条新消息）

  const bgMessages = l0.slice(0, -10).slice(-5);       //
  l1-pipeline.ts:71-79
  const newMessages = l0.slice(-10);                   //
  l1-pipeline.ts:81-88

  4.3 🔥 LLM 调用 #1：L1 抽取（~3-5s）

  代码：l1-pipeline.ts:97-101
  rawText = await runner.run({
    systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
    prompt: formatExtractionPrompt({ newMessages,
  backgroundMessages, previousSceneName }),
    maxTokens: 4096,
  });

  问 LLM 什么：
  - 系统提示词：「你是研究记忆抽取器。把对话里的研究类信息
  拆成原子记忆，按 scene 分组。每条记忆给一个
  type（goal/method/observation/dataset/experiment/finding/
  question/claim）+ 一个 priority（0-100）+ 一个
  ontology_label（如 prov:Entity /
  iao:information-content-entity / obi:investigation 等）」
  - 用户提示词：「这里是 5 条背景消息 + 10 条新消息（含
  role / message_id / timestamp）。你之前抽过的 scene 名是
  X。返回 JSON 数组：[{scene_name, message_ids, memories:
  [{content, type, priority, source_message_ids, metadata:
  {ontology_label}}]}]。」

  要它出：纯 JSON，每个 scene 下可能有 0-10 条 memory。

  之后用来干啥：parseExtractionResponse()（l1-pipeline.ts:2
  17）解析 JSON，flatten 成 ExtractedMemory[]，每条 mint
  一个 record_id。

  4.4 对每条候选 memory 做 FTS 召回相似项（同步，~5ms × N）

  const matches: CandidateMatch[] = await Promise.all(
    allExtracted.map(async (em) => {
      const candidates = searchL1Fts(em.content, 5);   //
  l1-pipeline.ts:125
      return { newMemory: em, candidates };
    }),
  );

  对每条新 memory 在已有 L1 库里 FTS5 top-5 召回相似项。

  4.5 🔥 LLM 调用 #2：dedup（~2-3s，只在有相似候选时才调）

  代码：l1-pipeline.ts:143-147
  if (hasAnyCandidate) {
    dedupRaw = await runner.run({
      systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
      prompt: formatBatchConflictPrompt(matches),
      maxTokens: 2048,
    });
  }

  问 LLM 什么：
  - 系统提示词：「你是冲突检测器。对每条新 memory，决定
  action：store（新存）/ merge（合并到指定 target_ids）/
  skip（已有不存）。如果 merge，给出 merged_content /
  merged_type / merged_priority / merged_timestamps。」
  - 用户提示词：每条新 memory + 它召回到的 5 条相似候选（带
   record_id），让 LLM 比较语义、判断是不是同一件事。

  要它出：JSON 数组 [{record_id, action, target_ids,
  merged_*}]。

  之后用来干啥：parseDedupResponse()（l1-pipeline.ts:240）
  解析，按 decision 执行 deleteL1Batch(target_ids) +
  upsertL1(record)。

  4.6 写回 SQLite（同步，~5ms × N）

  for (const decision of decisions) {                  //
  l1-pipeline.ts:162
    if (decision.action === "skip") continue;
    if (decision.target_ids.length > 0)
  deleteL1Batch(decision.target_ids);
    upsertL1(record);                                  //
  l1-pipeline.ts:188
  }

  ⚠️  第二个设计问题：better-sqlite3
  写操作是同步阻塞的——但多个并发 L1 pipeline 都在调
  upsertL1，它们在 Node 事件循环里串行，互相不会乱写但互相
  阻塞。更糟的是，两个并发 L1 可能都决定要 merge 进同一个
  target_id——后写的覆盖先写的。

  4.7 触发 L2/L3（fire-and-forget，~5ms 启动）

  if (writtenRecords.length > 0) {                     //
  l1-pipeline.ts:196
    runL2L3Pipeline({ newMemories: writtenRecords.map(...)
  }).catch(...);
  }

  L1 函数到这就 return 了，但又启动了一个后台
  Promise——L2/L3 pipeline。

  Stage 4 总结

  ┌────────────────┬────────────────────┬──────────┐
  │    内部步骤    │ 是否阻塞 next file │   耗时   │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.1 queryL0    │ sync               │ ~5ms     │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.2 切分       │ sync               │ <1ms     │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.3 LLM 抽取   │ async, await       │ 3-5s     │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.4 FTS 召回   │ async, parallel    │ ~10-50ms │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.5 LLM dedup  │ async, await       │ 2-3s     │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.6 SQLite 写  │ sync, 写锁         │ ~5ms × N │
  ├────────────────┼────────────────────┼──────────┤
  │ 4.7 触发 L2/L3 │ fire-and-forget    │ <5ms     │
  ├────────────────┼────────────────────┼──────────┤
  │ 单次 L1 总耗时 │ —                  │ 5-10s    │
  └────────────────┴────────────────────┴──────────┘

  11 个 L1 并发 + fucheers proxy 假设 4 路并发 + SQLite
  写锁 → 实际墙钟约 30-60s。

  ---
  Stage 5 — 11 个 L2/L3 pipeline 并发跑（~60-180s）

  代码：lib/memory/l2-l3-pipeline.ts:98-151

  每个 runL2L3Pipeline({ newMemories }) 干这些：

  5.1 L2：SceneExtractor.extract(memories)

  代码：lib/tencentdb/scene/scene-extractor.ts:122-300

  这是最贵的步骤，因为是 agentic LLM tool-use 循环。

  Phase 0：备份（~10-50ms）
  await bm.backupDirectory(sceneBlocksDir, ...);       //
  scene-extractor.ts:143
  把 data/scene_blocks/ 整个目录复制一份到
  data/.backups/scene_blocks/offsetN/，保留最近 5 份。

  Phase 1：读 scene_index + 读每个现存 scene 的
  META（~50-100ms）
  const index = await readSceneIndex(dataDir);         //
  scene-extractor.ts:148
  for (const e of index) {
    const raw = await fs.readFile(scene_blocks/<filename>,
  "utf-8");  // scene-extractor.ts:175
    // 用 parseSceneBlock 取 META 头（不取 content，给 LLM
  看摘要就行）
  }

  Phase 2：构造 prompt（~5ms）
  const userPrompt = buildSceneExtractionPrompt({      //
  scene-extractor.ts:194
    memories: <新进的 L1 列表>,
    existingSceneFiles: <现存 scene 的 META 列表 +
  容量警告>,
    maxScenes: 15,
  });
  prompt 大概 2-5KB。

  Phase 3：🔥 LLM agentic tool-use 循环（~10-40s，多步）

  代码：scene-extractor.ts:211-218
  llmOutput = await this.runner.run({
    systemPrompt,
    prompt: userPrompt,
    taskId: `scene-extract-${Date.now()}`,
    timeoutMs: 300_000,         // 5 分钟超时
    workspaceDir: sceneBlocksDir,
  });

  runner 是 CleanContextRunner({ enableTools: true })——见
  lib/tencentdb/runtime/tool-runner.ts:79-86：
  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    tools: { list_dir, read_file, write_file, edit_file },
   // sandboxed to scene_blocks/
    stopWhen: stepCountIs(25),  // 最多 25 步
  });

  问 LLM 什么：
  - 系统提示词：「你是 scene block 维护者。你的工作区是
  scene_blocks/ 目录。每个 scene 是一个 markdown
  文件，开头有 META-START/META-END 块（含
  title/summary/heat/related_scenes）。你的任务：把新进来的
   memory 安排到合适的 scene——可以 CREATE 新 scene、UPDATE
  现有 scene、MERGE 两个 scene 合并、或 ARCHIVE 老旧
  scene。用提供的 4 个文件工具自己读写。最多 15 个 scene
  限额。」
  - 用户提示词：「这是 N 条新 memory：<列出每条 type /
  content / priority / scene_name>。现存 scenes
  摘要：<列出每个 scene 的 title + summary +
  heat>。请规划并执行。最后如果觉得 persona 该更新，输出
  [PERSONA_UPDATE_REQUEST] 标记。」

  模型实际会调的工具序列（每一步都是一次 Claude 调用 + 一次
   tool 返回）：
  1. list_dir({path: "."}) — "scene_blocks 里现在有什么"
  2. read_file({path: "研究项目-FAIR催化剂数据层.md"}) —
  "我要看这个现存 scene 的完整内容"
  3. （模型推理：这批新 memory 全归这个 scene）
  4. edit_file({path: "研究项目-FAIR催化剂数据层.md", old:
  "## 演变轨迹\n（暂无重大观念转变记录）", new: "##
  演变轨迹\n- [日期] 用户新发现：..."})
  5. 重复 read/edit 几次
  6. 最后输出 [PERSONA_UPDATE_REQUEST] 或不输出

  每一步 ≈ 1-3s（1 次 Claude 调用 +
  工具同步执行）。典型场景 5-15 步，总耗时 10-40s。

  Phase 4：清理（~10-50ms）
  扫 scene_blocks/*.md，把 LLM 用 [DELETED]
  标记的文件物理删掉（write_file 不允许写空，所以用这种
  soft-delete 约定）。

  Phase 5：sync scene_index（~50-100ms）
  重读所有 scene 文件，重新生成
  .metadata/scene_index.json。

  Phase 6：更新 persona.md 导航 TOC（~50-100ms）
  往 persona.md 头部更新一段 scene 列表。

  5.2 L3 评估：PersonaTrigger.shouldGenerate()

  代码：lib/tencentdb/persona/persona-trigger.ts

  纯规则判断，没 LLM。5 个优先级：
  - P1 用户显式请求
  - P2 冷启动（persona.md 不存在）
  - P2.5 恢复（persona 被删/损坏）
  - P3 首个 scene 创建后第一次
  - P4 自上次 persona 以来已积累 ≥ 5 条新 memory

  返回 {should: true/false, reason}。

  5.3 L3：PersonaGenerator.generate(reason)（条件触发）

  代码：lib/tencentdb/persona/persona-generator.ts

  跟 L2 是同一套——agentic LLM tool-use 循环，沙箱目录是
  dataDir（让 LLM 可以读 scene_blocks/* 也能写
  persona.md）。

  问 LLM 什么：
  - 系统提示词：「你是研究者画像生成器。读 scene_blocks
  里所有 scene，提炼出研究者的：(a) 当前研究项目、(b)
  长期偏好、(c) 工作模式、(d) 演变轨迹、(e) 涌现特征。写到
  persona.md，用 markdown，分章节（基本信息、Chapter
  1-4）。」
  - 用户提示词：「触发原因：。请读 scene_blocks/ 然后写。」

  典型工具序列：
  1. list_dir({path: "scene_blocks"})
  2. read_file({path: "scene_blocks/<scene1>.md"})
  3. read_file({path: "scene_blocks/<scene2>.md"})
  4. （推理...）
  5. write_file({path: "persona.md", content: "# User
  Narrative Profile\n..."})

  5-10 步，总耗时 8-30s。

  ---
  LLM 调用清单（单次完整流程，一个文件）

  #: 1
  调用方: L1 pipeline
  系统 prompt: EXTRACT_MEMORIES
  工具: 无
  任务: 把对话切成原子 memory，标
    type/priority/ontology_label
  耗时: 3-5s
  ────────────────────────────────────────
  #: 2
  调用方: L1 pipeline
  系统 prompt: CONFLICT_DETECTION
  工具: 无
  任务: 对每条新 memory 决定 store/merge/skip
  耗时: 2-3s（条件触发）
  ────────────────────────────────────────
  #: 3
  调用方: L2 SceneExtractor
  系统 prompt: scene-extraction
  工具: list_dir/read_file/write_file/edit_file
  任务: agentic 把 memory 安排到
  scene_blocks/*.md，自己规划
    CREATE/UPDATE/MERGE
  耗时: 10-40s (5-15 步)
  ────────────────────────────────────────
  #: 4
  调用方: L3 PersonaGenerator
  系统 prompt: persona-generation
  工具: 同上 + 沙箱到 dataDir
  任务: agentic 重写 persona.md
  耗时: 8-30s (5-10 步, 条件触发)

  一个文件的 LLM 时间预算：5 步 LLM 调用 ≈ 25-80s

  11 个文件 × 5 步并发 = 55 次 LLM 调用同时在 fucheers
  队列里抢资源

  ---
  真正的设计问题（不是 perf，是架构错位）

  错处: 每个文件 POST 都触发 L1
  位置: route.ts:59-64
  后果: 11 次文件 = 11 次 L1 = 11 次 L2 = 11 次 L3 评估 =
    雪崩
  ────────────────────────────────────────
  错处: if (shouldTriggerL1) {} else {} 两个分支干同一件事
  位置: route.ts:59-64
  后果: 死代码——开发者本意想 batch 但实现成了"每次都触发"
  ────────────────────────────────────────
  错处: L1 拉全部 sessionKey="files" 的 L0
  位置: l1-pipeline.ts:67
  后果: 第 N 个 L1 看到前 N-1 个文件的旧 L0，重复消化
  ────────────────────────────────────────
  错处: L2 agentic 循环没有跨 pipeline 锁
  位置: scene-extractor.ts:211
  后果: 两个并发 L2 同时改
    研究项目-FAIR催化剂数据层.md——后写覆盖先写
  ────────────────────────────────────────
  错处: L1.B 和 L2 都在做相似度合并
  位置: l1 dedup vs L2 scene 重组
  后果: 同一份语义合并工作做两遍
  ────────────────────────────────────────
  错处: 客户端 for+await 串行
  位置: sidebar.tsx:599
  后果: 网络利用率低，但其实是好事——服务端反正都已经在被并
  发轰炸了
  ────────────────────────────────────────
  错处: 没有 batch 端点
  位置: 接口设计
  后果: 11 个文件本是一个语义事务，被切成 11 个独立 HTTP
    请求

  ---
  正确的设计应该是

  客户端：
    scanTree → flattenFiles → 并发 4 路 POST
  /api/upload?triggerPipeline=false
    → 全部完成 → POST /api/upload/finalize?sessionKey=files
                  ↑ 服务端这里才触发 1 次 L1 pipeline
                    → 1 次 L2 pipeline → 1 次 L3 评估

  总 LLM 调用：5 步（不管几个文件），后台时长 25-80s。

  vs 现在的 11 文件 = 55+ 次 LLM 调用，时长
  120-180s，且有竞争写文件的 race condition。

  ---
  要继续按这个方案修 A 吗？或者你看完描述还想再问哪一段？

✻ Sautéed for 2m 37s

❯ Stage 3 为什么要chunk，能不能不chunk，还有，现在的逻辑是 
  ，所有同步的文件，都会变成L0？                           

⏺ 两个问题分开答。

  ---
  1. 为什么要 chunk？能不能不 chunk？

  现在的 chunk 逻辑

  代码：app/api/upload/route.ts:31 调
  splitIntoChunks(content,
  2000)，里面是按段落边界（\n{2,}）切，每块 ≤ 2000 字符。

  为什么是 2000？背后的（隐含）理由

  理由: (a) SQLite 存不下大字段
  是真问题吗: ❌ 假理由——SQLite TEXT 列默认上限 ~1GB，2KB
    完全是浪费空间限制
  ────────────────────────────────────────
  理由: (b) L1 抽取 prompt 怕爆 token
  是真问题吗: ✅ 真问题——l1-pipeline.ts:67 拉
    queryL0ForSession(sessionKey, 50)，然后取最近
    NEW_MESSAGES=10 条 + 前 BG_MESSAGES=5 条塞进
    prompt。如果一行 L0 是 50KB，prompt 就 750KB → fucheers

    不一定接得住，就算接住也慢得离谱
  ────────────────────────────────────────
  理由: (c) L0 被当成"对话消息"
  是真问题吗: ✅ 真正的根因——l0_conversations
    这张表名+表结构（role:
    user/assistant）就是为聊天对话设计的，单条消息预设是短
  的；文件被硬塞成"用户发了这一段"，自然要切短

  所以 chunk 这个动作其实在补救
  (c)——把一个不是对话的东西伪装成"对话消息"。

  不 chunk 会怎样

  直接的副作用：
  - 单文件 50KB → 1 行 L0
  - L1 抽取时 queryL0ForSession(50) 拉了 50 行，每行 50KB →
   prompt 2.5MB 输入。fucheers 大概率超时或返回非 JSON
  - 即使不超时，3-5s 的 L1 调用会变成 30-60s

  好处：
  - 文件保持语义完整，L1 能正确抽出 claim/method 而不是
  "...碎句子"
  - L0 显示给用户时不会出现"第 3/15 段"这种割裂感
  - 跨段引用（"如上文所述"）不会断

  三种修法

  方案: A 加大 chunk size 到 ~8-10KB
  改动量: 改 route.ts:31 一个数字
  效果: 行数减少 4-5 倍，prompt 不爆但也不一定能塞满 1
    个完整文件
  ────────────────────────────────────────
  方案: B 单独存文件，不进 l0_conversations
  改动量: 新建 l0_documents 表，新 queryL0ForExtraction
    函数同时拉 conversations + documents
  效果: 干净，但要改 L1 pipeline + recall + search 多处
  ────────────────────────────────────────
  方案: C 不 chunk，但 L1 抽取只挑当前 sessionKey 最新 1
    个文件
  改动量: 改 L1 selection 策略
  效果: 中等改动，文件保持完整，但要重做"什么时候触发 L1"

  我会推荐
  B——把文件和对话从一开始就分到两张表，问题最干净。

  ---
  2. 是的，所有同步的文件都变 L0（但有筛选）

  现在被同步进 L0 的范围

  代码：sidebar.tsx:52-61, 505-531

  const TEXT_EXTS = [".txt", ".md", ".tex", ".rst", ".csv",
   ".json", ".yaml", ".yml"];
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif",
  ".webp"];

  function classifyFile(name) { return { isText: ...,
  isImage: ... }; }

  for (const node of files) {
    if (!node.isText) continue;        // ← 关键过滤
    await fetch("/api/upload", ...);
  }

  所以实际上传到 L0 的只有：上面 8 种扩展名的文件。

  文件类型: .md / .txt / .tex / .rst / .csv / .json / .yaml

    / .yml
  同步进 L0 吗？: ✅ 是
  ────────────────────────────────────────
  文件类型: .png / .jpg 等图片
  同步进 L0 吗？: ❌
    否——只在树里列出，要点击才会以图片附件挂到聊天框
  ────────────────────────────────────────
  文件类型: .pdf
  同步进 L0 吗？: ❌ 否！（classifyFile 不认
    .pdf；虽然单文件上传的 <input> 写了 accept=".pdf"，但
    server 端也没解析 PDF 二进制）
  ────────────────────────────────────────
  文件类型: .docx / .pptx / .zip 等二进制
  同步进 L0 吗？: ❌ 否

  写进 L0 时的格式（每个文件）

  代码：app/api/upload/route.ts:34-55

  每个 chunk 写成一行：
  record_id:   l0_file_<timestamp>_<chunkIdx>_<hex>
  session_key: "files"             ←
  全部硬编码，所有同步文件共享
  session_id:  <文件夹名 ELN>
  role:        "user"               ←
  文件内容被伪装成"用户发的消息"
  message_text: "[来自文件 path/to/file.md
  第3/15段]\n\n<chunk 内容>"
  recorded_at: <现在>

  每个文件结束后还多写一行 synthetic assistant 应答：
  role:        "assistant"
  message_text: "已读取文件
  path/to/file.md，内容已加入研究记忆库。"

  → 这个 ack 行纯粹是为了凑成 user/assistant 对话对，让 L1
  extraction prompt
  看起来像"对话"。这是另一个"文件伪装成对话"的痕迹。

  实际效果（你 ELN 文件夹 11 个文件）

  如果 11 个 .md 文件平均 8KB：
  - chunk 数：每个文件切 4-5 块 → 共 ~45 行 L0 (user)
  - ack 行：11 行 L0 (assistant)
  - 总 L0 行数：~56 行

  加上你之前聊天的 1500 多行 L0 → 现在数据库里 L0 大概
  1600+ 行，其中 ~3.5% 是文件、~96.5% 是真聊天。但 PDF
  文件没进 L0——文件夹里有几个 PDF 都被悄悄跳过了。

  ---
  不 chunk + 文件归文件、对话归对话 的方案（推荐方向）

  -- 现状
  CREATE TABLE l0_conversations (
    record_id TEXT, session_key TEXT, session_id TEXT,
    role TEXT, message_text TEXT, recorded_at TEXT,
  timestamp INTEGER
  );

  -- 推荐：分开
  CREATE TABLE l0_conversations ( ... );   -- 只装真对话
  CREATE TABLE l0_documents (              -- 装文件
    record_id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,             -- 完整文件路径
    source_kind TEXT NOT NULL,             -- "md" / "pdf"
  / "tex" ...
    content TEXT NOT NULL,                 -- 整文件，不
  chunk
    byte_size INTEGER,
    ingested_at TEXT NOT NULL
  );
  -- 再各自有自己的 FTS5 索引

  L1 pipeline 改动：从 "拉 50 条 L0 → 切 bg/new" 改成
  "对每个新进的 document 单独跑一次
  extraction（一次塞一整篇）+ 对话部分照旧"。文件级别
  extraction 用 sub-prompt
  模板（专门给文档的，不假装是对话）。

  recall + search 改动：recallForQuery /
  tdai_conversation_search 要同时查两张表 + 合并排序。

  改动量评估：3-5 小时。涉及：
  - 新表 + 新 insert/query 函数
  - L1 pipeline 双路径（文档/对话）
  - recall 改双源
  - /api/upload 改成写文档表 + 一次性 finalize 触发
  - sidebar 加 PDF 支持（要么后端用 pdf-parse
  解析、要么前端用 PDF.js）

  ---
  该不该现在动？

  我建议：

  ┌───────┬────────────────────────────────────────────┐
  │ 优先  │                    任务                    │
  │  级   │                                            │
  ├───────┼────────────────────────────────────────────┤
  │       │ A 的"每个文件触发一次 L1"                  │
  │ 🔥 P0 │ 死循环必须修——这个是 critical              │
  │       │ bug，不修同步会一直雪崩                    │
  ├───────┼────────────────────────────────────────────┤
  │ 🟡 P1 │ chunk 改成 ~8KB（一个简单的常量调整）      │
  ├───────┼────────────────────────────────────────────┤
  │ 🟢 P2 │ 文件归文件、对话归对话（架构正确，但工作量 │
  │       │ 大）                                       │
  ├───────┼────────────────────────────────────────────┤
  │ 🟢 P3 │ PDF 解析支持（需要选 pdf-parse 或 PDF.js   │
  │       │ 后端方案）                                 │
  └───────┴────────────────────────────────────────────┘

  要不就先做 P0 + P1（≈40min），让同步先能正常工作，P2/P3
  是后续优化？还是你想直接架构重做？

✻ Brewed for 1m 34s

❯ 太怪了，回去理解一下https://github.com/Tencent/TencentDB 
  -Agent-Memory/blob/main/README_CN.md 这个是怎么用的，我  
  不理解为什么要调用这么多次LLM，你帮我理解一下            

⏺ 去读原版 README 和源码，搞清楚原版的调用模型。

  Listed 1 directory (ctrl+o to expand)

⏺ 研究任务，不开新 task。先看本地存档的中文 README：

  Read 1 file (ctrl+o to expand)

⏺ 关键发现在 README
  的「可调参数」里。让我看一下原版的入口和实际触发逻辑：

  Searched for 4 patterns, read 2 files (ctrl+o to expand)

⏺ 研究阶段，不开新 task。我已经看到关键差异——让我再看一下
  L2 调度的间隔控制：

  Searched for 1 pattern, read 1 file (ctrl+o to expand)

⏺ 读完了，原版的设计完全不是这么"每个事件触发一次"。问题不
  是性能、不是架构小毛病，是我们根本没移植它的调度层。下面
  一段一段对比讲清楚。

  ---
  1. 原版 README 写得很明白：LLM 调用是稀疏的、有节流的

  README_CN.md Level 1 / Level 2 调参表里有 4
  个关键参数，全都是节流阀：

  参数: pipeline.everyNConversations
  默认: 5
  含义: 每 5 轮对话才触发一次 L1
    抽取——不是每条消息，不是每个事件
  ────────────────────────────────────────
  参数: pipeline.l1IdleTimeoutSeconds
  默认: 600 (10 分钟)
  含义: 如果用户停止对话 10 分钟，把缓冲区里剩下的零头
  flush
    成一次 L1
  ────────────────────────────────────────
  参数: pipeline.l2MinIntervalSeconds
  默认: 900 (15 分钟)
  含义: 同一个 session 两次 L2 之间最少隔 15 分钟——硬节流
  ────────────────────────────────────────
  参数: pipeline.l2DelayAfterL1Seconds
  默认: (默认 30+)
  含义: L1 写完后故意延迟这么久才考虑跑 L2，让 L1 写入沉淀
  ────────────────────────────────────────
  参数: persona.triggerEveryN
  默认: 50
  含义: 每 50 条新记忆才触发一次 L3 画像生成

  意思一目了然：原版设计是「让 Agent 在用户完全不打扰的间隙
  里慢慢消化记忆」，不是「事件来了就消化」。

  ---
  2. 原版调度器在源码里长什么样

  代码：_archive/tencentdb-memory/src/utils/pipeline-manage
  r.ts

  每个 session 维护一个消息缓冲区 + 3 个 timer：

  // :400-402  把新消息往 buffer 里塞，不立即处理
  const buffer = this.messageBuffers.get(sessionKey) ?? [];
  buffer.push(...messages);
  this.messageBuffers.set(sessionKey, buffer);

  // :417-422  只有 conversation_count 达到 threshold 才入
  L1 队列
  if (state.conversation_count >= effectiveThreshold) {
    this.enqueueL1(sessionKey);   // ← 这里才真正排队跑
  L1（一次处理整个 buffer）
    return;
  }

  // :426  没到 threshold → 重置 idle timer
  timers.l1Idle.schedule(this.l1IdleTimeoutMs, () =>
  this.onL1IdleTimeout(sessionKey));

  L2 的调度（:763-790）更精细：

  private advanceL2Timer(sessionKey: string): void {
    const lastL2 = this.l2LastRunTime.get(sessionKey) ?? 0;
    const minIntervalFloor = lastL2 > 0 ? lastL2 +
  this.l2MinIntervalMs : 0;
    // 想要的触发时间 = max(now + delay_after_L1,
  last_L2_time + min_interval)
    const desiredTime = Math.max(now +
  this.l2DelayAfterL1Ms, minIntervalFloor);
    // downward-only：只能往**更早**调，不会无限延后
    timers.l2Schedule.tryAdvanceTo(desiredTime, () =>
  this.onL2TimerFired(sessionKey, "..."));
  }

  关键性质：
  1. 批处理：L1 一次处理整个 buffer，不是「一个消息一次
  L1」
  2. 同 session 互斥 + 全局节流：两次 L2 之间硬性等 15 分钟
  3. 冷启动 warm-up：新 session 用 1→2→4→8→16 的方式倍增
  threshold（避免一开始太敏感）
  4. 跨 session 时间衰减：长时间不活跃的 session 会被 GC
  出内存

  ---
  3. 原版没有「上传文件」这个 API

  我去看了所有公开入口（tdai-core.ts）：

  ┌─────────────────────────┬──────────────────────────┐
  │          方法           │           含义           │
  ├─────────────────────────┼──────────────────────────┤
  │                         │ 唯一写入入口——表示"一个  │
  │ handleTurnCommitted(tur │ 完整的 agent             │
  │ n)                      │ 对话回合结束了"。host    │
  │                         │ 调一次 = 1 turn          │
  ├─────────────────────────┼──────────────────────────┤
  │ handleBeforeRecall(...) │ 召回查询                 │
  ├─────────────────────────┼──────────────────────────┤
  │ handleSessionEnd(sessio │ 刷掉这个 session 的      │
  │ nKey)                   │ buffer                   │
  ├─────────────────────────┼──────────────────────────┤
  │ searchMemories /        │ tool 入口                │
  │ searchConversations     │                          │
  └─────────────────────────┴──────────────────────────┘

  没有 ingest 文件的概念。在 OpenClaw / Hermes
  集成里，文件上传是 agent host 自己的事——文件内容会被 host
   作为用户消息塞进对话，整个 agent 回合结束后 host 调一次
  handleTurnCommitted，把这次回合的所有消息（包括包含文件的
  那条）统一交给 memory pipeline。

  所以原版的"11 个文件被同步"对应的应该是：
  - 要么 1 个 agent turn 里包含 11 条文件消息 → 1 次
  handleTurnCommitted → buffer 里多了 11 条消息 → 看
  threshold 决定要不要触发 L1
  - 要么 11 个独立 turn → 每次 handleTurnCommitted 只
  buffer 不触发 → 等 conversation_count ≥ 5 才触发 1 次 L1
  处理整个 buffer

  绝对不可能是 11 × L1 + 11 × L2。

  ---
  4. 我们的实现做错了什么

  设计点: L1 触发时机
  原版: conversation_count ≥ 5 turn OR 10min idle
  我们: 每个上传 + 每 5 turn——upload route 里强制每次触发
  ────────────────────────────────────────
  设计点: L1 输入
  原版: session 的整个消息 buffer（批处理）
  我们: 拉 session 最近 50 条 L0，每次都拉，重复消化
  ────────────────────────────────────────
  设计点: L2 触发时机
  原版: L1 完成 + 等 30s 延迟 + ≥15min 距上次 L2
  我们: 每次 L1 完成都立刻触发，无任何节流
  ────────────────────────────────────────
  设计点: L3 触发时机
  原版: 累积 ≥50 条新记忆
  我们: 用 PersonaTrigger 5 优先级里宽松的判断（hackathon
    demo 阈值放低）
  ────────────────────────────────────────
  设计点: 文件 ingestion
  原版: 不存在这个概念；文件是 agent host 自己处理后塞进
    turn
  我们: 自创了 /api/upload 把文件伪装成 user/assistant
    对话直接进 L0

  我们的代码只移植了 L0/L1/L2/L3 的 4 个 pipeline
  步骤本身，但没移植包在外面的 scheduler/buffer/rate-limite
  r——也就是原版的整个"什么时候才该跑"的智能。结果：每个上传
  变成"立刻跑全套"，等于把节流阀全拆了。

  ---
  5. 11 个文件在原版会怎样消化

  假设 11 个文件被 host 当成 1 个 agent turn
  一次性塞进来（这是最自然的方式）：

  T+0       handleTurnCommitted(turn with 11 file messages)
              → buffer += 11 条
              → conversation_count += 1 (一次 turn 算
  1，不管多少消息)
              → 1 < 5，不触发 L1，启动 10min idle timer

  T+10min   idle timer 烧到 → 触发 1 次 L1（处理 buffer
  里的 11 条）
              → 1 次 LLM extraction（可能多次 dedup
  子调用）
              → 写入 L1 → 触发 L2 timer，desiredTime =
  T+10min+30s = T+10min30s

  T+10min30s L2 timer 烧到 → 检查
  minIntervalFloor，第一次跑没有 floor
              → 1 次 L2 agentic 循环（5-15 步）

  T+...     如果 L1 累计写入的记忆 ≥ 50，再触发 1 次 L3

  总 LLM 调用：1 次 L1 + 1 次 L2 agentic（5-15 步）= 6-16
  次 Claude 调用

  vs 我们的实现：22 次 L1 (11×2) + 11 次 L2 agentic (50-150
   步) = 70-170 次 Claude 调用

  差了一个数量级。

  ---
  6. 修法

  不是 把 chunk size 改大、不是 加批量 API——这些都是表面。

  根本修复是把原版 PipelineManager（_archive/.../utils/pipe
  line-manager.ts，约 1000 行）移植过来：

  ┌──────────────────────────────┬─────────────────────┐
  │          必须移植的          │       干啥的        │
  ├──────────────────────────────┼─────────────────────┤
  │ messageBuffers:              │ per-session 缓冲区  │
  │ Map<sessionKey, Message[]>   │                     │
  ├──────────────────────────────┼─────────────────────┤
  │ conversation_count +         │ 计数+阈值触发 L1    │
  │ threshold                    │                     │
  ├──────────────────────────────┼─────────────────────┤
  │ l1Idle timer                 │ 静默回收剩余消息    │
  ├──────────────────────────────┼─────────────────────┤
  │ l2Schedule timer +           │                     │
  │ l2MinInterval +              │ L2 双重节流         │
  │ l2DelayAfterL1               │                     │
  ├──────────────────────────────┼─────────────────────┤
  │ warmup_threshold 1→2→4→8     │ 冷启动渐进          │
  ├──────────────────────────────┼─────────────────────┤
  │ enqueueL1 / enqueueL2        │ 同 session 内 L1/L2 │
  │ SerialQueue                  │  互斥串行           │
  └──────────────────────────────┴─────────────────────┘

  文件上传场景就不要走
  handleTurnCommitted——文件应该走另一条路径（参考前面讨论的
  "文件归文件、对话归对话"），写入完成后手动给
  PipelineManager 发一个 "flush this session"
  信号（或者干脆不触发，等用户下次对话时自然触发）。

  ---
  总结一句话

  你的直觉是对的——根本就不该调这么多次 LLM。
  原版从一开始就是设计成稀疏批处理 +
  节流，我们只搬了"做什么"没搬"什么时候做"，所以变成事件驱
  动的雪崩。要修就得把原版的 PipelineManager 完整移植过来。

  要现在动手吗？这个移植大概 2-3 小时（pipeline-manager.ts
  自带的逻辑是完备的，主要是适配我们的 store
  interface），做完之后 A 整个问题（同步慢、雪崩、文件污染
  L0）会一起被根治。



（1）中英文功能，可以让codex加
（2）确定清楚之前的记忆链怎么实现


