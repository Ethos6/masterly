// @ts-check
import crypto from "node:crypto";
import { extract } from "./extract.js";
import { chunk } from "./chunk.js";
import { verifyEvidence, normalize } from "./ground.js";
import { Index } from "./search.js";
import { conceptsPrompt, prerequisitesPrompt, questionsPrompt, formatPassages } from "./prompts.js";
import { loadPassages, savePassages, updateCourse } from "./store.js";

/**
 * Building a course:
 *   1. add sources: extract text, split into passages
 *   2. concepts: the model proposes concepts with quotes; unverifiable ones are dropped
 *   3. order: prerequisite edges, cycles removed, topological order
 *   4. questions: per concept, grounded in that concept's passages; unverifiable ones dropped
 *
 * @typedef {{stage: string, done: number, total: number, message: string}} Progress
 */

const BATCH_CHARS = 9000;

/**
 * Add one file to a course. Re-adding identical content is a no-op.
 * @param {import("./store.js").Course} course
 * @param {string} fileName
 * @param {Buffer} data
 */
export async function addSource(course, fileName, data) {
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const dupe = course.sources.find((s) => s.sha256 === sha256);
  if (dupe) return { source: dupe, passages: 0, duplicate: true };
  const ex = await extract(fileName, data);
  const passages = loadPassages(course.id);
  let n = passages.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0);
  const sourceId = `S${course.sources.reduce((m, s) => Math.max(m, Number(s.id.slice(1)) || 0), 0) + 1}`;
  const added = chunk(ex.sections, sourceId, () => `P${++n}`);
  if (!added.length) throw new Error(`${fileName} contains no text`);
  /** @type {import("./store.js").Source} */
  const source = { id: sourceId, file: fileName, title: ex.title, type: ex.type, chars: ex.sections.reduce((s, x) => s + x.text.length, 0), sha256, addedAt: Date.now() };
  savePassages(course.id, [...passages, ...added]);
  Object.assign(
    course,
    updateCourse(course.id, (c) => {
      c.sources.push(source);
      if (c.build.status === "empty" || c.build.status === "built") c.build = { ...c.build, status: "ready" };
    }),
  );
  return { source, passages: added.length, duplicate: false };
}

/** @param {string} name */
export function conceptKey(name) {
  return normalize(name)
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/(\p{L}{3,})s\b/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {any} v */
function validateConcepts(v) {
  if (!v || !Array.isArray(v.concepts)) throw new Error('expected {"concepts": [...]}');
  return v.concepts.filter((/** @type {any} */ c) => c && typeof c.name === "string" && c.name.trim());
}

/**
 * Order concepts so prerequisites come first. Cycles are broken by dropping the
 * edge that closes them (keeping the earlier-appearing concept first).
 * @param {{id: string, prereqs: string[], first: number}[]} nodes
 * @returns {{order: string[], dropped: [string, string][]}}
 */
export function orderConcepts(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** @type {[string, string][]} */
  const dropped = [];
  /** @type {[string, string][]} */
  const edges = [];
  for (const n of nodes) for (const p of new Set(n.prereqs)) if (p !== n.id && byId.has(p)) edges.push([n.id, p]);
  // Add edges most plausible first: a prerequisite met earlier in the material is
  // more likely right than one met later. An edge that would close a cycle is dropped.
  const gap = (/** @type {[string, string]} */ [a, b]) => /** @type {any} */ (byId.get(b)).first - /** @type {any} */ (byId.get(a)).first;
  edges.sort((x, y) => gap(x) - gap(y));
  /** @type {Map<string, Set<string>>} */
  const req = new Map(nodes.map((n) => [n.id, new Set()]));
  const reaches = (/** @type {string} */ from, /** @type {string} */ to) => {
    const stack = [from];
    const seen = new Set();
    while (stack.length) {
      const x = /** @type {string} */ (stack.pop());
      if (x === to) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(.../** @type {Set<string>} */ (req.get(x)));
    }
    return false;
  };
  for (const [a, b] of edges) {
    // a requires b; adding it closes a cycle if b already (transitively) requires a
    if (reaches(b, a)) dropped.push([a, b]);
    else /** @type {Set<string>} */ (req.get(a)).add(b);
  }
  for (const n of nodes) n.prereqs = [.../** @type {Set<string>} */ (req.get(n.id))];
  const sorted = [...nodes].sort((a, b) => a.first - b.first);
  // Kahn's algorithm; ties broken by where the concept first appears in the material
  const indeg = new Map(nodes.map((n) => [n.id, n.prereqs.length]));
  /** @type {Map<string, string[]>} */
  const users = new Map();
  for (const n of nodes) for (const p of n.prereqs) users.set(p, [...(users.get(p) || []), n.id]);
  const ready = sorted.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => /** @type {any} */ (byId.get(a)).first - /** @type {any} */ (byId.get(b)).first);
    const id = /** @type {string} */ (ready.shift());
    order.push(id);
    for (const u of users.get(id) || []) {
      indeg.set(u, /** @type {number} */ (indeg.get(u)) - 1);
      if (indeg.get(u) === 0) ready.push(u);
    }
  }
  return { order, dropped };
}

