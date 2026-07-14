# Synapse — Your Second Memory

> An AI research assistant with long-term memory that follows you across every AI tool you use — the web chat, Claude Code, Codex, Cursor, anywhere. Every conversation accumulates into a traceable research profile.

Chat with Synapse like you'd chat with any assistant — attach local folders, ask questions, get answers. In the background Synapse distils your conversations into structured memories (L0→L1→L2→L3). Connect Claude Code, Codex, Cursor, or any MCP client with one pasted instruction, and their conversations sync back automatically too — one memory, not one memory per tool. Occasionally, in the middle of a perfectly ordinary reply, it quietly surfaces: *"Synapse noticed — across 10 research threads over 9 days, the same unresolved question keeps converging…"* — not triggered by a button, but by the weight of accumulated evidence.

**[中文文档 → README.zh.md](README.zh.md)**

---

## Demo

[![Demo Video](public/demo/demo-en-thumb.jpg)](https://synapse.cjlin.com/demo-en)

▶ **[Watch the 96-second demo](https://synapse.cjlin.com/demo-en)** · [中文配音版](https://synapse.cjlin.com/demo-zh)

---

## Screenshots

### Home — clean slate, ready to connect your folders

![Home screen](public/screenshots/home.jpg)

### Chat — memory-grounded replies from the first message

Synapse searches your accumulated memories before every reply. The search is shown inline so you know exactly what context was used.

![Chat with memory search](public/screenshots/chat-thinking.jpg)

![Chat response](public/screenshots/chat-response.jpg)

### Deep Research — web + literature search, on demand

Click ⚡ **Deep Research** to send your question to an agentic research model that searches Semantic Scholar, arXiv, and the web — then synthesises findings against your existing memory.

![Deep Research in progress](public/screenshots/deep-research-progress.jpg)

![Deep Research — 15 parallel searches running](public/screenshots/deep-research-steps.jpg)

![Deep Research — structured report output](public/screenshots/deep-research-result.jpg)

### Aha — the passive discovery moment

After enough conversations accumulate, Synapse detects cross-source patterns in the background. The next time you ask something related, a **"Synapse Noticed"** card appears inline — with a full draggable evidence graph tracing every insight back to its original source.

![Aha moment with evidence graph](public/screenshots/aha-evidence.jpg)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env.local   # fill in the values below

# 3. Start dev server
npm run dev      # http://localhost:3000
```

### Environment Variables (`.env.local`)

The app runs on the fucheers vars alone — openai / anthropic are opt-in only, never required.

```
# ── Chat/pipeline LLM backend ────────────────────────────
LLM_PROVIDER=fucheers        # fucheers | openai | anthropic

# fucheers (default, required for the app to run)
ANTHROPIC_BASE_URL=https://your-claude-proxy/
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6

# openai (optional — only used when LLM_PROVIDER=openai or chosen in the UI)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# anthropic direct (optional — dedicated vars so they don't clash with the
# fucheers-repurposed ANTHROPIC_* above)
ANTHROPIC_DIRECT_API_KEY=
ANTHROPIC_DIRECT_MODEL=claude-sonnet-4-6
ANTHROPIC_DIRECT_BASE_URL=

# Deep Research (user-initiated)
MIROMIND_BASE_URL=https://api.miromind.ai/v1
MIROMIND_API_KEY=sk-xxx
MIROMIND_MODEL=mirothinker-1-7-deepresearch-mini

# SQLite data directory (default: ./data)
TDAI_DATA_DIR=/path/to/your/synapse-data
```

---

## Architecture

```
┌─────────────────── Browser (Client) ────────────────────┐
│                                                          │
│  Sidebar           ChatPanel             AhaModal        │
│  • Connected Tools • useChat hook        • Evidence graph│
│  • Insight history • Tool-call loop      • xyflow nodes  │
│  • Memories/scenes • File attachments    • Draggable     │
│                                                          │
│  IndexedDB:                                              │
│  • synapse_folders  (FileSystemDirectoryHandle cache)    │
│  • synapse_pdf_cache (PDF parse results)                 │
│                                                          │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP (Next.js Route Handlers)
┌──────────────────────────▼───────────────────────────────┐
│                      Server (Node)                        │
│                                                           │
│  /api/chat           ── main chat + Aha judge + L0 write  │
│  /api/pipeline/flush ── force-flush L1 on user return     │
│  /api/aha/*          ── history / detail / evidence       │
│  /api/memories       ── sidebar data (L0/L1/L2/L3)        │
│  /api/scene/[name]   ── scene block detail                │
│  /api/insight        ── Deep Research                     │
│  /api/[transport]    ── MCP server (6 tools, PAT auth)    │
│  /api/tools/*        ── Connected Tools + archive view     │
│  /api/tokens         ── mint/revoke MCP access tokens     │
│  /api/hook           ── serves the auto-capture script     │
│                                                           │
│  scheduler.notifyTurn  ─→  l1-pipeline                    │
│        ↓ (≥5 turns or flush)       ↓ (≥3 new memories)   │
│        counter + mutex          l2-l3-pipeline + aha detect│
│                                                           │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  Local Storage                                            │
│  • SQLite (memory.db)  ── L0 turns / L1 records / state  │
│  • scene_blocks/*.md   ── L2 scene blocks                 │
│  • persona.md          ── L3 researcher profile           │
│  • backup/             ── automatic version snapshots     │
│                                                           │
│  External APIs (on demand)                                │
│  • Claude-compatible proxy ── main chat + all extraction  │
│  • miromind            ── Deep Research                   │
│  • Semantic Scholar / arXiv ── Aha external literature    │
└────────────────────────────────────────────────────────────┘
```

External AI tools (Claude Code, Codex, Cursor, any MCP client) don't go through the browser at all — they hit `/api/[transport]` directly over MCP, and a Stop hook (`scripts/hooks/synapse_sync.py`, downloaded from `/api/hook`) posts the last finished turn to `log_conversation` once per turn. See [Connect Any AI Tool](#connect-any-ai-tool-mcp--auto-capture) below for the full flow.

---

## Memory System: L0 → L1 → L2 → L3

Adapted from [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory). Two changes from upstream: L1 types replaced with research types; `ontology_label` added to metadata.

| Layer | What it is | Storage | Written by | Read by |
|---|---|---|---|---|
| **L0** | Raw conversation turns (every user / assistant message) | SQLite `l0_conversations` + FTS5 trigram | `/api/chat` onFinish | recall, Aha evidence |
| **L1** | Atomic research memories (claim / method / observation / dataset / experiment / finding / question / goal) | SQLite `l1_records` + FTS5 trigram | `l1-pipeline` (every 5 turns or flush) | sidebar, recall, Aha detection |
| **L2** | Topic scene blocks (L1 memories aggregated by research theme) | `scene_blocks/*.md` | `l2-l3-pipeline` (every 3 new L1 memories) | sidebar, evidence graph |
| **L3** | Stable researcher profile | `persona.md` | `persona-generator` (on significant scene change) | main chat system prompt |

### Trigger: pure turn count + mutex, no timers

```
Every /api/chat onFinish:
  scheduler.notifyTurn(sessionKey)
    turnCount++
    if turnCount >= 5:
       runL1Pipeline()  ← guarded by l1Running mutex
       if newMemoriesSinceLastL2 >= 3:
         runL2L3Pipeline()  ← guarded by l2Running mutex
         runAhaDetection()
       turnCount = 0
```

No "idle for N minutes" timers. When the user returns to chat, `synapse-app.tsx` automatically POSTs `/api/pipeline/flush` once to drain any leftover turns.

---

## Memory Recall: Grounding Every Reply

Before every chat turn, Synapse retrieves relevant memory and decides how to use it. This is separate from the background Aha detection — recall runs on **every** turn and grounds the reply. Three layers:

**1. Recall (`lib/memory/recall.ts`)** — for each user message:
- **L3 persona** (`persona.md`): always injected, no matching required — it is the always-on "who you are" profile.
- **L1 memories**: FTS-searched, top 8 most relevant to the current message (user-global, across all sessions).
- Both are handed to the relationship analyzer.

**2. Relationship analysis (`lib/memory/insights/context-analyzer.ts`)** — one lightweight LLM call tags each recalled memory:
- `connection` 🔗 — an informative link (an earlier decision on the same project, a prior discussion of the same concept).
- `contradiction` ⚠️ — a real conflict (you changed your mind, took the opposite approach).
- everything else is dropped — the prompt enforces "when in doubt, skip"; an empty result is valid and common.

**3. Injection** — `formatRecallContext` assembles `<researcher-profile>` + `<relevant-research-memories>` + `<noteworthy-links>`, and `/api/chat` splices it into the system prompt. The `<noteworthy-links>` block explicitly instructs the main LLM to — *after answering the primary question* — lightly surface 1–2 connections or contradictions in natural language ("by the way, this connects to your earlier X" / "last time you leaned toward A — is B a change of mind?"), or ignore them entirely if none fit.

This is the immediate "I remember you mentioned…" layer, distinct from Aha: recall grounds each reply in the moment; Aha runs in the background and surfaces cross-scene patterns as cards.

---

## Aha: Passive Research Observations

Not "button → generate". The background scanner finds L1 memories where the same idea appears across ≥3 sources over ≥3 days, synthesises a three-part observation (observation / hypothesis / reframe), and waits. When the user next sends a semantically related message, it appears inline — and a ✨ "New Insight" badge appears in the sidebar.

**Full chain:**

1. `runAhaDetection` (runs after L1 completes) — scans L1 for cross-source memories ≥3 + span ≥3 days → writes `aha_pending` + `aha_last` + `aha_history`
2. Next user message → `shouldFireAhaLLM` (LLM judge) decides relevance → YES injects inline
3. Sidebar polls `/api/aha/last` for unseen → shows ✨ "New Insight" pulsing badge
4. Click badge → `AhaModal` overlay + `EvidenceGraph` draggable canvas
5. Sidebar "✨ Insight History" section lists all past Ahas permanently

**External literature supplement**: when synthesising Aha, the pattern is distilled into English keywords and sent to Semantic Scholar + arXiv for supporting papers — attached as `externalSources`. Failure does not block the Aha itself.

---

## Connect Any AI Tool: MCP + Auto-Capture

Synapse isn't only the web chat — it's a memory hub any MCP-capable AI tool can read from and write into. Claude Code, Codex, Cursor, or any other MCP client can be connected with **one pasted instruction**, no manual config editing.

**Setup (from the account menu → Connect AI tools):**

1. Generate a personal access token in the UI.
2. Pick your tool; Synapse builds an install instruction tailored to that client's actual MCP config format and hook schema (Claude Code's `~/.claude/settings.json` Stop hook is not shaped like Codex's `[[hooks.Stop.hooks]]` TOML block — the adapter (`lib/mcp-adapters.ts`) knows the difference and never guesses).
3. Paste the instruction into the tool's chat. It registers the MCP server and downloads a Stop-hook script (`scripts/hooks/synapse_sync.py`, served publicly at `/api/hook`) that fires once per turn.

![Connect your AI tools modal](public/screenshots/mcp-connect-modal.jpg)

**What happens after that:**

The pasted instruction plays out as an ordinary conversation in the tool itself — it registers the MCP server, installs the hook, and confirms:

![Claude Code auto-configuring after the instruction is pasted](public/screenshots/mcp-auto-capture.jpg)

- Every finished turn in that tool gets synced to Synapse automatically — no "remember this" prompt required. The hook only ever sends the last user↔assistant exchange (never the whole session transcript), and it's a plain HTTP call from a local script — it never touches the AI tool's own model context or token usage.
- Synced conversations live under their own session namespace (`chat_<user>_ext_<source>_<project>`) and show up in the sidebar's **Connected Tools** tree, grouped by tool → project → session — kept separate from your web chat history.
- Clicking into one opens a **read-only archive** view (`/tools/[source]/[project]`) showing the full conversation exactly as it happened in that tool.
- The MCP server also exposes tools the connected AI can call directly: `get_context`, `search_memory`, `search_conversations`, `remember`, `log_conversation`, `get_insights` — so Claude Code can, say, pull your research context into a coding session, or you can tell it "remember this" and have it land in the same memory the web chat reads from.

![Connected Tools sidebar + read-only archive of a synced conversation](public/screenshots/mcp-connected-archive.jpg)

**Search** is hybrid: local `bge-m3` embeddings (via `node-llama-cpp`, no external embedding API) combined with FTS5 through Reciprocal Rank Fusion, so exact keyword hits and paraphrased semantic matches both surface — and an exact phrase match is boosted to outrank a merely-similar neighbour.

---

## File Sync: Metadata-only + LLM-initiated reads

**Key constraint**: syncing a folder does **not** automatically push file contents into the database.

```
Connect folder → browser File System Access API → IndexedDB handle cache
Scan tree → collect metadata (path / size / extension) → push to synced-files-bus
Chat request body carries only metadata (≤5 KB)

If the LLM decides it needs a file, it calls read_synced_file(path)
→ server pauses stream → browser FileSystemFileHandle reads file → two-leg HTTP back
→ LLM stream resumes with file content as tool result
```

Only when the user has actually had the LLM read a file and discussed it does the conversation land in L0. The file itself never enters L0.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 14 (App Router) | RSC + Route Handlers |
| Main LLM | Provider-abstracted (`lib/llm/provider.ts`) | fucheers by default (`claude-sonnet-4-6`), openai/anthropic opt-in only — app runs on fucheers alone |
| Cross-tool sync | Model Context Protocol (`@modelcontextprotocol/sdk`) | Per-client connect adapters + Stop-hook auto-capture, see [Connect Any AI Tool](#connect-any-ai-tool-mcp--auto-capture) |
| Deep Research LLM | `mirothinker-1-7-deepresearch-mini` | User-initiated only |
| AI SDK | Vercel `ai` v6 + `@ai-sdk/openai`/`@ai-sdk/anthropic` v3 | `useChat` + `DefaultChatTransport` |
| Database + search | `better-sqlite3` + FTS5 trigram + `sqlite-vec` | Hybrid search: local `bge-m3` embeddings (`node-llama-cpp`) fused with FTS5 via RRF |
| Graph viz | `@xyflow/react` v12 | Aha evidence graph |
| PDF parsing | `pdfjs-dist` v5 | Browser-side, lazy loaded |
| External search | Semantic Scholar API + arXiv API | Direct fetch, no SDK |
