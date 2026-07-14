#!/usr/bin/env python3
"""
Synapse passive-capture Stop hook — works for BOTH Claude Code and Codex.

Reads the Stop-event JSON from stdin (both CLIs provide session_id,
transcript_path, cwd; Codex adds last_assistant_message), extracts the last
user↔assistant exchange from the transcript (text only — tool dumps are
skipped), and POSTs it to the Synapse MCP endpoint (log_conversation).

Env switches (the "three switches" from docs/mcp-server-plan-0711.md):
  SYNAPSE_TOKEN       required — personal access token (syn_…)
  SYNAPSE_MCP_URL     default https://synapse.cjlin.com/api/mcp
  SYNAPSE_SYNC        "off" → do nothing (master switch)
  SYNAPSE_SYNC_DIRS   colon-separated dir prefixes; if set, only sync when
                      cwd starts with one of them (project whitelist)
  SYNAPSE_MIN_CHARS   skip exchanges shorter than this total (default 40)

Never blocks the CLI: all failures are silent, always exits 0 with "{}" on
stdout (Codex requires JSON stdout for Stop hooks; Claude Code accepts it).
"""
import json
import os
import sys
import urllib.request


def out_and_exit():
    print("{}")
    sys.exit(0)


def extract_text(content) -> str:
    """Pull visible text out of a message content field (str or block list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") in ("text", "input_text", "output_text") and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return ""


def walk_messages(obj, found):
    """Recursively find {role, content} message objects in a transcript line."""
    if isinstance(obj, dict):
        role = obj.get("role")
        if role in ("user", "assistant") and "content" in obj:
            text = extract_text(obj["content"]).strip()
            if text:
                found.append((role, text))
        for v in obj.values():
            walk_messages(v, found)
    elif isinstance(obj, list):
        for v in obj:
            walk_messages(v, found)


def last_exchange(transcript_path: str):
    """Last user text + the assistant text that followed it."""
    msgs = []
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    found = []
                    walk_messages(json.loads(line), found)
                    msgs.extend(found)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return None, None
    last_user_idx = None
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i][0] == "user":
            last_user_idx = i
            break
    if last_user_idx is None:
        return None, None
    user_text = msgs[last_user_idx][1]
    assistant_text = "\n\n".join(t for r, t in msgs[last_user_idx + 1:] if r == "assistant")
    return user_text, assistant_text


def main():
    if os.environ.get("SYNAPSE_SYNC", "").lower() == "off":
        out_and_exit()
    token = os.environ.get("SYNAPSE_TOKEN", "")
    if not token:
        out_and_exit()

    try:
        payload = json.load(sys.stdin)
    except Exception:
        out_and_exit()

    cwd = payload.get("cwd") or ""
    whitelist = [d for d in os.environ.get("SYNAPSE_SYNC_DIRS", "").split(":") if d]
    if whitelist and not any(cwd.startswith(os.path.expanduser(d)) for d in whitelist):
        out_and_exit()

    transcript = payload.get("transcript_path") or ""
    user_text, assistant_text = last_exchange(transcript)
    # Codex hands us the final assistant message directly — prefer it.
    if payload.get("last_assistant_message"):
        assistant_text = payload["last_assistant_message"]
    if not user_text and not assistant_text:
        out_and_exit()

    min_chars = int(os.environ.get("SYNAPSE_MIN_CHARS", "40"))
    if len((user_text or "") + (assistant_text or "")) < min_chars:
        out_and_exit()

    # Source: explicit env wins (the AI tool that installs the hook knows what
    # it is), else guess from the transcript path, else "cli".
    source = (
        os.environ.get("SYNAPSE_SOURCE", "").strip()
        or ("claude-code" if "/.claude/" in transcript
            else "codex" if "/.codex/" in transcript
            else "cli")
    )
    project = os.path.basename(cwd.rstrip("/")) if cwd else ""
    session_id = payload.get("session_id") or ""
    messages = []
    if user_text:
        messages.append({"role": "user", "content": user_text[:50000]})
    if assistant_text:
        messages.append({"role": "assistant", "content": assistant_text[:50000]})

    args = {"messages": messages, "source": source}
    if project:
        args["project"] = project
    if session_id:
        args["session_id"] = session_id
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "log_conversation", "arguments": args},
    }).encode()
    url = os.environ.get("SYNAPSE_MCP_URL", "https://synapse.cjlin.com/api/mcp")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    })
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass  # never break the CLI over a sync failure
    out_and_exit()


if __name__ == "__main__":
    main()
