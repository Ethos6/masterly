// @ts-check
/**
 * Talking to a model through any OpenAI-compatible Chat Completions endpoint:
 * a hosted provider, a local Ollama or LM Studio, or a freeflow gateway.
 *
 * Every model call in masterly asks for JSON. The client requests JSON mode when the
 * provider supports it, extracts the JSON object even when a model wraps it in prose
 * or code fences, validates it, and asks the model to fix its reply once if it
 * doesn't validate.
 */

export class LlmError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {object} LlmConfig
 * @property {string} baseUrl   e.g. https://api.groq.com/openai/v1
 * @property {string} [apiKey]
 * @property {string} model
 * @property {string} [source]  where the settings came from, for display
 *
 * @typedef {{role: "system"|"user"|"assistant", content: string}} Message
 */

const FREEFLOW = "http://127.0.0.1:4141";
const OLLAMA = "http://127.0.0.1:11434";

/**
 * Resolve the model settings: saved config, then environment, then a running
 * freeflow gateway, then a running Ollama. Returns null when nothing is available.
 * @param {Partial<LlmConfig>} [saved]
 * @param {{probe?: boolean}} [opts]
 * @returns {Promise<LlmConfig | null>}
 */
export async function resolveLlm(saved = {}, opts = {}) {
  const env = process.env;
  const baseUrl = saved.baseUrl || env.MASTERLY_BASE_URL || env.OPENAI_BASE_URL || env.OPENAI_API_BASE;
  const model = saved.model || env.MASTERLY_MODEL || env.OPENAI_MODEL;
  const apiKey = saved.apiKey || env.MASTERLY_API_KEY || env.OPENAI_API_KEY;
  if (baseUrl && model) return { baseUrl: trim(baseUrl), model, apiKey, source: saved.baseUrl ? "saved settings" : "environment variables" };
  if (opts.probe === false) return null;
  try {
    const r = await fetch(`${FREEFLOW}/health`, { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    if (j?.name === "freeflow") return { baseUrl: `${FREEFLOW}/v1`, model: model || "default", apiKey: apiKey || "freeflow", source: "freeflow gateway" };
  } catch {
    /* not running */
  }
  try {
    const r = await fetch(`${OLLAMA}/v1/models`, { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    const first = j?.data?.[0]?.id;
    if (first) return { baseUrl: `${OLLAMA}/v1`, model: model || first, apiKey: "ollama", source: "local Ollama" };
  } catch {
    /* not running */
  }
  return null;
}

/** @param {string} u */
function trim(u) {
  return u.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * Pull the first JSON object out of a model reply.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonReply(text) {
  const s = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  // The outermost {...}: scan with a bracket counter that understands strings.
  const start = s.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // common slip: trailing commas
          return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
        }
      }
    }
  }
  throw new LlmError("the model did not return JSON");
}

export class Llm {
  /** @param {LlmConfig} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.jsonMode = true;
    this.calls = 0;
    this.usage = { input: 0, output: 0 };
  }

  /**
   * @param {Message[]} messages
   * @param {{json?: boolean, temperature?: number, maxTokens?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    /** @type {any} */
    const body = { model: this.cfg.model, messages, temperature: opts.temperature ?? 0.2 };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.json && this.jsonMode) body.response_format = { type: "json_object" };
    let wait = 2000;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        });
      } catch (e) {
        if (opts.signal?.aborted) throw new LlmError("cancelled");
        if (attempt < 2) {
          await sleep(wait);
          wait *= 2;
          continue;
        }
        throw new LlmError(`cannot reach the model at ${this.cfg.baseUrl}: ${/** @type {any} */ (e)?.cause?.code || /** @type {Error} */ (e).message}`);
      }
      const text = await res.text();
      if (res.ok) {
        let j;
        try {
          j = JSON.parse(text);
        } catch {
          throw new LlmError("the model endpoint returned something that is not JSON");
        }
        this.calls++;
        this.usage.input += j.usage?.prompt_tokens || 0;
        this.usage.output += j.usage?.completion_tokens || 0;
        const content = j.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new LlmError("the model returned an empty reply");
        return content;
      }
      // Providers without JSON mode: drop it and carry on.
      if (res.status === 400 && body.response_format && /response_format|json_object|json mode/i.test(text)) {
        this.jsonMode = false;
        delete body.response_format;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : wait);
        wait *= 2;
        continue;
      }
      throw new LlmError(`the model endpoint answered ${res.status}: ${errorText(text)}`, res.status);
    }
  }

  /**
   * Ask for a JSON reply and validate it; on a validation problem, show the model its
   * own reply and the problem, once.
   * @template T
   * @param {Message[]} messages
   * @param {(value: any) => T} validate  throws with a helpful message when invalid
   * @param {{temperature?: number, maxTokens?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<T>}
   */
  async json(messages, validate, opts = {}) {
    let reply = await this.chat(messages, { ...opts, json: true });
    try {
      return validate(parseJsonReply(reply));
    } catch (e) {
      const problem = /** @type {Error} */ (e).message;
      reply = await this.chat(
        [...messages, { role: "assistant", content: reply }, { role: "user", content: `That reply could not be used: ${problem}\nReply again with only the corrected JSON object.` }],
        { ...opts, json: true },
      );
      return validate(parseJsonReply(reply));
    }
  }
}

/** @param {string} t */
function errorText(t) {
  try {
    const j = JSON.parse(t);
    return String(j.error?.message || j.error || j.message || t).slice(0, 300);
  } catch {
    return t.replace(/\s+/g, " ").slice(0, 300);
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
