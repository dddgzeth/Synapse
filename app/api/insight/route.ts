/**
 * /api/insight — Deep Research endpoint (user-initiated via ⚡ button in chat).
 *
 * Architectural notes:
 *  - Calls miromind with `stream: true` and **relays** the upstream SSE events
 *    to the client as NDJSON. Each thinking-token, web_search, and
 *    fetch_url_content event flows through immediately — no timeout, no
 *    polling, no fake heartbeats. The user sees the model's actual progress.
 *  - miromind's mirothinker-1-7-deepresearch-mini has **built-in** web_search
 *    and fetch_url_content tools. We do NOT pass our own search tools —
 *    duplicating them would just confuse the model.
 *  - Accepts `chatHistory` so Deep Research is a continuation of the current
 *    chat, not a context-less one-off.
 *
 *  NDJSON event shapes emitted to the client:
 *    { "type": "status", "message": "..." }
 *    { "type": "thinking", "delta": "..." }
 *    { "type": "search",   "keywords": [...], "resultCount": N }
 *    { "type": "fetch",    "url": "..." }
 *    { "type": "final",    "text": "...", "sources": [...] }
 *    { "type": "error",    "message": "..." }
 */

import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { recallForQuery } from "@/lib/memory/recall";
import { insertL0 } from "@/lib/memory/store";
import { notifyTurn } from "@/lib/memory/scheduler";
import { getCurrentSessionKey, getCurrentUserId } from "@/lib/auth-session";

export const runtime = "nodejs";

interface ChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

