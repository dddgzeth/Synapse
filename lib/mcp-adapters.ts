/**
 * Per-client connect adapters for the "Connect your AI tools" flow.
 *
 * Synapse is a cross-tool memory hub. Every client (Claude Code / Codex /
 * Cursor / other MCP clients) has a DIFFERENT MCP config format and a DIFFERENT
 * (or absent) lifecycle-hook schema. We must NOT hardcode one tool's format for
 * another, and we must NOT claim auto-capture works until it's verified.
 *
 * Everything is parameterised (mcpUrl, token, scriptPath, pythonPath). Each
 * adapter carries: MCP config, hook download, hook registration (or null when
 * the client can't do it / we can't be sure), unified verification steps, and a
 * fallback for when auto-capture isn't available.
 */

export type AdapterId = "claude-code" | "codex" | "cursor" | "generic";
export type AutoCaptureSupport = "yes" | "uncertain" | "no";

export interface AdapterVars {
  mcpUrl: string;      // e.g. https://synapse.cjlin.com/api/mcp
  hookUrl: string;     // e.g. https://synapse.cjlin.com/api/hook
  token: string;       // syn_...
  scriptPath: string;  // where the hook script lives, e.g. ~/.synapse/synapse_sync.py
  pythonPath: string;  // python interpreter, e.g. python3
}

export interface ConnectAdapter {
  id: AdapterId;
  label: string;
  /** MCP server registration for this client. */
  mcpConfig: { where: string; snippet: string };
  /** One-liner that downloads the auto-capture hook script. */
  hookDownload: string;
  /** Hook registration snippet, or null when unsupported / unverifiable. */
  hookConfig: { where: string; snippet: string; note?: string } | null;
  supportsAutoCapture: AutoCaptureSupport;
  /** Fallback when auto-capture can't be enabled. */
  fallback: string;
}

const DEFAULTS = {
  scriptPath: "~/.synapse/synapse_sync.py",
  pythonPath: "python3",
};

/** The inline-env command string the hook must be launched with. */
function hookCommand(v: AdapterVars, source: string): string {
  return `SYNAPSE_TOKEN=${v.token} SYNAPSE_MCP_URL=${v.mcpUrl} SYNAPSE_SOURCE=${source} ${v.pythonPath} ${v.scriptPath}`;
}

function download(v: AdapterVars): string {
  return `mkdir -p ~/.synapse && curl -fsSL ${v.hookUrl} -o ${v.scriptPath}`;
}

const MANUAL_FALLBACK =
  "Auto-capture off: call the MCP tools `remember` or `log_conversation` whenever an important preference, decision, or conclusion comes up. Nothing is lost — it just isn't automatic.";

// ── Adapters ─────────────────────────────────────────────────────────

function claudeCode(v: AdapterVars): ConnectAdapter {
  return {
    id: "claude-code",
    label: "Claude Code",
    mcpConfig: {
      where: "terminal",
      snippet: `claude mcp add synapse --transport http ${v.mcpUrl} --header "Authorization: Bearer ${v.token}"`,
    },
    hookDownload: download(v),
    hookConfig: {
      where: "~/.claude/settings.json",
      snippet: `{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "${hookCommand(v, "claude-code")}", "timeout": 30 } ] }
    ]
  }
}`,
      note: "This is Claude Code's documented Stop-hook shape. If your installed version's schema differs, have Claude Code read its own hooks docs / existing settings.json and adjust — do not force an uncertain config.",
    },
    supportsAutoCapture: "yes",
    fallback: MANUAL_FALLBACK,
  };
}

function codex(v: AdapterVars): ConnectAdapter {
  return {
    id: "codex",
    label: "Codex",
    mcpConfig: {
      where: "~/.codex/config.toml",
      snippet: `[mcp_servers.synapse]
url = "${v.mcpUrl}"
http_headers = { "Authorization" = "Bearer ${v.token}" }`,
    },
    hookDownload: download(v),
    hookConfig: {
      where: "~/.codex/config.toml",
      // OFFICIAL Codex hooks schema: the handler is NESTED under
      // [[hooks.Stop.hooks]] with type/command/timeout/statusMessage. Env vars
      // are inlined into the command string. Do NOT use `[[hooks.Stop]] command=`
      // and do NOT use args/env — those are MCP-server fields, not hook fields.
      snippet: `[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "${hookCommand(v, "codex")}"
timeout = 10
statusMessage = "Syncing conversation to Synapse"`,
      note: "Codex hook handlers nest under [[hooks.Stop.hooks]]. After saving, restart Codex and approve the hook in its /hooks (trust/review) UI. Do NOT add args = [...] or env = { ... }.",
    },
    supportsAutoCapture: "yes",
    fallback: MANUAL_FALLBACK,
  };
}

function cursor(v: AdapterVars): ConnectAdapter {
  return {
    id: "cursor",
    label: "Cursor",
    mcpConfig: {
      where: "~/.cursor/mcp.json",
      snippet: `{
  "mcpServers": {
    "synapse": {
      "url": "${v.mcpUrl}",
      "headers": { "Authorization": "Bearer ${v.token}" }
    }
  }
}`,
    },
    hookDownload: download(v),
    // Cursor has no reliable end-of-turn/lifecycle hook to run an external
    // command — do NOT claim auto-capture.
    hookConfig: null,
    supportsAutoCapture: "no",
    fallback:
      "Cursor has no reliable stop/lifecycle hook, so auto-capture can't be enabled here. Use the MCP tools `remember` / `log_conversation` on demand, or run the hook script from an external watcher/extension.",
  };
}