/**
 * Validate one generated question. Returns the cleaned question or the reason it was rejected.
 * @param {any} q
 * @param {Map<string, {text: string}>} passages
 * @returns {{ok: true, q: Omit<import("./store.js").Question, "id"|"concept">} | {ok: false, reason: string}}
 */
export function checkQuestion(q, passages) {
  if (!q || typeof q !== "object") return { ok: false, reason: "not an object" };
  const type = String(q.type || "").toLowerCase();
  const prompt = typeof q.prompt === "string" ? q.prompt.trim() : typeof q.question === "string" ? q.question.trim() : "";
  if (prompt.length < 8) return { ok: false, reason: "missing prompt" };
  const explanation = typeof q.explanation === "string" ? q.explanation.trim() : "";
  const { verified, rejected } = verifyEvidence(q.evidence, passages);
  if (!verified.length) return { ok: false, reason: `no verifiable evidence (${rejected[0]?.reason || "none given"})` };
  const base = { prompt, explanation, evidence: verified };
  if (type === "mcq") {
    const options = Array.isArray(q.options) ? q.options.map((/** @type {any} */ o) => String(o ?? "").trim().replace(/^[A-Ea-e][.)]\s+/, "")) : [];
    if (options.length < 3 || options.length > 5 || options.some((/** @type {string} */ o) => !o)) return { ok: false, reason: "a multiple-choice question needs 3 to 5 options" };
    if (new Set(options.map(normalize)).size !== options.length) return { ok: false, reason: "duplicate options" };
    let answer = q.answer;
    if (typeof answer === "string") {
      const letter = answer.trim().match(/^[A-Ea-e]$/);
      answer = letter ? letter[0].toUpperCase().charCodeAt(0) - 65 : /^\d+$/.test(answer.trim()) ? Number(answer) : options.findIndex((/** @type {string} */ o) => normalize(o) === normalize(answer));
    }
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return { ok: false, reason: "answer is not a valid option index" };
    return { ok: true, q: { type: "mcq", ...base, options, answer } };
  }
  if (type === "tf" || type === "true_false" || type === "truefalse") {
    let answer = q.answer;
    if (typeof answer === "string") answer = /^(true|t|yes)$/i.test(answer.trim()) ? true : /^(false|f|no)$/i.test(answer.trim()) ? false : answer;
    if (typeof answer !== "boolean") return { ok: false, reason: "a true/false question needs a boolean answer" };
    return { ok: true, q: { type: "tf", ...base, answer } };
  }
  if (type === "short" || type === "short_answer" || type === "open") {
    const answer = typeof q.answer === "string" ? q.answer.trim() : "";
    const keyPoints = Array.isArray(q.keyPoints || q.key_points) ? (q.keyPoints || q.key_points).map((/** @type {any} */ k) => String(k).trim()).filter(Boolean).slice(0, 5) : [];
    if (answer.length < 3) return { ok: false, reason: "a short-answer question needs a model answer" };
    return { ok: true, q: { type: "short", ...base, answer, keyPoints: keyPoints.length ? keyPoints : [answer] } };
  }
  return { ok: false, reason: `unknown question type "${q.type}"` };
}

/**
 * Run `fn` over items with at most `n` running at once.
 * @template T, R
 * @param {T[]} items @param {number} n @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pool(items, n, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Build (or rebuild) the concept map and questions. Review history is kept for
 * questions that survive a rebuild unchanged.
 * @param {import("./store.js").Course} course
 * @param {import("./llm.js").Llm} llm
 * @param {{onProgress?: (p: Progress) => void, signal?: AbortSignal, concurrency?: number}} [opts]
 */
