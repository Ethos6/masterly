import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockLlm } from "./helpers/mock-llm.js";
import { createCourse, loadCourse, saveCourse, loadPassages, findCourse, deleteCourse, listCourses } from "../src/store.js";
import { addSource, buildCourse, orderConcepts, checkQuestion, conceptKey } from "../src/build.js";
import { Llm, resolveLlm } from "../src/llm.js";
import { nextQuestions, grade, record, hint, ask, stats, conceptStates, MASTERED_DAYS } from "../src/study.js";
import { ankiTsv, studyGuide } from "../src/export.js";

const FIXTURE = fs.readFileSync(new URL("./fixtures/biology.md", import.meta.url));
const DAY = 86_400_000;
let mock;
const NAMES = [["called the cell theory", "Cell theory"], ["plasma membrane", "Membranes"], ["Mitochondria produce", "Respiration"], ["chloroplasts, where", "Photosynthesis"], ["The nucleus stores", "DNA to protein"], ["reproduce by dividing", "Cell division"]];
const conceptName = (p) => NAMES.find(([k]) => p.text.includes(k))?.[1] || "Energy";

before(async () => {
  process.env.MASTERLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "masterly-test-"));
  mock = await startMockLlm({ conceptName });
});
after(() => mock.close());

const llm = () => new Llm({ baseUrl: mock.url, model: "mock" });

async function builtCourse(name = "Biology") {
  const c = createCourse(name);
  await addSource(c, "biology.md", FIXTURE);
  await buildCourse(c, llm());
  return c;
}

test("sources: passages are stored, duplicates are skipped, bad files rejected", async () => {
  const c = createCourse("Sources");
  const r = await addSource(c, "biology.md", FIXTURE);
  assert.equal(r.duplicate, false);
  assert.equal(r.source.title, "How Cells Make and Use Energy");
  assert.ok(r.passages >= 3);
  assert.equal((await addSource(c, "copy.md", FIXTURE)).duplicate, true);
  await assert.rejects(addSource(c, "empty.txt", Buffer.from("   ")), /no text/);
  const ps = loadPassages(c.id);
  assert.deepEqual(ps.map((p) => p.id), ps.map((_, i) => `P${i + 1}`));
  assert.equal(loadCourse(c.id)?.build.status, "ready");
});

test("build: grounded concepts in prerequisite order, invented concepts and bad questions rejected", async () => {
  const c = await builtCourse();
  assert.equal(c.build.status, "built");
  assert.ok(c.concepts.length >= 3);
  assert.ok(!c.concepts.some((x) => x.name === "Invented concept"), "concept with an invented quote is dropped");
  assert.ok((c.build.rejected?.concepts || 0) >= 1);
  // order respects prerequisites
  const pos = new Map(c.concepts.map((x) => [x.id, x.order]));
  for (const x of c.concepts) for (const p of x.prereqs) assert.ok((pos.get(p) ?? 0) < x.order, `${p} before ${x.id}`);
  // every concept and question carries verified evidence that is really in the passages
  const text = new Map(loadPassages(c.id).map((p) => [p.id, p.text]));
  for (const item of [...c.concepts, ...c.questions]) {
    assert.ok(item.evidence.length > 0);
    for (const e of item.evidence) assert.equal(text.get(e.chunk)?.slice(e.start, e.end), e.excerpt);
  }
  assert.ok(!c.questions.some((q) => /invented quote|duplicate options/.test(q.prompt)));
  assert.deepEqual([...new Set(c.questions.map((q) => q.type))].sort(), ["mcq", "short", "tf"]);
});

test("rebuild keeps progress on unchanged questions", async () => {
  const c = await builtCourse("Rebuild");
  const q = c.questions[0];
  record(c, q.id, 3);
  await buildCourse(c, llm());
  const again = /** @type {any} */ (loadCourse(c.id));
  assert.ok(again.cards[q.id], "review state survives");
  assert.equal(again.questions.find((x) => x.prompt === q.prompt)?.id, q.id);
});

test("a failing model marks the build as failed with the reason", async () => {
  const bad = await startMockLlm({ fail: () => ({ status: 401, body: { error: { message: "Invalid API key" } } }) });
  const c = createCourse("Fails");
  await addSource(c, "biology.md", FIXTURE);
  await assert.rejects(buildCourse(c, new Llm({ baseUrl: bad.url, model: "x" })), /401: Invalid API key/);
  assert.equal(loadCourse(c.id)?.build.status, "failed");
  await bad.close();
});

