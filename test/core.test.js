import { test } from "node:test";
import assert from "node:assert/strict";
import { fsrs, generatorParameters, createEmptyCard } from "ts-fsrs";
import { Scheduler, newCard, DEFAULT_W } from "../src/fsrs.js";
import { findQuote, verifyEvidence, normalize } from "../src/ground.js";
import { extract, readZip, htmlToText, markdownToText } from "../src/extract.js";
import { chunk } from "../src/chunk.js";
import { Index, tokenize } from "../src/search.js";
import { parseJsonReply } from "../src/llm.js";
import { docx, epub, pdf, zip } from "./helpers/files.js";

const DAY = 86_400_000;

// ------------------------------------------------------------------ FSRS

test("FSRS-6 matches the reference implementation (ts-fsrs) over 3,000 random reviews", () => {
  const ref = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));
  const ours = new Scheduler();
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let n = 0;
  for (let run = 0; run < 300; run++) {
    let t = Date.UTC(2026, 0, 1, 9);
    let a = createEmptyCard(new Date(t));
    let b = newCard(t);
    for (let i = 0; i < 10; i++) {
      const g = /** @type {1|2|3|4} */ (1 + Math.floor(rnd() * 4));
      const ra = ref.next(a, new Date(t), g).card;
      const rb = ours.review(b, g, t);
      assert.ok(Math.abs(ra.stability - rb.stability) / ra.stability < 1e-6, `stability run ${run} step ${i}: ${ra.stability} vs ${rb.stability}`);
      assert.ok(Math.abs(ra.difficulty - rb.difficulty) < 1e-6, `difficulty run ${run} step ${i}`);
      if (g > 1) assert.equal(Math.round((rb.due - t) / DAY), ra.scheduled_days, `interval run ${run} step ${i}`);
      a = ra;
      b = rb;
      t += Math.max(1, Math.round(((rb.due - t) / DAY) * (0.4 + rnd()))) * DAY;
      n++;
    }
  }
  assert.equal(n, 3000);
});

test("FSRS basics: retention at S days, forgetting, same-day reviews, validation", () => {
  const s = new Scheduler();
  assert.ok(Math.abs(s.retrievability(10, 10) - 0.9) < 1e-9, "recall is 90% after S days");
  assert.equal(s.interval(10), 10, "at 90% retention the interval equals stability");
  const t = Date.UTC(2026, 2, 1, 10);
  const first = s.review(newCard(t), 3, t);
  assert.equal(first.reps, 1);
  assert.equal(first.lapses, 0);
  assert.equal(first.stability, DEFAULT_W[2]);
  const again = s.review(first, 1, t + 5 * DAY);
  assert.equal(again.due, t + 5 * DAY + 10 * 60_000, "forgotten cards come back in 10 minutes");
  assert.equal(again.lapses, 1);
  assert.ok(again.stability < first.stability);
  const sameDay = s.review(first, 3, t + 3600_000);
  assert.ok(sameDay.stability >= first.stability, "a same-day Good never lowers stability");
  const good = s.review(first, 3, t + 3 * DAY);
  const easy = s.review(first, 4, t + 3 * DAY);
  assert.ok(easy.stability > good.stability && easy.difficulty < good.difficulty);
  assert.throws(() => s.review(first, /** @type {any} */ (5)), /rating/);
  assert.throws(() => new Scheduler({ retention: 1 }), /retention/);
  const strict = new Scheduler({ retention: 0.95 });
  assert.ok(strict.interval(10) < s.interval(10), "higher retention means shorter intervals");
  const p = s.preview(first, t + 3 * DAY);
  assert.ok(p[1] < p[2] && p[2] <= p[3] && p[3] < p[4]);
});

// ------------------------------------------------------------------ grounding

const TEXT = "Mitochondria produce most of the cell’s usable energy — ATP — through **cellular respiration**.\n\nCellular respiration uses glucose and oxygen, releasing carbon dioxide and water.";

test("quotes match despite case, whitespace, curly quotes, dashes and Markdown emphasis", () => {
  const m = findQuote(`"mitochondria produce most of the cell's usable energy - ATP - through cellular respiration"`, TEXT);
  assert.equal(m.ok, true);
  assert.equal(/** @type {any} */ (m).excerpt, "Mitochondria produce most of the cell’s usable energy — ATP — through **cellular respiration**.");
  assert.equal(findQuote("Cellular   respiration uses\nglucose and oxygen", TEXT).ok, true);
});

