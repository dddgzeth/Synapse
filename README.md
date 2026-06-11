# Synapse — Your Second Memory

> An AI research assistant with long-term memory. Runs locally, stores locally. Every conversation accumulates into a traceable research profile.

Chat with Synapse like you'd chat with any assistant — attach local folders, ask questions, get answers. In the background Synapse distils your conversations into structured memories (L0→L1→L2→L3). Occasionally, in the middle of a perfectly ordinary reply, it quietly surfaces: *"Synapse noticed — across 10 research threads over 9 days, the same unresolved question keeps converging…"* — not triggered by a button, but by the weight of accumulated evidence.

**[中文文档 → README.zh.md](README.zh.md)**

---

## Demo

[![Demo Video](https://img.youtube.com/vi/3FjaOnHsJBY/maxresdefault.jpg)](https://www.youtube.com/watch?v=3FjaOnHsJBY)

▶ **[Watch the 72-second demo on YouTube](https://www.youtube.com/watch?v=3FjaOnHsJBY)**

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

```
# Main chat + all L1/L2/L3 extraction + Aha synthesis
ANTHROPIC_BASE_URL=https://your-claude-proxy/
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6

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
│  • Local folders   • useChat hook        • Evidence graph│
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
| Main LLM | `claude-sonnet-4-6` via OpenAI-compatible proxy | Streaming + tool_call bug worked around with manual loop in `lib/memory/chat-loop.ts` |
| Deep Research LLM | `mirothinker-1-7-deepresearch-mini` | User-initiated only |
| AI SDK | Vercel `ai` v6 + `@ai-sdk/openai` v3 | `useChat` + `DefaultChatTransport` |
| Database | `better-sqlite3` + FTS5 trigram | Supports Chinese full-text search |
| Graph viz | `@xyflow/react` v12 | Aha evidence graph |
| PDF parsing | `pdfjs-dist` v5 | Browser-side, lazy loaded |
| External search | Semantic Scholar API + arXiv API | Direct fetch, no SDK |