test("model client: JSON mode fallback, prose-wrapped JSON, retry after 429", async () => {
  const noJson = await startMockLlm({ noJsonMode: true, prose: true, conceptName });
  const c = createCourse("Compat");
  await addSource(c, "biology.md", FIXTURE);
  const m = new Llm({ baseUrl: noJson.url, model: "x" });
  await buildCourse(c, m);
  assert.equal(m.jsonMode, false);
  assert.ok(c.questions.length > 0);
  await noJson.close();
  const flaky = await startMockLlm({ fail: (_b, n) => (n === 1 ? { status: 429, body: { error: { message: "slow down" } } } : null) });
  const t0 = Date.now();
  const out = await new Llm({ baseUrl: flaky.url, model: "x" }).json([{ role: "user", content: 'Reply with this JSON object and nothing else: {"ok": true}' }], (v) => v);
  assert.deepEqual(out, { ok: true });
  assert.ok(Date.now() - t0 >= 1500, "waited before retrying");
  await flaky.close();
});

test("model settings resolve from saved settings, then the environment", async () => {
  delete process.env.MASTERLY_BASE_URL;
  assert.equal((await resolveLlm({ baseUrl: "http://x/v1/", model: "m" }, { probe: false }))?.baseUrl, "http://x/v1");
  process.env.MASTERLY_BASE_URL = "http://env/v1/chat/completions";
  process.env.MASTERLY_MODEL = "envm";
  const r = await resolveLlm({}, { probe: false });
  assert.deepEqual([r?.baseUrl, r?.model, r?.source], ["http://env/v1", "envm", "environment variables"]);
  delete process.env.MASTERLY_BASE_URL;
  delete process.env.MASTERLY_MODEL;
  assert.equal(await resolveLlm({}, { probe: false }), null);
});

test("concept ordering breaks cycles and keeps material order for ties", () => {
  const { order, dropped } = orderConcepts([
    { id: "C1", first: 0, prereqs: ["C3"] },
    { id: "C2", first: 1, prereqs: ["C1"] },
    { id: "C3", first: 2, prereqs: ["C2"] },
    { id: "C4", first: 3, prereqs: ["C4", "C9"] },
  ]);
  assert.equal(order.length, 4);
  assert.equal(dropped.length, 1);
  const pos = (id) => order.indexOf(id);
  assert.ok(pos("C1") < pos("C2") && pos("C2") < pos("C3"));
  assert.equal(conceptKey("The Mitochondria!"), conceptKey("mitochondrias"));
});

test("question validation", () => {
  const ps = new Map([["P1", { text: "Ribosomes read the RNA code three letters at a time and assemble amino acids into a chain." }]]);
  const ev = [{ passage: "P1", quote: "Ribosomes read the RNA code three letters at a time" }];
  assert.equal(checkQuestion({ type: "mcq", prompt: "What do ribosomes read?", options: ["A. RNA", "B. DNA", "C. lipids", "D. ATP"], answer: "A", explanation: "x", evidence: ev }, ps).ok, true);
  assert.equal(/** @type {any} */ (checkQuestion({ type: "mcq", prompt: "What do ribosomes read?", options: ["RNA", "DNA", "lipids", "ATP"], answer: "rna", evidence: ev }, ps)).q.answer, 0);
  assert.match(/** @type {any} */ (checkQuestion({ type: "mcq", prompt: "What do ribosomes read?", options: ["RNA", "DNA"], answer: 0, evidence: ev }, ps)).reason, /3 to 5/);
  assert.match(/** @type {any} */ (checkQuestion({ type: "mcq", prompt: "What do ribosomes read?", options: ["RNA", "DNA", "x", "y"], answer: 7, evidence: ev }, ps)).reason, /index/);
  assert.equal(/** @type {any} */ (checkQuestion({ type: "true_false", prompt: "Ribosomes read RNA.", answer: "True", evidence: ev }, ps)).q.answer, true);
  assert.match(/** @type {any} */ (checkQuestion({ type: "tf", prompt: "Ribosomes read RNA.", answer: "maybe", evidence: ev }, ps)).reason, /boolean/);
  const short = /** @type {any} */ (checkQuestion({ type: "short", prompt: "How do ribosomes read RNA?", answer: "Three letters at a time.", evidence: ev }, ps));
  assert.deepEqual(short.q.keyPoints, ["Three letters at a time."]);
  assert.match(/** @type {any} */ (checkQuestion({ type: "short", prompt: "How do ribosomes read RNA?", answer: "x y", evidence: [{ passage: "P1", quote: "ribosomes read DNA backwards very slowly" }] }, ps)).reason, /no verifiable evidence/);
  assert.match(/** @type {any} */ (checkQuestion({ type: "essay", prompt: "Write an essay", evidence: ev }, ps)).reason, /unknown/);
});

