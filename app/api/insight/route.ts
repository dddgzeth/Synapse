/**
 * /api/insight — Deep Research endpoint (user-initiated via ⚡ button).
 *
 * Uses miromind's mirothinker-1-7-deepresearch-mini with manual tool-calling loop
 * (the ai SDK's OpenAI provider can't parse miromind's non-standard streaming format).
 *
 * Tools: search_semantic_scholar + search_arxiv.
 * Results are written to L0 for future memory extraction.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { searchSemanticScholar, searchArxiv } from "@/lib/search/external";
import { recallForQuery } from "@/lib/memory/recall";
import { insertL0 } from "@/lib/memory/store";
import { runL1Pipeline } from "@/lib/memory/l1-pipeline";
import { getCurrentSessionKey } from "@/lib/auth-session";

export const runtime = "nodejs";
export const maxDuration = 180;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_semantic_scholar",
      description: "Search Semantic Scholar for academic papers (covers Wiley/RSC/ACS/Nature). Use for peer-reviewed literature.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Number of results (default 5)", default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_arxiv",
      description: "Search arXiv for preprints. Use for cutting-edge or unpublished work.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Number of results (default 5)", default: 5 },
        },
        required: ["query"],
      },
    },
  },
];

async function callMiromind(
  messages: any[],
  tools: typeof TOOLS | undefined,
  signal: AbortSignal,
  apiSettings?: { apiKey?: string; baseUrl?: string; model?: string },
): Promise<any> {
  const base = apiSettings?.baseUrl?.trim() || process.env.MIROMIND_BASE_URL || "https://api.miromind.ai/v1";
  const apiKey = apiSettings?.apiKey?.trim() || process.env.MIROMIND_API_KEY || "";
  const model = apiSettings?.model?.trim() || process.env.MIROMIND_MODEL || "mirothinker-1-7-deepresearch-mini";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      stream: false,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`miromind ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    query: string;
    sessionKey?: string;
    sessionId?: string;
    apiSettings?: { apiKey?: string; baseUrl?: string; model?: string };
  };
  const { query, sessionKey: requestedSessionKey = "deep_research", sessionId = crypto.randomUUID(), apiSettings } = body;
  const sessionKey = await getCurrentSessionKey(requestedSessionKey);
  if (!sessionKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!query?.trim()) {
    return NextResponse.json({ error: "No query" }, { status: 400 });
  }

  const recall = recallForQuery(query);
  const searchResultsLog: Array<{ title: string; abstract: string; source: string }> = [];

  const systemPrompt = `你是 Synapse 的深度研究助手。基于用户的研究背景和外部文献，提供深度研究分析。

${recall.contextText ? `用户研究背景：\n${recall.contextText}\n\n` : ""}调用 search_semantic_scholar 和 search_arxiv 检索相关文献，然后综合私有记忆和外部文献给出全面分析。`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 240_000);

  try {
    let finalText = "";
    for (let step = 0; step < 5; step++) {
      const response = await callMiromind(messages, TOOLS, controller.signal, apiSettings);
      const choice = response.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error(`miromind returned no message: ${JSON.stringify(response).slice(0, 200)}`);

      const toolCalls = msg.tool_calls ?? [];
      const content = msg.content ?? msg.agent_summary ?? "";

      messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        finalText = content;
        break;
      }

      // Execute tool calls
      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let args: any = {};
        try {
          args = typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments ?? {});
        } catch { args = {}; }

        let result: any = { error: "unknown tool" };
        try {
          if (fnName === "search_semantic_scholar") {
            const r = await searchSemanticScholar(args.query ?? "", args.limit ?? 5);
            searchResultsLog.push(...r.map((x) => ({ title: x.title, abstract: x.abstract, source: x.source })));
            result = r;
          } else if (fnName === "search_arxiv") {
            const r = await searchArxiv(args.query ?? "", args.limit ?? 5);
            searchResultsLog.push(...r.map((x) => ({ title: x.title, abstract: x.abstract, source: x.source })));
            result = r;
          }
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: fnName,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
    }

    clearTimeout(timeoutId);

    // Write to L0 for future memory extraction
    if (finalText) {
      const now = Date.now();
      insertL0({
        record_id: `l0_dr_${now}_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey, session_id: sessionId, role: "user",
        message_text: `[Deep Research 查询: ${query}]`,
        recorded_at: new Date(now).toISOString(), timestamp: now,
      });

      const sourceSummary = searchResultsLog.length > 0
        ? `\n\n[外部文献]\n\n${searchResultsLog.slice(0, 8).map((r) => `[${r.source}] ${r.title}\n${(r.abstract ?? "").slice(0, 300)}`).join("\n\n---\n\n")}`
        : "";

      insertL0({
        record_id: `l0_dr_${now + 1}_${crypto.randomBytes(3).toString("hex")}`,
        session_key: sessionKey, session_id: sessionId, role: "assistant",
        message_text: `${finalText.slice(0, 4000)}${sourceSummary}`,
        recorded_at: new Date(now + 1).toISOString(), timestamp: now + 1,
      });
      runL1Pipeline(sessionKey, sessionId).catch(console.error);
    }

    return NextResponse.json({
      result: finalText || "(no response)",
      sources: searchResultsLog.slice(0, 10),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