function generic(v: AdapterVars): ConnectAdapter {
  return {
    id: "generic",
    label: "Other MCP client",
    mcpConfig: {
      where: "your client's MCP config",
      snippet: `Streamable HTTP MCP server:
  URL:    ${v.mcpUrl}
  Header: Authorization: Bearer ${v.token}`,
    },
    hookDownload: download(v),
    // We can't know an unknown client's hook schema — provide the script +
    // requirements, let the client wire it up if it can.
    hookConfig: {
      where: "your client's end-of-turn / stop / lifecycle hook",
      snippet: `# Run this command at the end of every turn:
${hookCommand(v, "your-tool-name")}`,
      note:
        "Auto-capture requires your client to support an end-of-turn / stop / lifecycle hook that runs an external command AND passes the turn's transcript / session metadata to it on stdin. Set SYNAPSE_SOURCE to your tool's name. If your client has no such hook, auto-capture isn't possible — use the fallback.",
    },
    supportsAutoCapture: "uncertain",
    fallback: MANUAL_FALLBACK,
  };
}

export function buildAdapter(id: AdapterId, vars: Partial<AdapterVars> & Pick<AdapterVars, "mcpUrl" | "hookUrl" | "token">): ConnectAdapter {
  const v: AdapterVars = { ...DEFAULTS, ...vars };
  switch (id) {
    case "claude-code": return claudeCode(v);
    case "codex": return codex(v);
    case "cursor": return cursor(v);
    default: return generic(v);
  }
}

export const ADAPTER_IDS: AdapterId[] = ["claude-code", "codex", "cursor", "generic"];

/** Unified verification steps every adapter shares. */
export function verificationSteps(a: ConnectAdapter): string[] {
  const steps = [
    "Confirm the Synapse tools appear in your client (MCP tools/list returns get_context, remember, search_memory, …).",
  ];
  if (a.hookConfig && a.supportsAutoCapture !== "no") {
    steps.push(
      "Download the hook script (command above).",
      "Register the Stop / end-of-turn hook (config above).",
      "Restart the client.",
      "Approve / trust the hook when prompted (e.g. Codex /hooks review).",
      "Send a message containing a unique test word.",
      "Wait for the AI to finish replying.",
      `Search that word in Synapse — only if a matching "${a.id}" session appears is auto-capture actually working.`,
    );
  } else {
    steps.push(
      "Auto-capture is NOT available for this client — do not expect conversations to sync on their own.",
      "Verify recall instead: ask the client something about your past work; it should call get_context / search_memory and answer from your Synapse memory.",
    );
  }
  return steps;
}

/** Build one paste-into-your-AI instruction, accurate for the chosen client. */
export function buildInstruction(a: ConnectAdapter, zh: boolean): string {
  const auto = a.supportsAutoCapture;
  if (zh) {
    const lines = [
      `请把你自己（${a.label}）接入我的 Synapse 记忆中枢。`,
      ``,
      `第 1 步 — 注册 MCP server（让你能读写我的长期记忆）`,
      `位置：${a.mcpConfig.where}`,
      a.mcpConfig.snippet,
      ``,
    ];
    if (a.hookConfig && auto !== "no") {
      lines.push(
        `第 2 步 — 开启自动捕获（每轮结束把对话同步到 Synapse，不用我说"记住"）`,
        `① 下载脚本：`,
        a.hookDownload,
        `② 注册 Stop / 回合结束钩子，位置：${a.hookConfig.where}`,
        a.hookConfig.snippet,
        a.hookConfig.note ? `注意：${a.hookConfig.note}` : ``,
        ``,
        `第 3 步 — 验证（没验证通过前，不要声称已生效）：重启后 approve/trust 这个 hook，发一句带唯一关键词的话，回合结束后我去 Synapse 搜它，搜到对应 ${a.id} 会话才算成功。若你这个版本其实不支持该 hook，如实告诉我，并改用下面的兜底。`,
        `兜底：${a.fallback}`,
      );
    } else {
      lines.push(
        `关于自动捕获：${auto === "no" ? "你这个客户端没有可靠的回合结束钩子，无法自动同步。" : "能否自动同步取决于你是否支持回合结束/生命周期钩子。"}`,
        `如支持这类钩子，可运行这个脚本（先下载）：`,
        a.hookDownload,
        a.hookConfig ? a.hookConfig.snippet : ``,
        `兜底：${a.fallback}`,
      );
    }
    return lines.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const lines = [
    `Please connect yourself (${a.label}) to my Synapse memory hub.`,
    ``,
    `STEP 1 — Register the MCP server (so you can read & write my long-term memory)`,
    `Location: ${a.mcpConfig.where}`,
    a.mcpConfig.snippet,
    ``,
  ];
  if (a.hookConfig && auto !== "no") {
    lines.push(
      `STEP 2 — Enable auto-capture (sync every turn to Synapse; no "remember" needed)`,
      `1) Download the script:`,
      a.hookDownload,
      `2) Register a Stop / end-of-turn hook at: ${a.hookConfig.where}`,
      a.hookConfig.snippet,
      a.hookConfig.note ? `Note: ${a.hookConfig.note}` : ``,
      ``,
      `STEP 3 — Verify (do NOT claim it works until confirmed): restart, approve/trust the hook, send a line with a unique keyword, and after the turn ends search it in Synapse — only if a matching "${a.id}" session shows up is auto-capture real. If your version doesn't actually support this hook, tell me and use the fallback below.`,
      `Fallback: ${a.fallback}`,
    );
  } else {
    lines.push(
      `On auto-capture: ${auto === "no" ? "this client has no reliable end-of-turn hook, so auto-capture cannot be enabled." : "whether it's possible depends on your support for an end-of-turn / lifecycle hook."}`,
      `If you DO support such a hook, run this script (download first):`,
      a.hookDownload,
      a.hookConfig ? a.hookConfig.snippet : ``,
      `Fallback: ${a.fallback}`,
    );
  }
  return lines.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