test("mastery gating: later concepts unlock only when earlier ones are passed", async () => {
  const c = await builtCourse("Gating");
  const states = conceptStates(c);
  const first = c.concepts[0];
  const withPrereq = c.concepts.find((x) => x.prereqs.includes(first.id));
  assert.ok(withPrereq, "the mock gives every later concept a prerequisite");
  assert.equal(states.get(first.id)?.status, "ready");
  assert.equal(states.get(withPrereq.id)?.status, "locked");
  const n = nextQuestions(c);
  assert.ok(n.queue.every((id) => c.questions.find((q) => q.id === id)?.concept === first.id), "only unlocked questions are offered");
  assert.ok(n.locked > 0);
  for (const q of c.questions.filter((x) => x.concept === first.id)) record(c, q.id, 3);
  assert.equal(conceptStates(c).get(first.id)?.status, "passed", "answered once is passed, not mastered");
  assert.notEqual(conceptStates(c).get(withPrereq.id)?.status, "locked");
  // a wrong answer at the last review un-passes the concept
  record(c, c.questions.find((x) => x.concept === first.id)?.id || "", 1);
  assert.equal(conceptStates(c).get(first.id)?.status, "learning");
});

test("mastered needs retention over time, and due reviews come back first", async () => {
  const c = await builtCourse("Mastery");
  const first = c.concepts[0];
  const qs = c.questions.filter((x) => x.concept === first.id);
  let t = Date.UTC(2026, 0, 1, 9);
  for (let round = 0; round < 6; round++) {
    for (const q of qs) record(c, q.id, 3, {}, t);
    t = Math.max(...qs.map((q) => c.cards[q.id].due));
  }
  assert.ok(qs.every((q) => c.cards[q.id].stability >= MASTERED_DAYS));
  const atReview = Math.min(...qs.map((q) => c.cards[q.id].due));
  assert.equal(conceptStates(c, atReview - DAY).get(first.id)?.status, "mastered");
  const due = nextQuestions(c, {}, atReview + 1);
  assert.ok(due.due >= 1);
  assert.equal(c.questions.find((q) => q.id === due.queue[0])?.concept, first.id, "due reviews before new questions");
});

test("new questions per day are limited", async () => {
  const c = await builtCourse("Limits");
  c.settings.newPerDay = 2;
  saveCourse(c);
  const n = nextQuestions(c);
  assert.equal(n.fresh, 2);
  record(c, n.queue[0], 3);
  assert.equal(nextQuestions(c).fresh, 1);
});

test("grading: code grades choice questions, the model grades short answers", async () => {
  const c = await builtCourse("Grading");
  const mcq = c.questions.find((q) => q.type === "mcq");
  const tf = c.questions.find((q) => q.type === "tf");
  const sh = c.questions.find((q) => q.type === "short");
  const right = await grade(c, mcq.id, mcq.answer, null);
  assert.deepEqual([right.correct, right.suggested], [true, 3]);
  const wrong = await grade(c, mcq.id, "D", null);
  assert.deepEqual([wrong.correct, wrong.suggested], [false, 1]);
  assert.ok(wrong.intervals[3] > wrong.intervals[1]);
  await assert.rejects(grade(c, mcq.id, 9, null), /choose/);
  assert.equal((await grade(c, tf.id, "true", null)).correct, tf.answer === true);
  await assert.rejects(grade(c, tf.id, "perhaps", null), /true or false/);
  const good = await grade(c, sh.id, String(sh.answer), llm());
  assert.equal(good.correct, true);
  assert.ok(good.score > 0.5);
  const bad = await grade(c, sh.id, "I have no idea at all", llm());
  assert.equal(bad.correct, false);
  assert.equal(bad.suggested, 1);
  const self = await grade(c, sh.id, "my answer", null);
  assert.equal(self.selfGrade, true);
  await assert.rejects(grade(c, sh.id, "   ", llm()), /write an answer/);
  assert.ok(right.reveal.evidence.length > 0);
});