export async function buildCourse(course, llm, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const passages = loadPassages(course.id);
  if (!passages.length) throw new Error("add some material first");
  const titles = new Map(course.sources.map((s) => [s.id, s.title]));
  const byId = new Map(passages.map((p) => [p.id, p]));
  const firstSeen = new Map(passages.map((p, i) => [p.id, i]));
  const settings = course.settings;
  const startBuild = { status: /** @type {const} */ ("building"), at: Date.now(), model: llm.cfg.model };
  Object.assign(course, updateCourse(course.id, (c) => (c.build = startBuild)));

  try {
    // ---- 1. concepts, batch by batch
    /** @type {string[][]} */
    const batches = [];
    let cur = [];
    let size = 0;
    for (const p of passages) {
      if (cur.length && size + p.text.length > BATCH_CHARS) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p.id);
      size += p.text.length;
    }
    if (cur.length) batches.push(cur);
    const perBatch = Math.max(3, Math.min(12, Math.ceil((settings.maxConcepts * 1.5) / batches.length)));
    let rejectedConcepts = 0;
    let done = 0;
    progress({ stage: "concepts", done, total: batches.length, message: "Finding the key concepts" });
    const found = await pool(batches, opts.concurrency ?? 3, async (ids) => {
      const shown = new Map(ids.map((id) => [id, /** @type {any} */ (byId.get(id))]));
      const list = await llm.json(conceptsPrompt(formatPassages([...shown.values()], titles), { courseName: course.name, language: course.language, max: perBatch }), validateConcepts, { signal: opts.signal });
      const kept = [];
      for (const c of list) {
        const { verified } = verifyEvidence(c.evidence, shown);
        if (!verified.length) {
          rejectedConcepts++;
          continue;
        }
        kept.push({ name: String(c.name).trim().slice(0, 120), summary: String(c.summary || "").trim().slice(0, 400), prereqNames: Array.isArray(c.prerequisites) ? c.prerequisites.map(String) : [], evidence: verified });
      }
      progress({ stage: "concepts", done: ++done, total: batches.length, message: `Read ${done} of ${batches.length} part${batches.length === 1 ? "" : "s"} of the material` });
      return kept;
    });

    // merge duplicates found in different batches
    /** @type {Map<string, {name: string, summary: string, prereqNames: string[], evidence: import("./ground.js").VerifiedEvidence[]}>} */
    const merged = new Map();
    for (const c of found.flat()) {
      const key = conceptKey(c.name);
      if (!key) continue;
      const m = merged.get(key);
      if (!m) merged.set(key, { ...c, evidence: [...c.evidence] });
      else {
        for (const e of c.evidence) if (!m.evidence.some((x) => x.chunk === e.chunk && x.start === e.start)) m.evidence.push(e);
        m.prereqNames.push(...c.prereqNames);
        if (c.summary.length > m.summary.length) m.summary = c.summary;
      }
    }
    let concepts = [...merged.values()].map((c) => ({ ...c, first: Math.min(...c.evidence.map((e) => firstSeen.get(e.chunk) ?? 1e9)) }));
    if (!concepts.length) throw new Error("the model found no concepts it could support with quotes from the material");
    if (concepts.length > settings.maxConcepts) {
      concepts.sort((a, b) => b.evidence.length - a.evidence.length || a.first - b.first);
      concepts = concepts.slice(0, settings.maxConcepts);
    }
    concepts.sort((a, b) => a.first - b.first);

    // ---- 2. order
    progress({ stage: "order", done: 0, total: 1, message: "Working out what to learn first" });
    // keep ids stable across rebuilds when the concept name is unchanged
    const oldIds = new Map(course.concepts.map((c) => [conceptKey(c.name), c.id]));
    let maxId = course.concepts.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
    const withIds = concepts.map((c) => ({ ...c, id: oldIds.get(conceptKey(c.name)) || `C${++maxId}` }));
    const keyToId = new Map(withIds.map((c) => [conceptKey(c.name), c.id]));
    const nodes = withIds.map((c) => ({ id: c.id, first: c.first, prereqs: c.prereqNames.map((n) => keyToId.get(conceptKey(n))).filter((x) => typeof x === "string") }));
    if (withIds.length > 1) {
      try {
        const edges = await llm.json(prerequisitesPrompt(withIds, { courseName: course.name }), (v) => {
          if (!v || !Array.isArray(v.edges)) throw new Error('expected {"edges": [...]}');
          return v.edges;
        }, { signal: opts.signal });
        const valid = new Set(withIds.map((c) => c.id));
        for (const e of edges) {
          const node = nodes.find((n) => n.id === e?.concept);
          if (node && Array.isArray(e.requires)) node.prereqs.push(...e.requires.map(String).filter((/** @type {string} */ r) => valid.has(r)));
        }
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        // ordering is helpful but not essential: fall back to the order of the material
      }
    }
    const { order } = orderConcepts(nodes);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    /** @type {import("./store.js").Concept[]} */
    const finalConcepts = order.map((id, i) => {
      const c = /** @type {any} */ (withIds.find((x) => x.id === id));
      return { id, name: c.name, summary: c.summary, prereqs: /** @type {any} */ (nodeById.get(id)).prereqs, evidence: c.evidence, order: i };
    });
    progress({ stage: "order", done: 1, total: 1, message: `Found ${finalConcepts.length} concepts` });

    // ---- 3. questions
    const index = new Index(passages);
    let rejectedQuestions = 0;
    done = 0;
    const existing = new Map(course.questions.map((q) => [normalize(q.prompt), q]));
    /** @type {import("./store.js").Question[]} */
    const questions = [];
    let qn = course.questions.reduce((m, q) => Math.max(m, Number(q.id.slice(1)) || 0), 0);
    progress({ stage: "questions", done, total: finalConcepts.length, message: "Writing questions" });
    const perConcept = await pool(finalConcepts, opts.concurrency ?? 3, async (c) => {
      const ids = [...new Set(c.evidence.map((e) => e.chunk))];
      for (const hit of index.search(`${c.name} ${c.summary}`, 4)) if (ids.length < 4 && !ids.includes(hit.id)) ids.push(hit.id);
      const shown = new Map(ids.map((id) => [id, /** @type {any} */ (byId.get(id))]));
      const text = formatPassages([...shown.values()], titles);
      /** @type {Omit<import("./store.js").Question, "id"|"concept">[]} */
      const kept = [];
      const reasons = [];
      for (let attempt = 0; attempt < 2 && kept.length < Math.min(2, settings.questionsPerConcept); attempt++) {
        const want = settings.questionsPerConcept - kept.length;
        const raw = await llm.json(
          questionsPrompt(c, text, { count: want, language: course.language, avoid: kept.map((k) => k.prompt) }),
          (v) => {
            if (!v || !Array.isArray(v.questions)) throw new Error('expected {"questions": [...]}');
            return v.questions;
          },
          { signal: opts.signal, temperature: 0.4 },
        );
        for (const r of raw) {
          const res = checkQuestion(r, shown);
          if (!res.ok) {
            rejectedQuestions++;
            reasons.push(res.reason);
            continue;
          }
          if (kept.some((k) => normalize(k.prompt) === normalize(res.q.prompt))) continue;
          kept.push(res.q);
          if (kept.length >= settings.questionsPerConcept) break;
        }
      }
      progress({ stage: "questions", done: ++done, total: finalConcepts.length, message: `Wrote questions for ${done} of ${finalConcepts.length} concepts` });
      return { concept: c, kept, reasons };
    });
    const used = new Set();
    for (const { concept, kept } of perConcept) {
      for (const q of kept) {
        const prev = existing.get(normalize(q.prompt));
        const id = prev && prev.type === q.type && !used.has(prev.id) ? prev.id : `Q${++qn}`;
        used.add(id);
        questions.push({ ...q, id, concept: concept.id });
      }
    }
    if (!questions.length) throw new Error("no question could be verified against the material");

    // Merge into the course as it is now on disk: reviews, settings or a new name saved
    // while the build ran are kept. Review state survives for questions that remain.
    const keepIds = new Set(questions.map((q) => q.id));
    const keptConcepts = finalConcepts.filter((c) => questions.some((q) => q.concept === c.id) || finalConcepts.some((o) => o.prereqs.includes(c.id)));
    const built = { status: /** @type {const} */ ("built"), at: Date.now(), model: llm.cfg.model, rejected: { concepts: rejectedConcepts, questions: rejectedQuestions }, calls: llm.calls };
    Object.assign(
      course,
      updateCourse(course.id, (c) => {
        c.cards = Object.fromEntries(Object.entries(c.cards).filter(([id]) => keepIds.has(id)));
        c.concepts = keptConcepts;
        c.questions = questions;
        c.build = built;
      }),
    );
    progress({ stage: "done", done: 1, total: 1, message: `Ready: ${course.concepts.length} concepts, ${questions.length} questions` });
    return course;
  } catch (e) {
    const failed = { status: /** @type {const} */ ("failed"), at: Date.now(), model: llm.cfg.model, message: /** @type {Error} */ (e).message };
    try {
      Object.assign(course, updateCourse(course.id, (c) => (c.build = failed)));
    } catch {
      /* the course was deleted while building: nothing to record */
    }
    throw e;
  }
}
