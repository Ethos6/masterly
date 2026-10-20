// @ts-check
import { Scheduler, newCard } from "./fsrs.js";
import { normalize, verifyEvidence } from "./ground.js";
import { gradePrompt, hintPrompt, askPrompt, formatPassages } from "./prompts.js";
import { loadPassages, updateCourse } from "./store.js";
import { Index } from "./search.js";
import { placeOf } from "./chunk.js";

/**
 * Studying: which questions to ask now, how answers are graded, what the learner
 * has mastered.
 *
 * Mastery gating: new questions only come from concepts whose prerequisites the
 * learner has passed (every question answered correctly at its last review).
 * Spaced review: answered questions return when FSRS predicts recall has dropped to
 * the target retention (90% by default).
 */

const DAY = 86_400_000;
export const MASTERED_DAYS = 10;

/** @param {import("./store.js").Course} course */
export function scheduler(course) {
  return new Scheduler({ retention: course.settings.retention });
}

/**
 * @typedef {"locked"|"ready"|"learning"|"passed"|"mastered"} ConceptStatus
 * @typedef {{id: string, name: string, status: ConceptStatus, mastery: number, questions: number, answered: number, due: number, prereqs: string[], blockedBy: string[]}} ConceptState
 */

/**
 * @param {import("./store.js").Course} course
 * @returns {Map<string, ConceptState>}
 */
export function conceptStates(course, now = Date.now()) {
  const sch = scheduler(course);
  const last = lastReviews(course);
  /** @type {Map<string, ConceptState>} */
  const out = new Map();
  for (const c of [...course.concepts].sort((a, b) => a.order - b.order)) {
    const qs = course.questions.filter((q) => q.concept === c.id);
    let answered = 0;
    let correctNow = 0;
    let rSum = 0;
    let due = 0;
    let minStability = Infinity;
    for (const q of qs) {
      const card = course.cards[q.id];
      if (!card || card.state === "new") continue;
      answered++;
      minStability = Math.min(minStability, card.stability);
      const lastOk = (last.get(q.id)?.rating ?? 1) >= 2;
      if (lastOk) {
        correctNow++;
        rSum += sch.recallNow(card, now);
      }
      if (card.due <= now) due++;
    }
    const passed = qs.length === 0 || (answered === qs.length && correctNow === qs.length);
    const mastery = qs.length ? rSum / qs.length : 1;
    const blockedBy = c.prereqs.filter((p) => {
      const s = out.get(p);
      return s && s.status !== "passed" && s.status !== "mastered";
    });
    /** @type {ConceptStatus} */
    let status;
    // Mastered = retained, not just answered once: every question's memory stability is at
    // least MASTERED_DAYS and recall is still likely today.
    if (passed && qs.length > 0 && minStability >= MASTERED_DAYS && mastery >= 0.85) status = "mastered";
    else if (passed) status = "passed";
    else if (answered > 0) status = "learning";
    else status = blockedBy.length ? "locked" : "ready";
    out.set(c.id, { id: c.id, name: c.name, status, mastery, questions: qs.length, answered, due, prereqs: c.prereqs, blockedBy });
  }
  return out;
}

/** @param {import("./store.js").Course} course @returns {Map<string, import("./store.js").Review>} */
function lastReviews(course) {
  const m = new Map();
  for (const r of course.log) m.set(r.q, r);
  return m;
}

/** How many new questions were introduced today (UTC day). @param {import("./store.js").Course} course */
function newToday(course, now = Date.now()) {
  const start = Math.floor(now / DAY) * DAY;
  const seen = new Set();
  let n = 0;
  for (const r of course.log) {
    if (seen.has(r.q)) continue;
    seen.add(r.q);
    if (r.at >= start) n++;
  }
  return n;
}

/**
 * The questions to study now: due reviews first (most overdue first), then new
 * questions from unlocked concepts in course order, up to the daily new limit.
 * @param {import("./store.js").Course} course
 * @param {{limit?: number, concept?: string}} [opts]
 * @returns {{queue: string[], due: number, fresh: number, locked: number}}
 */
