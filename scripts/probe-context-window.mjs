import process from "node:process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const providerName = args.get("--provider");
const startChars = Number(args.get("--start") ?? 500_000);
const maxChars = Number(args.get("--max") ?? 1_100_000);
const minChars = Number(args.get("--min") ?? 16_000);
const rounds = Number(args.get("--rounds") ?? 8);

const providers = {
  novai: {
    baseURL: process.env.GEMINI_BASE_URL || process.env.NOVAI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY || process.env.NOVAI_API_KEY,
    model: process.env.GEMINI_MODEL || "[次]gemini-3.1-pro-preview",
  },
  fucheers: {
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  },
};

if (!providerName || !providers[providerName]) {
  console.error("Usage: node --env-file=.env.local scripts/probe-context-window.mjs --provider novai|fucheers");
  process.exit(2);
}

const provider = providers[providerName];
if (!provider.baseURL || !provider.apiKey || !provider.model) {
  console.error(`[${providerName}] missing baseURL/apiKey/model env`);
  process.exit(2);
}

const baseURL = provider.baseURL.endsWith("/v1")
  ? provider.baseURL
  : `${provider.baseURL.replace(/\/$/, "")}/v1`;

function makePayload(chars) {
  const marker = "\nEND_OF_CONTEXT_PROBE";
  const fillerLen = Math.max(0, chars - marker.length);
  return "a".repeat(fillerLen) + marker;
}

async function probe(chars) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        max_tokens: 1,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Reply with exactly OK.",
          },
          {
            role: "user",
            content: makePayload(chars),
          },
        ],
      }),
    });
    const elapsedMs = Date.now() - started;
    const text = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        chars,
        status: resp.status,
        elapsedMs,
        error: text.slice(0, 500).replace(/\s+/g, " "),
      };
    }
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, chars, status: resp.status, elapsedMs, error: `non-json: ${text.slice(0, 200)}` };
    }
    return {
      ok: true,
      chars,
      status: resp.status,
      elapsedMs,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
      finishReason: json.choices?.[0]?.finish_reason,
      contentPreview: String(json.choices?.[0]?.message?.content ?? "").slice(0, 40),
    };
  } catch (err) {
    return {
      ok: false,
      chars,
      status: "exception",
      elapsedMs: Date.now() - started,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function printResult(result) {
  const base = `[${providerName}] ${result.chars.toLocaleString()} chars -> ${result.ok ? "OK" : "FAIL"} in ${(result.elapsedMs / 1000).toFixed(1)}s`;
  if (result.ok) {
    console.log(`${base}; prompt_tokens=${result.promptTokens ?? "n/a"} total_tokens=${result.totalTokens ?? "n/a"} finish=${result.finishReason ?? "n/a"}`);
  } else {
    console.log(`${base}; status=${result.status}; error=${result.error ?? ""}`);
  }
}

console.log(`[${providerName}] model=${provider.model}`);
console.log(`[${providerName}] baseURL=${baseURL}`);
console.log(`[${providerName}] apiKey=present(${provider.apiKey.length} chars)`);

let low = 0;
let high = null;

const first = await probe(startChars);
printResult(first);

if (first.ok) {
  low = first.chars;
  let next = Math.min(maxChars, Math.ceil(first.chars * 1.5));
  while (next > low && next <= maxChars) {
    const result = await probe(next);
    printResult(result);
    if (result.ok) {
      low = result.chars;
      if (low >= maxChars) break;
      next = Math.min(maxChars, Math.ceil(low * 1.5));
    } else {
      high = result.chars;
      break;
    }
  }
} else {
  high = first.chars;
  let next = Math.max(minChars, Math.floor(first.chars / 2));
  while (next >= minChars) {
    const result = await probe(next);
    printResult(result);
    if (result.ok) {
      low = result.chars;
      break;
    }
    high = result.chars;
    next = Math.floor(next / 2);
  }
}

if (high !== null && low > 0) {
  for (let i = 0; i < rounds; i++) {
    if (high - low < 8_000) break;
    const mid = Math.floor((low + high) / 2);
    const result = await probe(mid);
    printResult(result);
    if (result.ok) low = result.chars;
    else high = result.chars;
  }
}

console.log(`[${providerName}] RESULT max_ok_chars>=${low.toLocaleString()}${high === null ? `; no failure up to ${maxChars.toLocaleString()}` : `; first_known_fail<=${high.toLocaleString()}`}`);
