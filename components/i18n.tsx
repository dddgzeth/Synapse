"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Language = "en" | "zh";

export interface ApiSettings {
  /** "" | "default" = server env; else "fucheers" | "openai" | "anthropic". */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  apiSettings: ApiSettings;
  setApiSettings: (settings: ApiSettings) => void;
  t: typeof translations.en;
  locale: "en-US" | "zh-CN";
}

const LANGUAGE_KEY = "synapse.language";
const API_SETTINGS_KEY = "synapse.apiSettings";

const defaultApiSettings: ApiSettings = {
  provider: "",
  apiKey: "",
  baseUrl: "",
  model: "",
};

export const translations = {
  en: {
    common: {
      loading: "Loading...",
      loadFailed: "Failed to load",
      close: "Close",
      cancel: "Cancel",
      save: "Save",
      saved: "Saved",
      search: "Search",
      copied: "Copied",
      path: "Path",
      none: "(empty)",
      delete: "Delete",
      confirmDeleteInsight: "Delete this insight?",
      confirmDeleteConversation: "Delete this conversation?",
      backToChat: "← Back to chat",
      created: "Created",
      updated: "Updated",
      updatedAt: "Updated",
      heat: "Heat",
      items: "items",
      memories: "memories",
      turns: "turns",
    },
    account: {
      name: "Local profile",
      plan: "Synapse workspace",
      settings: "Settings",
      language: "Language",
      apiSettings: "API Settings",
      mcpTools: "Connect AI tools",
      logout: "Log out",
      english: "English",
      chinese: "中文",
    },
    apiSettings: {
      title: "API Settings",
      description: "These values are stored locally in this browser and sent with chat or deep research requests when filled.",
      provider: "Provider",
      providerDefault: "Default (server)",
      providerFucheers: "fucheers (proxy)",
      providerOpenai: "OpenAI (direct)",
      providerAnthropic: "Anthropic (direct)",
      apiKey: "API Key",
      apiKeyPlaceholder: "sk-...",
      baseUrl: "Base URL",
      baseUrlPlaceholder: "https://api.example.com/v1",
      model: "Model",
      modelPlaceholder: "claude-sonnet-4-6",
      clear: "Clear",
    },
    tools: {
      connectedTools: "Connected Tools",
      connectATool: "+ Connect a tool",
      readOnlyArchive: "Read-only archive",
      empty: "No conversations archived from this tool yet.",
      emptyHint: "No tools connected yet. Click below to connect Claude Code, Codex, Cursor…",
      you: "You",
    },
    auth: {
      title: "Sign in to Synapse",
      subtitle: "Continue with Google or use the test email account.",
      continueWithGoogle: "Continue with Google",
      openingGoogle: "Opening Google...",
      or: "or",
      email: "Email",
      password: "Password",
      signIn: "Sign in",
      signingIn: "Signing in...",
      invalidCredentials: "Invalid email or password",
    },
    sidebar: {
      memoryStats: (memories: number, turns: number) => `${memories} memories · ${turns} turns`,
      loadingStats: "Loading...",
      exportMemories: "Export all memories",
      exportMemoriesTitle: "Download every memory layer (L0–L3 + insights) as a single JSON file",
      newInsightTitle: "Synapse noticed a new insight",
      newInsight: "New insight",
      searchPlaceholder: "Search conversations...",
      searchResults: (count: number) => `Search results (${count})`,
      noResults: "No matching memories",
      localFolders: "Local folders",
      connectFolder: "+ Connect folder",
      scanning: "Scanning...",
      ahaHistory: (count: number) => `Insight history (${count})`,
      persona: "Persona (L3)",
      scenes: (count: number) => `Scenes (L2 · ${count})`,
      recentMemories: (count: number) => `Recent memories (L1 · ${count})`,
      emptyMemories: "Start chatting and Synapse will build working memory here.",
      cached: "Cached",
      ready: "Ready",
      needsAuth: "Reauthorization needed",
      scanProgress: (count: number) => `Scanning... ${count} found`,
      remove: "Remove",
      reauthorize: "Reauthorize access",
      fileTitleClickable: (path: string) => `${path}\nClick to attach this file to the input`,
      fileTitleUnsupported: (path: string) => `${path}\nUnsupported file type`,
      copyPath: (path: string) => `Copy full path\n${path}`,
      copyPathLabel: "Copy full path",
      viewPersona: "View full persona →",
    },
    typeLabels: {
      claim: "Claim",
      method: "Method",
      observation: "Observation",
      dataset: "Dataset",
      experiment: "Experiment",
      finding: "Finding",
      question: "Question",
      goal: "Goal",
      resource: "Resource",
      task: "Task",
    },
    chat: {
      thinking: "Synapse is thinking...",
      deepThinking: "Searching and analyzing...",
      placeholder: "Ask anything, or paste an image...",
      attachTitle: "Attach a file or image",
      deepResearchTitle: "Search Semantic Scholar + arXiv with the deep research model",
      stop: "Stop",
      send: "Send",
      viewChat: "Chat",
      viewPage: "Page",
      viewChatTitle: "Show the original chat reply",
      viewPageTitle: "Show this reply as a structured page (generated on demand)",
      viewPageLoading: "Composing page view…",
      viewPageEmpty: "No content to render as a page.",
      viewPageRetry: "Retry",
      exportHtml: "Export HTML",
      exportHtmlTitle: "Download this rendered page as an HTML file",
      exportPng: "Export PNG",
      exportPngTitle: "Save this page as a PNG image",
      hint: "Enter to send · Shift+Enter for new line · Paste images directly",
      filePrompt: "Please answer based on the files above.",
      emptyCopy: "Synapse remembers your conversations and builds working context over time, surfacing patterns and connections you may not have noticed.",
      cards: [
        { icon: "💬", label: "Chat directly", desc: "Ask, discuss, and organize ideas" },
        { icon: "📁", label: "Attach files", desc: "Sync local documents or notes" },
        { icon: "🌐", label: "Research online", desc: "Search and analyze external literature" },
      ],
      searchFailed: "Search failed",
      networkError: "Network error",
      references: "References",
      deepDescription: "Send the current input as a deep research query. Uses the miromind deep-research model to search Semantic Scholar + arXiv, combining your long-term memory and the current chat context.",
      deepEmptyHint: "Write your research question in the input first, then click here.",
      deepPlaceholder: "Enter a question for deep analysis...",
      deepStarting: "⚡ **Deep Research** · starting…",
      deepHeader: "⚡ **Deep Research**",
      deepResults: "results",
      deepSteps: "steps",
      deepThinkingLabel: "🧠 Thinking",
      deepCollapse: "Collapse",
      deepExpand: "Expand",
      deepAborted: "Cancelled by you",
      deepNoFinal: "No final answer received before the stream ended.",
      shortcutSearch: "⌘↵ Search",
      startSearch: "Start search",
      searching: "Searching...",
      progress: {
        tools: {
          list_synced_files: "Scanning folder",
          read_synced_file: "Reading file",
          tdai_memory_search: "Searching memory",
          tdai_conversation_search: "Searching conversations",
          fallback: (name: string) => name,
        },
        thinkingWithContext: (chars: string) => `Thinking... (context ${chars})`,
        compactedAfterTimeout: "Compacted after timeout",
        compactedAfterContextError: "Model rejected long context; compacted and retried",
        compactedAfterBudget: "Context exceeded budget; compacted",
        contextTooLongRetry: "The model rejected the request as too long. Compacting the largest tool result and retrying.",
        requestTimedOut: "Request timed out. Synapse did not auto-compact the context; try splitting the task into smaller steps or retry later.",
        contextStillTooLong: "The request still exceeds the model context window after compaction. Split the files or question into smaller batches.",
        contextTooLongNoCompactable: "The model rejected the request as too long, but there is no compactable tool result. Split the task or reduce the synced-folder content.",
        internalError: "Synapse hit an internal error.",
        providerError: "The model provider returned an error.",
        noOutput: "(no output)",
        truncated: "...[truncated]",
        chars: "chars",
      },
    },
    details: {
      sceneEyebrow: "L2 · Scene",
      memoryEyebrow: "L1 · Memory",
      memoryFallback: "Memory",
      l1Content: "L1 content",
      l0Conversation: (count: number) => `Original conversation (L0 · ${count} items)`,
      noL0: "(This memory has no linked L0 source messages)",
      personaEyebrow: "L3 · Long-term persona",
      personaTitle: "Persona",
      personaEmpty: "No persona has been generated yet. Keep chatting and Synapse will generate your researcher persona after enough memory accumulates.",
    },
    aha: {
      noticed: "Synapse noticed",
      whyEvidence: "Why this is evidence",
      noData: "No Aha data yet. Keep chatting to accumulate memories first.",
      noCache: "No cached Aha data",
      fullInsight: "View full insight ↓",
      collapse: "Collapse ↑",
      showEvidence: "View evidence chain ▼",
      hideEvidence: "Hide evidence chain ▲",
      loadingGraph: "Loading evidence graph...",
      evidenceCount: (count: number) => `${count} evidence items`,
      clickExpand: "Click to expand →",
      misc: "Misc",
      scene: "Scene",
      miscSummary: (count: number) => `${count} memories are not matched to any scene`,
      narrative: "Narrative",
      hypothesis: "Hypothesis",
      reframe: "Reframe",
      scopeScenes: (n: number) => `${n} ${n === 1 ? "scene" : "scenes"}`,
      scopeMemories: (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`,
      scopeDays: (n: number) => `${n} ${n === 1 ? "day" : "days"}`,
      trajectoryRail: "Trajectory over time",
      themeRail: "Theme threads across scenes",
      detectedAt: "Detected",
      summary: "Summary",
      supportingMemories: "Supporting memories",
      maxPriority: "Max priority",
      type: "Type",
      priority: "Priority",
      created: "Created",
      expandRemaining: (count: number) => `Expand remaining ${count} chars ▼`,
    },
  },
  zh: {
    common: {
      loading: "加载中…",
      loadFailed: "加载失败",
      close: "关闭",
      cancel: "取消",
      save: "保存",
      saved: "已保存",
      search: "搜索",
      copied: "已复制",
      path: "路径",
      none: "(无内容)",
      delete: "删除",
      confirmDeleteInsight: "确认删除这条洞察？",
      confirmDeleteConversation: "确认删除这个对话？",
      backToChat: "← 返回对话",
      created: "创建",
      updated: "更新",
      updatedAt: "更新于",
      heat: "热度",
      items: "条",
      memories: "记忆",
      turns: "轮",
    },
    account: {
      name: "本地身份",
      plan: "Synapse 工作区",
      settings: "设置",
      language: "语言",
      apiSettings: "API 设置",
      mcpTools: "连接 AI 工具",
      logout: "退出登录",
      english: "English",
      chinese: "中文",
    },
    apiSettings: {
      title: "API 设置",
      description: "这些值会保存在当前浏览器本地；填写后，聊天和深度研究请求会带上这些设置。",
      provider: "模型后端",
      providerDefault: "默认（服务器环境变量）",
      providerFucheers: "fucheers（代理）",
      providerOpenai: "OpenAI（直连）",
      providerAnthropic: "Anthropic（直连）",
      apiKey: "API Key",
      apiKeyPlaceholder: "sk-...",
      baseUrl: "Base URL",
      baseUrlPlaceholder: "https://api.example.com/v1",
      model: "Model",
      modelPlaceholder: "claude-sonnet-4-6",
      clear: "清空",
    },
    tools: {
      connectedTools: "已连接的工具",
      connectATool: "+ 连接一个工具",
      readOnlyArchive: "只读归档",
      empty: "这个工具还没有归档任何对话。",
      emptyHint: "还没有连接工具。点下方连接 Claude Code / Codex / Cursor…",
      you: "你",
    },
    auth: {
      title: "登录 Synapse",
      subtitle: "使用 Google 登录，或用测试邮箱账号进入。",
      continueWithGoogle: "使用 Google 继续",
      openingGoogle: "正在打开 Google…",
      or: "或",
      email: "邮箱",
      password: "密码",
      signIn: "登录",
      signingIn: "登录中…",
      invalidCredentials: "邮箱或密码不正确",
    },
    sidebar: {
      memoryStats: (memories: number, turns: number) => `${memories} 条记忆 · ${turns} 轮`,
      loadingStats: "载入中…",
      exportMemories: "导出全部记忆",
      exportMemoriesTitle: "把所有记忆层（L0–L3 + 洞察）下载成一个 JSON 文件",
      newInsightTitle: "Synapse 注意到一条新的发现",
      newInsight: "新发现",
      searchPlaceholder: "搜索对话…",
      searchResults: (count: number) => `搜索结果 (${count})`,
      noResults: "无匹配记忆",
      localFolders: "本地文件夹",
      connectFolder: "+ 连接文件夹",
      scanning: "扫描中…",
      ahaHistory: (count: number) => `历史发现 (${count})`,
      persona: "个人画像 (L3)",
      scenes: (count: number) => `主题场景 (L2 · ${count})`,
      recentMemories: (count: number) => `最近记忆 (L1 · ${count})`,
      emptyMemories: "开始对话后，Synapse 会在这里积累你的工作记忆。",
      cached: "已缓存",
      ready: "已就绪",
      needsAuth: "需重新授权",
      scanProgress: (count: number) => `扫描中… 已发现 ${count} 个`,
      remove: "移除",
      reauthorize: "重新授权访问",
      fileTitleClickable: (path: string) => `${path}\n点击挂到输入框，针对此文件提问`,
      fileTitleUnsupported: (path: string) => `${path}\n暂不支持该文件类型`,
      copyPath: (path: string) => `复制完整路径\n${path}`,
      copyPathLabel: "复制完整路径",
      viewPersona: "📖 查看完整画像 →",
    },
    typeLabels: {
      claim: "观点",
      method: "方法",
      observation: "观察",
      dataset: "数据集",
      experiment: "实验",
      finding: "发现",
      question: "问题",
      goal: "目标",
      resource: "资源",
      task: "任务",
    },
    chat: {
      thinking: "Synapse 正在思考…",
      deepThinking: "正在联网搜索分析…",
      placeholder: "输入任何问题，或粘贴图片…",
      attachTitle: "附加文件或图片",
      deepResearchTitle: "用深度研究模型搜索 Semantic Scholar + arXiv 学术数据库",
      stop: "停止",
      send: "发送",
      viewChat: "对话",
      viewPage: "页面",
      viewChatTitle: "显示原始对话回复",
      viewPageTitle: "把这条回复显示成结构化页面（点击时按需生成）",
      viewPageLoading: "正在排版页面视图…",
      viewPageEmpty: "暂时没有可渲染为页面的内容。",
      viewPageRetry: "重试",
      exportHtml: "导出 HTML",
      exportHtmlTitle: "把当前页面视图下载为 HTML 文件",
      exportPng: "导出 PNG",
      exportPngTitle: "把当前页面保存为 PNG 图片",
      hint: "Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片",
      filePrompt: "请基于以上文件回答。",
      emptyCopy: "Synapse 记住你所有的对话，随时间积累工作上下文，在你没注意到的地方，悄悄发现规律与联系。",
      cards: [
        { icon: "💬", label: "直接对话", desc: "提问、讨论、整理想法" },
        { icon: "📁", label: "上传文件", desc: "同步本地文档或笔记" },
        { icon: "🌐", label: "联网分析", desc: "搜索外部文献，深度研读" },
      ],
      searchFailed: "搜索失败",
      networkError: "网络错误",
      references: "参考来源",
      deepDescription: "把当前输入框里的问题作为深度调研，用 miromind 的深度研究模型搜索 Semantic Scholar + arXiv，结合你的长期记忆和本次对话上下文给出综合分析。",
      deepEmptyHint: "先在输入框里写要调研的问题，再点这里。",
      deepPlaceholder: "输入你想深度分析的问题…",
      deepStarting: "⚡ **Deep Research** · 启动中…",
      deepHeader: "⚡ **Deep Research**",
      deepResults: "条结果",
      deepSteps: "步",
      deepThinkingLabel: "🧠 思考过程",
      deepCollapse: "折叠",
      deepExpand: "展开",
      deepAborted: "你已中止",
      deepNoFinal: "流结束时还没有产出最终答案。",
      shortcutSearch: "⌘↵ 搜索",
      startSearch: "开始搜索",
      searching: "搜索分析中…",
      progress: {
        tools: {
          list_synced_files: "扫描文件夹",
          read_synced_file: "读取文件",
          tdai_memory_search: "搜索记忆",
          tdai_conversation_search: "搜索对话",
          fallback: (name: string) => name,
        },
        thinkingWithContext: (chars: string) => `思考中…（上下文 ${chars}）`,
        compactedAfterTimeout: "超时后已压缩重试",
        compactedAfterContextError: "模型拒绝长上下文，已压缩并重试",
        compactedAfterBudget: "上下文超出预算，已压缩",
        contextTooLongRetry: "模型返回上下文过长错误，正在压缩最大的一段工具结果后重试。",
        requestTimedOut: "请求超时。Synapse 没有自动压缩上下文；建议拆成更小的步骤，或稍后重试。",
        contextStillTooLong: "压缩重试后仍然超过模型上下文窗口。建议把文件或问题拆成更小的批次。",
        contextTooLongNoCompactable: "模型返回上下文过长错误，但当前没有可压缩的工具结果。建议拆分任务或减少同步文件夹内容。",
        internalError: "Synapse 遇到内部错误。",
        providerError: "模型服务返回错误。",
        noOutput: "(无输出)",
        truncated: "…[已截断]",
        chars: "字符",
      },
    },
    details: {
      sceneEyebrow: "L2 · 主题场景",
      memoryEyebrow: "L1 · 单条记忆",
      memoryFallback: "记忆",
      l1Content: "L1 内容",
      l0Conversation: (count: number) => `原始对话 (L0 · ${count} 条)`,
      noL0: "（这条记忆没有可关联的 L0 原始消息）",
      personaEyebrow: "L3 · 长期画像",
      personaTitle: "个人画像",
      personaEmpty: "画像尚未生成。继续对话后，Synapse 会在积累足够记忆后自动生成你的研究者画像。",
    },
    aha: {
      noticed: "Synapse 注意到",
      whyEvidence: "为什么它是证据",
      noData: "暂无 Aha 数据。请先用 chat 累积一些记忆。",
      noCache: "暂无缓存的 Aha 数据",
      fullInsight: "查看完整洞察 ↓",
      collapse: "收起 ↑",
      showEvidence: "查看证据链 ▼",
      hideEvidence: "收起证据链 ▲",
      loadingGraph: "加载证据图…",
      evidenceCount: (count: number) => `${count} 条证据`,
      clickExpand: "点击展开 →",
      misc: "杂项",
      scene: "主题场景",
      miscSummary: (count: number) => `${count} 条记忆未能匹配到任何主题场景`,
      narrative: "叙事",
      hypothesis: "假说",
      reframe: "重新理解",
      scopeScenes: (n: number) => `跨 ${n} 个场景`,
      scopeMemories: (n: number) => `${n} 条记忆`,
      scopeDays: (n: number) => `跨越 ${n} 天`,
      trajectoryRail: "时间序证据链",
      themeRail: "跨场景反复出现的主题",
      detectedAt: "检测时间",
      summary: "摘要",
      supportingMemories: "支撑记忆",
      maxPriority: "最高优先级",
      type: "类型",
      priority: "优先级",
      created: "创建",
      expandRemaining: (count: number) => `展开剩余 ${count} 字 ▼`,
    },
  },
};

export type TranslationSet = typeof translations.en;

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const [apiSettings, setApiSettingsState] = useState<ApiSettings>(defaultApiSettings);

  useEffect(() => {
    const storedLanguage = window.localStorage.getItem(LANGUAGE_KEY);
    if (storedLanguage === "en" || storedLanguage === "zh") {
      setLanguageState(storedLanguage);
    }

    const storedApiSettings = window.localStorage.getItem(API_SETTINGS_KEY);
    if (storedApiSettings) {
      try {
        setApiSettingsState({ ...defaultApiSettings, ...JSON.parse(storedApiSettings) });
      } catch {
        setApiSettingsState(defaultApiSettings);
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    window.localStorage.setItem(LANGUAGE_KEY, language);
  }, [language]);

  const setApiSettings = (settings: ApiSettings) => {
    setApiSettingsState(settings);
    window.localStorage.setItem(API_SETTINGS_KEY, JSON.stringify(settings));
  };

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage: setLanguageState,
    apiSettings,
    setApiSettings,
    t: translations[language],
    locale: language === "zh" ? "zh-CN" : "en-US",
  }), [apiSettings, language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

export function getApiSettingsForRequest(settings: ApiSettings): ApiSettings | undefined {
  const normalized = {
    provider: (settings.provider ?? "").trim(),
    apiKey: settings.apiKey.trim(),
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
  };
  return normalized.provider || normalized.apiKey || normalized.baseUrl || normalized.model
    ? normalized
    : undefined;
}