export function nextQuestions(course, opts = {}, now = Date.now()) {
  const states = conceptStates(course, now);
  const limit = opts.limit ?? 20;
  const inScope = (/** @type {import("./store.js").Question} */ q) => !opts.concept || q.concept === opts.concept;
  const due = course.questions
    .filter((q) => inScope(q) && course.cards[q.id] && course.cards[q.id].state !== "new" && course.cards[q.id].due <= now)
    .sort((a, b) => course.cards[a.id].due - course.cards[b.id].due)
    .map((q) => q.id);
  const allowNew = Math.max(0, course.settings.newPerDay - newToday(course, now));
  const order = new Map(course.concepts.map((c) => [c.id, c.order]));
  const unseen = course.questions.filter((q) => inScope(q) && (!course.cards[q.id] || course.cards[q.id].state === "new"));
  const fresh = unseen
    .filter((q) => {
      const s = states.get(q.concept);
      return s && s.status !== "locked";
    })
    .sort((a, b) => (order.get(a.concept) ?? 0) - (order.get(b.concept) ?? 0) || Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .slice(0, allowNew)
    .map((q) => q.id);
  const locked = unseen.length - unseen.filter((q) => states.get(q.concept)?.status !== "locked").length;
  return { queue: [...due, ...fresh].slice(0, limit), due: due.length, fresh: fresh.length, locked };
}

/** The question as shown to the learner: no answer, no explanation. @param {import("./store.js").Question} q */
export function publicQuestion(q) {
  return { id: q.id, concept: q.concept, type: q.type, prompt: q.prompt, options: q.options };
}

/**
 * Grade an answer. Multiple choice and true/false are graded by code; short answers
 * by the model against the key points (or by the learner, with no model).
 * @param {import("./store.js").Course} course
 * @param {string} questionId
 * @param {any} answer
 * @param {import("./llm.js").Llm | null} llm
 */
export async function grade(course, questionId, answer, llm) {
  const q = course.questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`unknown question ${questionId}`);
  /** @type {{correct: boolean, score: number, suggested: 1|2|3|4, feedback: string, covered?: number[], missing?: number[], misconception?: string, selfGrade?: boolean}} */
  let result;
  if (q.type === "mcq") {
    const pick = typeof answer === "string" && /^[A-Ea-e]$/.test(answer) ? answer.toUpperCase().charCodeAt(0) - 65 : Number(answer);
    if (!Number.isInteger(pick) || pick < 0 || pick >= (q.options || []).length) throw new Error("choose one of the options");
    const correct = pick === q.answer;
    result = { correct, score: correct ? 1 : 0, suggested: correct ? 3 : 1, feedback: correct ? "Correct." : `Not quite. The answer is ${String.fromCharCode(65 + Number(q.answer))}: ${(q.options || [])[Number(q.answer)]}` };
  } else if (q.type === "tf") {
    const pick = answer === true || answer === "true" ? true : answer === false || answer === "false" ? false : null;
    if (pick === null) throw new Error("answer true or false");
    const correct = pick === q.answer;
    result = { correct, score: correct ? 1 : 0, suggested: correct ? 3 : 1, feedback: correct ? "Correct." : `Not quite: the statement is ${q.answer ? "true" : "false"}.` };
  } else {
    const text = String(answer ?? "").trim();
    if (!text) throw new Error("write an answer first");
    if (!llm) {
      result = { correct: false, score: 0, suggested: 3, feedback: "Compare your answer with the model answer and rate yourself.", selfGrade: true };
    } else {
      const g = await llm.json(gradePrompt(q, text, course.language), (v) => {
        const score = Number(v?.score);
        if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('"score" must be a number between 0 and 1');
        if (typeof v.feedback !== "string" || !v.feedback.trim()) throw new Error('"feedback" is required');
        return v;
      });
      const score = Math.round(Number(g.score) * 100) / 100;
      const n = (q.keyPoints || []).length;
      const idx = (/** @type {any} */ a) => (Array.isArray(a) ? a.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n) : []);
      result = {
        correct: score >= 0.6,
        score,
        suggested: score >= 0.85 ? 3 : score >= 0.6 ? 2 : 1,
        feedback: String(g.feedback).trim(),
        covered: idx(g.covered),
        missing: idx(g.missing),
        misconception: typeof g.misconception === "string" ? g.misconception.trim() : "",
      };
    }
  }
  const sch = scheduler(course);
  const card = course.cards[q.id] || newCard();
  const preview = sch.preview(card);
  return { ...result, reveal: { answer: q.answer, options: q.options, keyPoints: q.keyPoints, explanation: q.explanation, evidence: q.evidence }, intervals: preview };
}

/**
 * Record the learner's rating (they may accept the suggested one or change it).
 * @param {import("./store.js").Course} course
 * @param {string} questionId
 * @param {1|2|3|4} rating
 * @param {{score?: number, answer?: string}} [extra]
 */
export function record(course, questionId, rating, extra = {}, now = Date.now()) {
  const q = course.questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`unknown question ${questionId}`);
  if (![1, 2, 3, 4].includes(rating)) throw new Error("rating must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
  /** @type {import("./fsrs.js").Card | undefined} */
  let card;
  const fresh = updateCourse(course.id, (c) => {
    if (!c.questions.some((x) => x.id === q.id)) throw new Error(`question ${q.id} no longer exists (the course was rebuilt)`);
    card = scheduler(c).review(c.cards[q.id] || newCard(now), rating, now);
    c.cards[q.id] = card;
    c.log.push({ q: q.id, c: q.concept, at: now, rating, score: extra.score ?? (rating >= 2 ? 1 : 0), ...(extra.answer ? { answer: String(extra.answer).slice(0, 2000) } : {}) });
    if (c.log.length > 50_000) c.log = c.log.slice(-50_000);
  });
  Object.assign(course, fresh);
  return /** @type {import("./fsrs.js").Card} */ (card);
}

