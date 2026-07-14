/**
 * /api/page-render — Lazy HTML page generator.
 *
 * Triggered when the user clicks the "Page" toggle on an assistant bubble in
 * the chat. Takes the assistant's existing answer (plus the user's question)
 * and produces a self-contained HTML fragment to render as a Page view.
 *
 * This used to live in the main /api/chat system prompt, which forced every
 * single reply to also produce an HTML artifact and ~doubled token cost even
 * when the user never opened Page view. Splitting it out means Page is opt-in
 * and only pays its cost on demand.
 *
 * Response: JSON { html: string }. Non-streaming — the result is rendered all
 * at once by an iframe so progressive streaming wouldn't change the UX.
 */

import { NextRequest } from "next/server";
import { createLLMProviderFromOverride } from "@/lib/llm/provider";
import { generateText } from "ai";
import { getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `你是一个把 Markdown/纯文本回答转换成 HTML 页面的渲染器。
输入是一个已经完成的回答（assistantText），可选地附带用户的原始问题（userQuery）。
输出一个**自包含的 HTML fragment**，让这个回答以更直观的方式呈现。

严格要求：
- 只输出 HTML fragment 本身。不要 Markdown 代码围栏，不要解释，不要前后多余文字。
- 不要 <!DOCTYPE html>/<html>/<head>/<body>；能用 <section> 包住就不要生成整页文档。
- 自包含：只用 inline style、inline svg、必要时少量 inline script。绝不引用远程 JS/CSS/图片。
- 不要重复堆砌原文 — 用结构化排版、卡片、表格、列表、SVG 图示等让信息密度更高、视觉更清晰。
- 适合的呈现方式举例：
  * 流程/步骤 → 编号步骤卡或 SVG 流程图
  * 对比/评估 → 表格或并列卡片
  * 分层架构 → 嵌套 box 或 SVG 分层图
  * 列表式知识 → 高密度卡片网格
  * 报告式总结 → 章节 + 高亮要点 + 配色
- 排版准则：宽度撑满父容器；用现代字号/间距（14px 起、line-height 1.6+）；浅色背景、深色文字、克制配色。
- 如果原回答很短或是闲聊，也要尽量做一个简单的卡片排版，不要返回空 fragment。`;

interface ApiSettingsOverride {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface Body {
  assistantText: string;
  userQuery?: string;
  apiSettings?: ApiSettingsOverride;
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json()) as Body;
  const assistantText = (body.assistantText ?? "").trim();
  if (!assistantText) return new Response("Empty assistantText", { status: 400 });

  const provider = createLLMProviderFromOverride(body.apiSettings);

  const userMsg = body.userQuery?.trim()
    ? `用户问题：\n${body.userQuery.trim()}\n\n已完成的回答：\n${assistantText}`
    : `已完成的回答：\n${assistantText}`;

  try {
    // No maxOutputTokens — let the model run to completion. Any cap risks
    // chopping the HTML mid-SVG/script and the iframe then renders the
    // unclosed bytes as visible code.
    const gen = await generateText({
      model: provider.createModel(),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
    const html = stripFences(gen.text);
    return Response.json({ html });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** LLMs sometimes wrap HTML in ```html ... ``` even when told not to. Strip it. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html|svg)?\s*\n([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}