test("ellipses allow skipping words, but pieces must appear in order", () => {
  assert.equal(findQuote("Cellular respiration uses glucose ... releasing carbon dioxide and water", TEXT).ok, true);
  assert.equal(findQuote("releasing carbon dioxide and water … Cellular respiration uses glucose", TEXT).ok, false);
});

test("paraphrases, invented text and trivial quotes are rejected", () => {
  assert.equal(findQuote("Mitochondria make most of the cell's energy", TEXT).ok, false);
  assert.equal(findQuote("Mitochondria produce all of the cell's energy as ATP", TEXT).ok, false);
  const short = findQuote("the cell", TEXT);
  assert.equal(short.ok, false);
  assert.match(/** @type {any} */ (short).reason, /too short/);
  assert.equal(findQuote(/** @type {any} */ (undefined), TEXT).ok, false);
});

test("combining accents match precomposed letters, both ways", () => {
  const decomposed = "Le cafe\u0301 du coin est ouvert tous les jours.";
  const m = findQuote("Le café du coin est ouvert", decomposed);
  assert.equal(m.ok, true);
  assert.equal(/** @type {any} */ (m).excerpt, "Le cafe\u0301 du coin est ouvert");
  assert.equal(findQuote("Le cafe\u0301 du coin est ouvert", "Le café du coin est ouvert tous les jours.").ok, true);
});

test("non-Latin scripts and accents", () => {
  assert.equal(findQuote("la célula es la unidad básica de la vida", "Recuerda: La célula es la unidad básica de la vida y todo lo demás.").ok, true);
  assert.equal(findQuote("Клетка является основной единицей жизни", "Клетка является основной единицей жизни.").ok, true);
  assert.equal(normalize("ﬁ Ａ"), "fi a", "compatibility forms are folded");
});

test("verifyEvidence keeps good quotes, relocates mislabelled ones and explains rejections", () => {
  const passages = new Map([
    ["P1", { text: "Plants use light energy to make glucose in their chloroplasts every day." }],
    ["P2", { text: TEXT }],
  ]);
  const { verified, rejected } = verifyEvidence(
    [
      { passage: "P1", quote: "Plants use light energy to make glucose" },
      { passage: "P1", quote: "Cellular respiration uses glucose and oxygen" },
      { passage: "P1", quote: "Plants use light energy to make glucose" },
      { passage: "P2", quote: "Photosynthesis happens in the mitochondria" },
      "",
    ],
    passages,
  );
  assert.deepEqual(verified.map((v) => v.chunk), ["P1", "P2"], "relocated to P2 and deduplicated");
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /does not appear/);
  assert.equal(verifyEvidence(null, passages).verified.length, 0);
});

// ------------------------------------------------------------------ extraction

test("Markdown, text and HTML extraction", async () => {
  const md = await extract("notes.md", Buffer.from("---\ntags: x\n---\n# Cells\n\nThe **cell** is [the unit](http://x) of `life`.\n\n![diagram](d.png)\n"));
  assert.equal(md.title, "Cells");
  assert.equal(md.sections[0].text, "Cells\n\nThe cell is the unit of life.\n\ndiagram");
  const txt = await extract("a.TXT", Buffer.from("﻿line one\r\nline   two\r\n\r\n\r\n\r\nnext"));
  assert.equal(txt.sections[0].text, "line one\nline two\n\nnext");
  const html = await extract("page.html", Buffer.from("<html><head><title>T &amp; U</title><style>x{}</style></head><body><nav>menu</nav><h1>Head</h1><p>One &mdash; two&nbsp;three &#233;</p><script>evil()</script><ul><li>a</li><li>b</li></ul></body></html>"));
  assert.equal(html.title, "T & U");
  assert.equal(html.sections[0].text, "Head\n\nOne — two three é\n\n- a\n- b");
  assert.equal(htmlToText("<p>x</p><!-- c --><p>y</p>"), "x\n\ny");
  assert.equal(markdownToText("## Two ##\n\ntext"), "Two\n\ntext");
  await assert.rejects(extract("x.xyz", Buffer.from("a")), /unsupported/);
});

test("DOCX extraction (deflated zip), with title from document properties", async () => {
  const d = await extract("lecture.docx", docx(["First paragraph about ATP.", "Second & last <paragraph>."], "Lecture 4"));
  assert.equal(d.title, "Lecture 4");
  assert.equal(d.type, "docx");
  assert.equal(d.sections[0].text, "First paragraph about ATP.\n\nSecond & last <paragraph>.");
});