/**
 * A Socratic hint that must not give the answer away.
 * @param {import("./store.js").Course} course @param {string} questionId @param {import("./llm.js").Llm} llm
 */
export async function hint(course, questionId, llm) {
  const q = course.questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`unknown question ${questionId}`);
  const passages = loadPassages(course.id).filter((p) => q.evidence.some((e) => e.chunk === p.id));
  const h = await llm.json(hintPrompt(q, formatPassages(passages)), (v) => {
    if (typeof v?.hint !== "string" || !v.hint.trim()) throw new Error('"hint" is required');
    return v.hint.trim();
  });
  const leaks =
    (q.type === "mcq" && normalize(h).includes(normalize(String((q.options || [])[Number(q.answer)] || "")))) ||
    (q.type === "tf" && /\b(true|false)\b/i.test(h)) ||
    (q.type === "short" && normalize(String(q.answer)).length > 12 && normalize(h).includes(normalize(String(q.answer))));
  const where = passages[0]?.label || "the material";
  return leaks ? `Look again at ${where}: what does it say about ${course.concepts.find((c) => c.id === q.concept)?.name || "this idea"}?` : h;
}

/**
 * Answer a question from the course material, with verified citations.
 * @param {import("./store.js").Course} course @param {string} question @param {import("./llm.js").Llm} llm
 */
export async function ask(course, question, llm) {
  const passages = loadPassages(course.id);
  if (!passages.length) throw new Error("this course has no material yet");
  const hits = new Index(passages).search(question, 6);
  if (!hits.length) return { found: false, answer: "Nothing in this course's material matches that question.", citations: [], unverified: 0 };
  const byId = new Map(passages.map((p) => [p.id, p]));
  const shown = new Map(hits.map((h) => [h.id, /** @type {any} */ (byId.get(h.id))]));
  const titles = new Map(course.sources.map((s) => [s.id, s.title]));
  const reply = await llm.json(askPrompt(question, formatPassages([...shown.values()], titles), course.language), (v) => {
    if (typeof v?.answer !== "string") throw new Error('"answer" is required');
    return v;
  });
  const { verified, rejected } = verifyEvidence(reply.citations, shown);
  const found = reply.found !== false && verified.length > 0;
  const citations = verified.map((e) => {
    const p = /** @type {any} */ (byId.get(e.chunk));
    return { ...e, source: titles.get(p.source) || p.source, label: p.label, where: placeOf(titles.get(p.source) || p.source, p.label) };
  });
  // a [P7] marker is only kept if P7 has a verified citation
  const ok = new Set(verified.map((v) => v.chunk));
  const answer = String(reply.answer).replace(/\[(P\d+)\]/g, (m, id) => (ok.has(id) ? m : ""));
  return { found, answer: found ? answer : reply.found === false ? answer : `${answer}\n\n(No supporting quote could be verified in your material, so treat this answer with care.)`, citations, unverified: rejected.length };
}

/** @param {import("./store.js").Course} course */
export function stats(course, now = Date.now()) {
  const states = [...conceptStates(course, now).values()];
  const today = Math.floor(now / DAY);
  /** @type {number[]} */
  const forecast = Array.from({ length: 14 }, () => 0);
  for (const card of Object.values(course.cards)) {
    if (card.state === "new") continue;
    const d = Math.max(0, Math.floor(card.due / DAY) - today);
    if (d < 14) forecast[d]++;
  }
  /** @type {Record<string, {reviews: number, correct: number}>} */
  const byDay = {};
  for (const r of course.log) {
    const day = new Date(Math.floor(r.at / DAY) * DAY).toISOString().slice(0, 10);
    const d = (byDay[day] ||= { reviews: 0, correct: 0 });
    d.reviews++;
    if (r.rating >= 2) d.correct++;
  }
  let streak = 0;
  for (let d = today; ; d--) {
    const key = new Date(d * DAY).toISOString().slice(0, 10);
    if (byDay[key]) streak++;
    else if (d !== today) break;
    if (streak > 3650) break;
  }
  const recent = course.log.slice(-200);
  return {
    concepts: course.concepts.length,
    questions: course.questions.length,
    mastered: states.filter((s) => s.status === "mastered").length,
    passed: states.filter((s) => s.status === "passed" || s.status === "mastered").length,
    learning: states.filter((s) => s.status === "learning").length,
    locked: states.filter((s) => s.status === "locked").length,
    dueNow: nextQuestions(course, { limit: 1e6 }, now).due,
    forecast,
    reviews: course.log.length,
    accuracy: recent.length ? recent.filter((r) => r.rating >= 2).length / recent.length : null,
    streak,
    byDay,
    overall: states.length ? states.reduce((s, x) => s + x.mastery, 0) / states.length : 0,
  };
}