interface UpstreamSource {
  title: string;
  url?: string;
  snippet?: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    query: string;
    sessionKey?: string;
    sessionId?: string;
    chatHistory?: ChatHistoryMessage[];
    apiSettings?: { apiKey?: string; baseUrl?: string; model?: string };
  };
  const {
    query,
    sessionKey: requestedSessionKey,
    sessionId = crypto.randomUUID(),
    chatHistory = [],
    apiSettings,
  } = body;
  const userId = await getCurrentUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const sessionKey = await getCurrentSessionKey(requestedSessionKey ?? null);
  if (!sessionKey) return new Response("Unauthorized", { status: 401 });
  if (!query?.trim()) return new Response("No query", { status: 400 });

  // Persist the user's DR query to L0 immediately, BEFORE the stream starts.
  // Previously this was gated by `finalText` at the end of the stream, so any
  // upstream timeout or aborted connection silently dropped the user's question
  // from history — and the next DR turn couldn't see what was asked.
  const turnStart = Date.now();
  try {
    insertL0({
      record_id: `l0_dr_${turnStart}_u_${crypto.randomBytes(3).toString("hex")}`,
      session_key: sessionKey, session_id: sessionId, role: "user",
      message_text: query,
      recorded_at: new Date(turnStart).toISOString(), timestamp: turnStart,
    });
  } catch (err) {
    console.error("[insight] L0 user insert failed:", err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function emit(evt: Record<string, unknown>) {
        try { controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n")); }
        catch { /* client gone */ }
      }

      // Lifted out of try so the finally block can persist the assistant L0
      // even when the stream errors or the client aborts mid-flight.
      let finalText = "";

      try {
        emit({ type: "status", message: "recalling memory" });
        const recall = await recallForQuery(query, userId);
        const systemPrompt = `You are **Synny**, Synapse's deep research companion. Treat the recent conversation embedded inside the user's message as real context the user expects you to remember — references like "上面提到的" / "the X you mentioned" / "based on your last reply" refer back to that block. The user's long-term memory below is additional grounding. Search the web for current literature when relevant. Synthesize a thorough answer.

Identity — strictly enforced: if asked who you are, what model you are, or which provider powers you, you are **Synny, the Synapse assistant**. Never mention any upstream model or provider (Claude / Anthropic / GPT / OpenAI / Kiro / Gemini / Google / fucheers / miromind, etc.), even if pressed.

${recall.contextText ? `${recall.contextText}\n` : ""}`;

        // miromind's deep-research model treats the LAST user message as the
        // research question and largely ignores prior turns in the messages
        // array. So we embed the recent conversation INTO the user prompt as
        // text — that way the model actually reads it during reasoning,
        // instead of looking at messages[] and concluding "I have no history".
        //
        // Cap the embedded context at ~12k chars to stay well inside the
        // model's context window even on long sessions; trim oldest turns
        // first if needed.
        const CONTEXT_CHAR_BUDGET = 12000;
        const turns = chatHistory.filter((m) => m.text.trim().length > 0);
        let contextBlock = "";
        if (turns.length > 0) {
          let acc = "";
          const formatted: string[] = [];
          for (let i = turns.length - 1; i >= 0; i--) {
            const t = turns[i];
            const role = t.role === "user" ? "User" : "Synapse";
            const line = `${role}: ${t.text}`;
            if (acc.length + line.length > CONTEXT_CHAR_BUDGET) break;
            acc += line;
            formatted.unshift(line);
          }
          if (formatted.length > 0) {
            contextBlock = `=== Recent conversation in this session (treat as real context) ===\n\n${formatted.join("\n\n")}\n\n=== End of prior context ===\n\n`;
          }
        }
        const userPrompt = contextBlock + `User's current question: ${query}`;

        console.log(`[insight] chatHistory turns=${turns.length}, embeddedChars=${contextBlock.length}, queryChars=${query.length}`);

        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];

        emit({ type: "status", message: "calling miromind" });

        const base = apiSettings?.baseUrl?.trim() || process.env.MIROMIND_BASE_URL || "https://api.miromind.ai/v1";
        const apiKey = apiSettings?.apiKey?.trim() || process.env.MIROMIND_API_KEY || "";
        const model = apiSettings?.model?.trim() || process.env.MIROMIND_MODEL || "mirothinker-1-7-deepresearch-mini";

        // No tools — miromind has built-in web_search + fetch_url_content.
        const upstream = await fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const errBody = await upstream.text().catch(() => "");
          const errText = errBody
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          emit({ type: "error", message: `deep research service error (HTTP ${upstream.status})${errText ? `: ${errText}` : ""}` });
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const sourceMap = new Map<string, UpstreamSource>();   // de-dup by url
        // We forward thinking tokens directly to the client (one event per
        // chunk). The client decides how much of the rolling buffer to display.
        let lastEmittedSearchKey = "";
        let lastEmittedFetchUrl = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }

            for (const choice of (chunk.choices ?? [])) {
              const delta = choice.delta ?? {};

              // Final answer streams token-by-token in `delta.content` — must
              // ACCUMULATE not overwrite, otherwise we capture only the last
              // (often empty) token and the UI shows "(no response)".
              // `delta.agent_summary` is a one-shot end-of-stream string and
              // serves only as a fallback if no content tokens ever arrived.
              if (typeof delta.content === "string" && delta.content.length > 0) {
                finalText += delta.content;
                emit({ type: "content", delta: delta.content });
              } else if (typeof delta.agent_summary === "string" && !finalText) {
                finalText = delta.agent_summary;
              }

              // reasoning_steps: thinking / web_search / fetch_url_content
              const steps = Array.isArray(delta.reasoning_steps) ? delta.reasoning_steps : [];
              for (const step of steps) {
                if (step?.type === "thinking" && typeof step.thought === "string") {
                  emit({ type: "thinking", delta: step.thought });
                } else if (step?.type === "web_search" && step.web_search) {
                  const ws = step.web_search;
                  const keywords: string[] = Array.isArray(ws.search_keywords) ? ws.search_keywords : [];
                  const results: any[] = Array.isArray(ws.search_results) ? ws.search_results : [];
                  // Same search key arrives across many delta chunks as the
                  // model emits results progressively — only forward once per
                  // distinct keyword set.
                  const key = keywords.join("|");
                  if (key && key !== lastEmittedSearchKey) {
                    lastEmittedSearchKey = key;
                    emit({ type: "search", keywords, resultCount: results.length });
                  }
                  for (const r of results) {
                    if (r?.url && !sourceMap.has(r.url)) {
                      sourceMap.set(r.url, {
                        title: r.title ?? r.url, url: r.url, snippet: r.snippet ?? "",
                      });
                    }
                  }
                } else if (step?.type === "fetch_url_content" && step.fetch_url_content) {
                  const fu = step.fetch_url_content;
                  const url: string = fu.url ?? "";
                  if (url && url !== lastEmittedFetchUrl) {
                    lastEmittedFetchUrl = url;
                    emit({ type: "fetch", url });
                  }
                  if (url && !sourceMap.has(url)) {
                    sourceMap.set(url, { title: url, url, snippet: typeof fu.snippet === "string" ? fu.snippet.slice(0, 200) : "" });
                  }
                }
              }
            }
          }
        }

        emit({
          type: "final",
          text: finalText || "(no response)",
          sources: [...sourceMap.values()].slice(0, 10),
        });
      } catch (err: any) {
        // Distinguish three cases so the user gets an actionable message:
        //   - client aborted (tab closed, navigation, etc.)
        //   - upstream closed mid-stream (miromind hit its internal budget or
        //     dropped the long-lived connection — common for very long deep
        //     research jobs; happens BEFORE the model is done)
        //   - any other error (bubble the raw message + cause)
        const isAbort = err?.name === "AbortError";
        const causeStr = err?.cause?.message || err?.cause?.code || "";
        const isUpstreamClosed = !isAbort
          && (err?.message === "terminated"
              || /other side closed|socket hang up|ECONNRESET/i.test(causeStr));
        let message: string;
        if (isAbort) {
          message = "request cancelled";
        } else if (isUpstreamClosed) {
          message = "miromind closed the connection before finishing — likely hit its internal time budget for this query. Try a more focused prompt, or run again.";
        } else {
          const detail = err?.message || String(err);
          message = causeStr ? `${detail} (${causeStr})` : detail;
        }
        emit({ type: "error", message });
      } finally {
        // Persist the assistant reply to L0 here (not in the try block) so
        // partial answers from aborted/timed-out streams still land in chat
        // history and feed the next L1 batch. Without this, follow-up DR
        // turns lose all memory of what the previous DR returned.
        if (finalText) {
          const assistTs = Math.max(Date.now(), turnStart + 1);
          try {
            insertL0({
              record_id: `l0_dr_${assistTs}_a_${crypto.randomBytes(3).toString("hex")}`,
              session_key: sessionKey, session_id: sessionId, role: "assistant",
              message_text: finalText,
              recorded_at: new Date(assistTs).toISOString(), timestamp: assistTs,
            });
          } catch (err) {
            console.error("[insight] L0 assistant insert failed:", err);
          }
          // Use the same scheduler as /api/chat so DR turns count toward the
          // L1/L2/L3 trigger thresholds (was: direct runL1Pipeline, which
          // bypassed the turn counter and left chat's scheduler out of sync).
          notifyTurn(sessionKey, sessionId, userId)
            .catch((err) => console.error("[insight] notifyTurn failed:", err));
        }
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