test("EPUB extraction keeps chapters, drops scripts and styles, handles encoded paths", async () => {
  const e = await extract("book.epub", epub("Biology Book", [{ title: "Cells", paragraphs: ["Cells are small."] }, { title: "Energy", paragraphs: ["ATP stores energy.", "Second."] }]));
  assert.equal(e.title, "Biology Book");
  assert.deepEqual(e.sections.map((s) => s.label), ["chapter 1: Cells", "chapter 2: Energy"]);
  assert.equal(e.sections[1].text, "Energy\n\nATP stores energy.\n\nSecond.");
});

test("PDF extraction: one section per page, metadata title, empty PDFs explained", async () => {
  const p = await extract("paper.pdf", pdf([["Photosynthesis converts light energy into chemical energy.", "It happens in chloroplasts."], ["Respiration releases energy from glucose."]], "Energy Paper"));
  assert.equal(p.title, "Energy Paper");
  assert.deepEqual(p.sections.map((s) => s.label), ["page 1", "page 2"]);
  assert.match(p.sections[0].text, /Photosynthesis converts light energy into chemical energy\.\s+It happens in chloroplasts\./);
  assert.equal(p.sections[1].page, 2);
  await assert.rejects(extract("blank.pdf", pdf([[]])), /no extractable text/);
});

test("EPUB spine repeats and oversized text are refused, not multiplied", async () => {
  const big = "<p>" + "word ".repeat(1_000_000) + "</p>";
  const files = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    "c.opf": `<package><manifest><item id="a" href="a.xhtml"/></manifest><spine>${'<itemref idref="a"/>'.repeat(50)}</spine></package>`,
    "a.xhtml": `<html><body>${big}</body></html>`,
  };
  const e = await extract("bomb.epub", zip(files));
  assert.equal(e.sections.length, 1, "each chapter is read once");
  const huge = { ...files, "a.xhtml": `<html><body><p>${"word ".repeat(4_500_000)}</p></body></html>`, "c.opf": '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>', "b.xhtml": `<html><body><p>${"more ".repeat(1_000_000)}</p></body></html>` };
  await assert.rejects(extract("huge.epub", zip(huge)), /20 million characters/);
});

test("zip reader: stored entries, and clear errors for broken files", () => {
  const z = readZip(zip({ "a.txt": "hello" }, { deflate: false }));
  assert.equal(z.get("a.txt")?.().toString(), "hello");
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /not a zip/);
});

// ------------------------------------------------------------------ chunking & search

test("chunking respects sections, packs paragraphs and splits long ones on sentences", () => {
  let n = 0;
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const ps = chunk([{ text: `Short one.\n\nShort two.\n\n${long}`, label: "page 1" }, { text: "Other page.", label: "page 2" }], "S1", () => `P${++n}`);
  assert.ok(ps.length >= 3);
  assert.ok(ps.every((p) => p.text.length <= 2000));
  assert.equal(ps.at(-1)?.label, "page 2", "never crosses a page");
  assert.equal(ps[0].text.startsWith("Short one.\n\nShort two."), true);
  assert.ok(ps.map((p) => p.text).join(" ").includes("Sentence number 59 is here."), "nothing is lost");
});

test("BM25 search finds the right passage with light stemming", () => {
  const idx = new Index([
    { id: "P1", text: "Mitochondria produce ATP through cellular respiration." },
    { id: "P2", text: "Chloroplasts carry out photosynthesis using light." },
    { id: "P3", text: "The nucleus stores DNA." },
  ]);
  assert.equal(idx.search("how is photosynthesis powered by lights?")[0].id, "P2");
  assert.equal(idx.search("what do mitochondria produce during respiration")[0]?.id, "P1");
  assert.deepEqual(idx.search("zebra"), []);
  assert.deepEqual(tokenize("The Cells are dividing"), ["cell", "divid"]);
});

// ------------------------------------------------------------------ JSON replies

test("JSON is recovered from fences, prose, think blocks and trailing commas", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure!\n```json\n{"a": [1,2]}\n```\nDone.'), { a: [1, 2] });
  assert.deepEqual(parseJsonReply('<think>{"no":1}</think>Here: {"a": "x}y", "b": {"c": 2},} trailing'), { a: "x}y", b: { c: 2 } });
  assert.throws(() => parseJsonReply("no json here"), /did not return JSON/);
});