test("hints never give the answer away", async () => {
  const c = await builtCourse("Hints");
  const mcq = c.questions.find((q) => q.type === "mcq");
  assert.match(await hint(c, mcq.id, llm()), /Think about/);
  const leaky = await startMockLlm({ leakyHint: true, conceptName });
  const h = await hint(c, mcq.id, new Llm({ baseUrl: leaky.url, model: "x" }));
  assert.match(h, /^Look again at/);
  await leaky.close();
});

test("ask: answers cite verified quotes; unverifiable citations and markers are dropped", async () => {
  const c = await builtCourse("Ask");
  const a = await ask(c, "What do mitochondria produce?", llm());
  assert.equal(a.found, true);
  assert.equal(a.citations.length, 1);
  assert.equal(a.unverified, 1);
  assert.ok(!a.answer.includes("[P999]"), "a marker without a verified quote is removed");
  assert.equal(a.citations[0].where, "How Cells Make and Use Energy");
  const none = await ask(c, "zebra quantum unanswerable", llm());
  assert.equal(none.found, false);
});

test("stats, exports and course lookup", async () => {
  const c = await builtCourse("Exports & Stats");
  record(c, c.questions[0].id, 3);
  const s = stats(c);
  assert.equal(s.reviews, 1);
  assert.equal(s.forecast.reduce((a, b) => a + b, 0), 1);
  assert.equal(s.streak, 1);
  const tsv = ankiTsv(c);
  assert.equal(tsv.split("\n").filter((l) => l && !l.startsWith("#")).length, c.questions.length);
  assert.ok(tsv.split("\n").slice(3).every((l) => !l || l.split("\t").length === 3));
  const guide = studyGuide(c);
  assert.match(guide, /^# Exports & Stats/);
  assert.ok(c.concepts.every((x) => guide.includes(x.name)));
  assert.equal(findCourse("exports & stats")?.id, c.id);
  assert.equal(findCourse(c.id.slice(0, 8))?.id, c.id);
  assert.throws(() => loadCourse("../../etc"), /invalid course id/);
  deleteCourse(c.id);
  assert.ok(!listCourses().some((x) => x.id === c.id));
});

test("course files are written atomically and readable after many saves", async () => {
  const c = createCourse("Atomic");
  for (let i = 0; i < 50; i++) {
    c.name = `Atomic ${i}`;
    saveCourse(c);
  }
  assert.equal(loadCourse(c.id)?.name, "Atomic 49");
  const dir = path.join(/** @type {string} */ (process.env.MASTERLY_HOME), "courses", c.id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["course.json", "passages.json"]);
});

test("a rebuild never overwrites reviews, settings or renames saved while it runs", async () => {
  const slow = await startMockLlm({ conceptName, fail: () => null });
  const c = await builtCourse("Concurrent");
  const q = c.questions[0];
  // start a rebuild against a slow model, then study and edit while it runs
  const origFetch = globalThis.fetch;
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.fetch = async (...a) => {
    await gate;
    return origFetch(...a);
  };
  const building = buildCourse(loadCourse(c.id), new Llm({ baseUrl: slow.url, model: "slow" }));
  await new Promise((r) => setTimeout(r, 50));
  record(loadCourse(c.id), q.id, 3);
  const edited = loadCourse(c.id);
  edited.settings.newPerDay = 7;
  edited.name = "Renamed";
  saveCourse(edited);
  release();
  await building;
  globalThis.fetch = origFetch;
  const after = loadCourse(c.id);
  assert.equal(after.build.status, "built");
  assert.equal(after.log.length, 1, "the review made during the build is kept");
  assert.ok(after.cards[q.id]);
  assert.equal(after.settings.newPerDay, 7);
  assert.equal(after.name, "Renamed");
  await slow.close();
});

test("a course deleted during a build stays deleted", async () => {
  const c = await builtCourse("Deleted");
  const origFetch = globalThis.fetch;
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.fetch = async (...a) => {
    await gate;
    return origFetch(...a);
  };
  const building = buildCourse(loadCourse(c.id), llm());
  await new Promise((r) => setTimeout(r, 50));
  deleteCourse(c.id);
  release();
  await building.catch(() => {});
  globalThis.fetch = origFetch;
  assert.equal(loadCourse(c.id), null);
  assert.ok(!listCourses().some((x) => x.id === c.id));
});

test("rebuilt questions never share an id", async () => {
  const c = await builtCourse("Ids");
  await buildCourse(c, llm());
  const ids = c.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
});
