// @ts-check
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { listCourses, loadCourse, createCourse, updateCourse, deleteCourse, loadPassages, savePassages, loadSettings, saveSettings, CourseGone } from "./store.js";
import { addSource, buildCourse } from "./build.js";
import { Llm, resolveLlm } from "./llm.js";
import { conceptStates, nextQuestions, publicQuestion, grade, record, hint, ask, stats } from "./study.js";
import { ankiTsv, studyGuide } from "./export.js";
import { SUPPORTED } from "./extract.js";
import { placeOf } from "./chunk.js";

export const VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
const UI = fileURLToPath(new URL("./ui/index.html", import.meta.url));
const MAX_BODY = 140 * 1024 * 1024;

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{log?: (line: string) => void, allowedHosts?: string[]}} [opts]
 */
export function createApp(opts = {}) {
  const log = opts.log || ((/** @type {string} */ l) => process.stdout.write(l + "\n"));
  /** @type {Map<string, {ac: AbortController, events: any[], listeners: Set<http.ServerResponse>, done: boolean}>} */
  const builds = new Map();

  async function llm() {
    const cfg = await resolveLlm(loadSettings());
    return cfg ? new Llm(cfg) : null;
  }

  /** @param {string} id */
  function course(id) {
    let c;
    try {
      c = loadCourse(id);
    } catch {
      throw new HttpError(404, "no such course");
    }
    if (!c) throw new HttpError(404, "no such course");
    return c;
  }

  /** @param {import("./store.js").Course} c */
  function summary(c) {
    const s = stats(c);
    return { id: c.id, name: c.name, sources: c.sources.length, concepts: s.concepts, questions: s.questions, mastered: s.mastered, dueNow: s.dueNow, overall: s.overall, build: c.build, createdAt: c.createdAt };
  }

  /** @param {import("./store.js").Course} c */
  function detail(c) {
    const states = conceptStates(c);
    const passages = new Map(loadPassages(c.id).map((p) => [p.id, p]));
    const titles = new Map(c.sources.map((s) => [s.id, s.title]));
    return {
      ...summary(c),
      language: c.language || "",
      settings: c.settings,
      sources: c.sources.map((s) => ({ ...s, sha256: undefined })),
      stats: stats(c),
      building: builds.has(c.id) && !builds.get(c.id)?.done,
      concepts: [...c.concepts]
        .sort((a, b) => a.order - b.order)
        .map((x) => ({
          id: x.id,
          name: x.name,
          summary: x.summary,
          order: x.order,
          prereqs: x.prereqs,
          state: states.get(x.id),
          evidence: x.evidence.slice(0, 4).map((e) => {
            const p = passages.get(e.chunk);
            return { excerpt: e.excerpt, where: p ? placeOf(titles.get(p.source) || "", p.label) : e.chunk };
          }),
        })),
    };
  }

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  function body(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const parts = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "upload too large (100 MB per file)"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => {
        if (!parts.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
        } catch {
          reject(new HttpError(400, "request body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  /** @param {http.ServerResponse} res @param {number} status @param {any} value */
  function json(res, status, value) {
    const s = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
    res.end(s);
  }

  /** Only answer requests addressed to this machine by name (blocks DNS rebinding). @param {http.IncomingMessage} req */
  function hostOk(req) {
    const host = String(req.headers.host || "").toLowerCase();
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    return ["127.0.0.1", "localhost", "[::1]", ...(opts.allowedHosts || [])].includes(name);
  }

  /**
   * State-changing requests must come from masterly's own page: a custom header
   * (which cross-site pages can't send without a CORS preflight masterly never
   * grants) and, when present, a same-origin Origin.
   * @param {http.IncomingMessage} req
   */
  function writeOk(req) {
    if (req.headers["x-masterly"] !== "1") return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(String(origin)).host === req.headers.host;
    } catch {
      return false;
    }
  }

  /** @param {string} id @param {any} ev */
  function emit(id, ev) {
    const b = builds.get(id);
    if (!b) return;
    b.events.push(ev);
    for (const l of b.listeners) l.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  /** @param {import("./store.js").Course} c @param {Llm} model */
  function startBuild(c, model) {
    const existing = builds.get(c.id);
    if (existing && !existing.done) throw new HttpError(409, "this course is already being built");
    const ac = new AbortController();
    builds.set(c.id, { ac, events: [], listeners: existing?.listeners || new Set(), done: false });
    log(`building "${c.name}" with ${model.cfg.model}`);
    buildCourse(c, model, { signal: ac.signal, onProgress: (p) => emit(c.id, { type: "progress", ...p }) })
      .then((done) => {
        emit(c.id, { type: "done", concepts: done.concepts.length, questions: done.questions.length, rejected: done.build.rejected });
        log(`built "${c.name}": ${done.concepts.length} concepts, ${done.questions.length} questions (${done.build.rejected?.questions || 0} rejected as ungrounded)`);
      })
      .catch((e) => {
        emit(c.id, { type: "error", message: ac.signal.aborted ? "cancelled" : e.message });
        log(`build of "${c.name}" failed: ${e.message}`);
      })
      .finally(() => {
        const b = builds.get(c.id);
        if (b) {
          b.done = true;
          for (const l of b.listeners) l.end();
          b.listeners.clear();
        }
      });
  }

  /** @type {Map<string, number>} last graded score per course/question, used when the rating is recorded */
  const pendingScore = new Map();

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @returns {Promise<void>} */
  async function route(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname;
    const m = req.method || "GET";

    if (m === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
      res.end(fs.readFileSync(UI, "utf8").replaceAll("__MASTERLY_VERSION__", VERSION).replace("__SUPPORTED__", SUPPORTED.join(",")));
      return;
    }
    if (p === "/health") return json(res, 200, { ok: true, name: "masterly", version: VERSION });
    if (!p.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (m !== "GET" && !writeOk(req)) return json(res, 403, { error: "requests must come from the masterly page" });

    const parts = p.split("/").filter(Boolean).slice(1); // after "api"
    if (parts[0] === "state" && m === "GET") {
      const cfg = await resolveLlm(loadSettings());
      const s = loadSettings();
      return json(res, 200, {
        version: VERSION,
        llm: cfg ? { configured: true, source: cfg.source, model: cfg.model, baseUrl: cfg.baseUrl } : { configured: false },
        settings: { baseUrl: s.baseUrl || "", model: s.model || "", hasKey: Boolean(s.apiKey) },
        courses: listCourses().map(summary),
      });
    }
    if (parts[0] === "settings" && m === "POST" && parts.length === 1) {
      const b = await body(req);
      const cur = loadSettings();
      const next = { ...cur };
      for (const k of /** @type {const} */ (["baseUrl", "model"])) if (typeof b[k] === "string") b[k].trim() ? (next[k] = b[k].trim()) : delete next[k];
      if (typeof b.apiKey === "string" && b.apiKey.trim()) next.apiKey = b.apiKey.trim();
      if (b.clearKey === true) delete next.apiKey;
      if (next.baseUrl) {
        try {
          const u = new URL(next.baseUrl);
          if (!/^https?:$/.test(u.protocol)) throw new Error();
        } catch {
          throw new HttpError(400, "the base URL must be an http(s) URL");
        }
      }
      saveSettings(next);
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "settings" && parts[1] === "test" && m === "POST") {
      const model = await llm();
      if (!model) throw new HttpError(400, "no model configured");
      const t0 = Date.now();
      try {
        await model.json([{ role: "user", content: 'Reply with this JSON object and nothing else: {"ok": true}' }], (v) => {
          if (v?.ok !== true) throw new Error('expected {"ok": true}');
          return v;
        });
        return json(res, 200, { ok: true, ms: Date.now() - t0, model: model.cfg.model });
      } catch (e) {
        return json(res, 200, { ok: false, error: /** @type {Error} */ (e).message });
      }
    }

    if (parts[0] !== "courses") return json(res, 404, { error: "not found" });
    if (parts.length === 1 && m === "POST") {
      const b = await body(req);
      const c = createCourse(String(b.name || ""));
      return json(res, 201, summary(c));
    }
    if (parts.length === 1 && m === "GET") return json(res, 200, listCourses().map(summary));

    const c = course(parts[1]);
    const action = parts[2];
    if (!action && m === "GET") return json(res, 200, detail(c));
    if (!action && m === "DELETE") {
      builds.get(c.id)?.ac.abort();
      deleteCourse(c.id);
      return json(res, 200, { ok: true });
    }
    if (action === "settings" && m === "POST") {
      const b = await body(req);
      const num = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
      const saved = updateCourse(c.id, (x) => {
        if (typeof b.name === "string" && b.name.trim()) x.name = b.name.trim().slice(0, 120);
        if (typeof b.language === "string") x.language = b.language.trim().slice(0, 40) || undefined;
        x.settings = {
          retention: num(b.retention, 0.7, 0.97) ?? x.settings.retention,
          newPerDay: Math.round(num(b.newPerDay, 0, 500) ?? x.settings.newPerDay),
          questionsPerConcept: Math.round(num(b.questionsPerConcept, 1, 8) ?? x.settings.questionsPerConcept),
          maxConcepts: Math.round(num(b.maxConcepts, 3, 200) ?? x.settings.maxConcepts),
        };
      });
      return json(res, 200, detail(saved));
    }
    if (action === "sources" && m === "POST") {
      if (builds.get(c.id) && !builds.get(c.id)?.done) throw new HttpError(409, "wait for the build to finish");
      const b = await body(req);
      if (typeof b.name !== "string" || typeof b.data !== "string") throw new HttpError(400, "send {name, data} with the file as base64");
      const r = await addSource(c, b.name.split(/[\\/]/).pop() || "file", Buffer.from(b.data, "base64")).catch((e) => {
        throw new HttpError(400, e.message);
      });
      return json(res, 200, { ...r, course: detail(c) });
    }
    if (action === "sources" && parts[3] && m === "DELETE") {
      if (builds.get(c.id) && !builds.get(c.id)?.done) throw new HttpError(409, "wait for the build to finish");
      const sid = parts[3];
      if (!c.sources.some((s) => s.id === sid)) throw new HttpError(404, "no such source");
      savePassages(c.id, loadPassages(c.id).filter((x) => x.source !== sid));
      const saved = updateCourse(c.id, (x) => {
        x.sources = x.sources.filter((s) => s.id !== sid);
        x.build = { ...x.build, status: x.sources.length ? "ready" : "empty", message: "Material changed: rebuild to update concepts and questions." };
      });
      return json(res, 200, detail(saved));
    }
    if (action === "build" && m === "POST") {
      if (parts[3] === "cancel") {
        builds.get(c.id)?.ac.abort();
        return json(res, 200, { ok: true });
      }
      if (!c.sources.length) throw new HttpError(400, "add some material first");
      const model = await llm();
      if (!model) throw new HttpError(400, "no model is configured: open Settings");
      startBuild(c, model);
      return json(res, 202, { ok: true });
    }
    if (action === "events" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const b = builds.get(c.id);
      if (!b) {
        res.end();
        return;
      }
      for (const ev of b.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (b.done) {
        res.end();
        return;
      }
      b.listeners.add(res);
      req.on("close", () => b.listeners.delete(res));
      return;
    }
    if (action === "next" && m === "GET") {
      const n = nextQuestions(c, { concept: url.searchParams.get("concept") || undefined });
      const q = c.questions.find((x) => x.id === n.queue[0]);
      const card = q ? c.cards[q.id] : null;
      return json(res, 200, { ...n, question: q ? { ...publicQuestion(q), conceptName: c.concepts.find((x) => x.id === q.concept)?.name || "", isNew: !card || card.state === "new" } : null });
    }
    if (action === "answer" && m === "POST") {
      const b = await body(req);
      const model = (await llm()) || null;
      const g = await grade(c, String(b.question), b.answer, model).catch((e) => {
        throw new HttpError(e instanceof Error && /choose|answer|write/.test(e.message) ? 400 : 502, e.message);
      });
      pendingScore.set(`${c.id}/${b.question}`, g.score);
      const passages = new Map(loadPassages(c.id).map((x) => [x.id, x]));
      const titles = new Map(c.sources.map((s) => [s.id, s.title]));
      const evidence = g.reveal.evidence.map((e) => {
        const ps = passages.get(e.chunk);
        return { excerpt: e.excerpt, where: ps ? placeOf(titles.get(ps.source) || "", ps.label) : e.chunk };
      });
      return json(res, 200, { ...g, reveal: { ...g.reveal, evidence } });
    }
    if (action === "rate" && m === "POST") {
      const b = await body(req);
      const key = `${c.id}/${b.question}`;
      let card;
      try {
        card = record(c, String(b.question), /** @type {any} */ (Number(b.rating)), { score: pendingScore.get(key), answer: typeof b.answer === "string" ? b.answer : undefined });
      } catch (e) {
        if (e instanceof CourseGone) throw e;
        throw new HttpError(/no longer exists/.test(/** @type {Error} */ (e).message) ? 409 : 400, /** @type {Error} */ (e).message);
      }
      pendingScore.delete(key);
      return json(res, 200, { card, stats: stats(c) });
    }
    if (action === "hint" && m === "POST") {
      const b = await body(req);
      const model = await llm();
      if (!model) throw new HttpError(400, "hints need a model: open Settings");
      return json(res, 200, { hint: await hint(c, String(b.question), model) });
    }
    if (action === "ask" && m === "POST") {
      const b = await body(req);
      const question = String(b.question || "").trim();
      if (!question) throw new HttpError(400, "ask a question");
      const model = await llm();
      if (!model) throw new HttpError(400, "asking needs a model: open Settings");
      return json(res, 200, await ask(c, question.slice(0, 2000), model));
    }
    if (action === "export" && m === "GET") {
      const kind = parts[3];
      const safe = c.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "course";
      if (kind === "anki") {
        res.writeHead(200, { "content-type": "text/tab-separated-values; charset=utf-8", "content-disposition": `attachment; filename="${encodeURIComponent(safe)}.anki.txt"` });
        res.end(ankiTsv(c));
        return;
      }
      if (kind === "guide") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${encodeURIComponent(safe)}.md"` });
        res.end(studyGuide(c));
        return;
      }
    }
    return json(res, 404, { error: "not found" });
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @returns {Promise<void>} */
  async function handle(req, res) {
    try {
      if (!hostOk(req)) return json(res, 403, { error: "masterly only answers requests addressed to localhost" });
      await route(req, res);
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (res.headersSent) return void res.end();
      json(res, err instanceof HttpError ? err.status : err instanceof CourseGone ? 404 : 500, { error: err?.message || String(err) });
    }
  }

  return { handle, builds };
}

/** @param {{port?: number, host?: string, log?: (line: string) => void, allowedHosts?: string[]}} [opts] */
export function startServer(opts = {}) {
  const app = createApp(opts);
  const server = http.createServer(app.handle);
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4747, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve({ server, app, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port });
    });
  });
}
