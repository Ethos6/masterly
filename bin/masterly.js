#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createCourse, findCourse, listCourses, loadSettings, saveSettings, home } from "../src/store.js";
import { addSource, buildCourse } from "../src/build.js";
import { Llm, resolveLlm } from "../src/llm.js";
import { nextQuestions, grade, record, ask, stats, conceptStates } from "../src/study.js";
import { ankiTsv, studyGuide } from "../src/export.js";
import { SUPPORTED } from "../src/extract.js";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? String(argv.shift()) : "open";
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  b: (/** @type {string} */ s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  d: (/** @type {string} */ s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  g: (/** @type {string} */ s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  r: (/** @type {string} */ s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  y: (/** @type {string} */ s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  i: (/** @type {string} */ s) => (tty ? `\x1b[3m${s}\x1b[0m` : s),
};

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(c.r("masterly: ") + msg);
  process.exit(1);
}

/** @param {string} name */
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
/** @param {string} name */
function bool(name) {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

/** @param {string | undefined} ref */
function courseArg(ref) {
  if (!ref) die("name a course (see: masterly list)");
  const found = findCourse(/** @type {string} */ (ref));
  if (!found) die(`no course "${ref}" (see: masterly list)`);
  return /** @type {import("../src/store.js").Course} */ (found);
}

async function model() {
  const cfg = await resolveLlm(loadSettings());
  if (!cfg) die("no model is configured. Run: masterly model --base <url> --model <name> [--key <key>]\n  or start freeflow (github.com/Ethos6/freeflow) or Ollama and masterly will find it.");
  return new Llm(/** @type {any} */ (cfg));
}

/** @param {string[]} files */
function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) die(`${f} does not exist`);
    if (fs.statSync(f).isDirectory()) {
      for (const e of fs.readdirSync(f, { recursive: true })) {
        const full = path.join(f, String(e));
        if (fs.statSync(full).isFile() && SUPPORTED.includes(path.extname(full).toLowerCase())) out.push(full);
      }
    } else out.push(f);
  }
  return out;
}

/** @param {import("../src/store.js").Course} course @param {string[]} files */
async function addFiles(course, files) {
  for (const f of expandFiles(files)) {
    try {
      const r = await addSource(course, path.basename(f), fs.readFileSync(f));
      console.log(r.duplicate ? c.d(`  = ${f} (already added)`) : `  + ${f} ${c.d(`(${r.source.title}, ${r.passages} passages)`)}`);
    } catch (e) {
      console.log(c.r(`  ✗ ${f}: ${/** @type {Error} */ (e).message}`));
    }
  }
}

/** @param {import("../src/store.js").Course} course */
async function build(course) {
  const llm = await model();
  console.log(c.d(`Building with ${llm.cfg.model} (${llm.cfg.source})`));
  let last = "";
  const done = await buildCourse(course, llm, {
    onProgress: (p) => {
      if (p.message !== last) console.log(`  ${p.stage === "done" ? c.g("✓") : "·"} ${p.message}`);
      last = p.message;
    },
  });
  const r = done.build.rejected || { concepts: 0, questions: 0 };
  if (r.concepts + r.questions) console.log(c.d(`  ${r.concepts} concept(s) and ${r.questions} question(s) were discarded because their quotes were not in the material.`));
  console.log(`\nStart studying: ${c.b(`masterly study "${course.name}"`)}  or open the app: ${c.b("masterly")}`);
}

/** @param {number} ms */
function fmt(ms) {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const d = ms / 86_400_000;
  return d < 1.5 ? "1d" : d < 31 ? `${Math.round(d)}d` : `${Math.round(d / 30)}mo`;
}

const commands = {
  async open() {
    const port = Number(flag("--port") || 4747);
    const host = flag("--host") || "127.0.0.1";
    const noOpen = bool("--no-open");
    const { startServer } = await import("../src/server.js");
    let started;
    try {
      started = await startServer({ port, host, allowedHosts: process.env.MASTERLY_ALLOWED_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) });
    } catch (e) {
      if (/** @type {any} */ (e).code === "EADDRINUSE") {
        try {
          const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
          if (h.name === "masterly") {
            console.log(`masterly is already running at http://127.0.0.1:${port}`);
            if (!noOpen) openBrowser(`http://127.0.0.1:${port}`);
            return;
          }
        } catch {
          /* something else */
        }
        die(`port ${port} is in use; try --port 4848`);
      }
      throw e;
    }
    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${started.port}`;
    const cfg = await resolveLlm(loadSettings());
    console.log(`${c.g("●")} ${c.b("masterly")} is running at ${c.b(url)}`);
    console.log(c.d(`  data:  ${home()}`));
    console.log(c.d(`  model: ${cfg ? `${cfg.model} (${cfg.source})` : "not connected yet: set one up in the app"}`));
    console.log(c.d("  Press Ctrl+C to stop."));
    if (!noOpen && process.stdout.isTTY && !process.env.CI) openBrowser(url);
    const stop = () => {
      started.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },

  async new() {
    const name = argv.shift();
    if (!name) return die('usage: masterly new "Course name" [files or folders...] [--no-build]');
    const noBuild = bool("--no-build");
    const course = createCourse(name);
    console.log(`Created ${c.b(course.name)} ${c.d(`(${course.id})`)}`);
    if (argv.length) {
      await addFiles(course, argv);
      if (!noBuild && course.sources.length) await build(course);
    } else console.log(`Add material with: masterly add ${course.id} <files...>`);
  },

  async add() {
    const course = courseArg(argv.shift());
    if (!argv.length) die("usage: masterly add <course> <files or folders...>");
    await addFiles(course, argv);
    console.log(`Rebuild to include it: ${c.b(`masterly build ${course.id}`)}`);
  },

  async build() {
    await build(courseArg(argv.shift()));
  },

  async list() {
    const all = listCourses();
    if (!all.length) return console.log('No courses yet. Create one: masterly new "Cell biology" notes.pdf');
    for (const course of all) {
      const s = stats(course);
      console.log(`${c.b(course.name)} ${c.d(course.id)}`);
      console.log(`  ${course.sources.length} source(s) · ${s.concepts} concepts · ${s.questions} questions · ${s.mastered} mastered · ${s.dueNow} due now · ${course.build.status}`);
    }
  },

  async study() {
    const course = courseArg(argv.shift());
    const limit = Number(flag("--limit") || 20);
    if (!course.questions.length) die(`"${course.name}" has no questions yet. Run: masterly build ${course.id}`);
    const llm = await resolveLlm(loadSettings()).then((cfg) => (cfg ? new Llm(cfg) : null));
    // A line queue instead of rl.question: piped input arrives all at once and
    // readline would drop lines that come before a question is asked.
    const rlRaw = readline.createInterface({ input: process.stdin, terminal: false });
    /** @type {string[]} */
    const lines = [];
    /** @type {((s: string) => void) | null} */
    let waiting = null;
    let ended = false;
    rlRaw.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
    rlRaw.on("close", () => {
      ended = true;
      if (waiting) waiting("q");
    });
    const rl = {
      /** @param {string} prompt @returns {Promise<string>} */
      question(prompt) {
        process.stdout.write(prompt);
        if (lines.length) return Promise.resolve(/** @type {string} */ (lines.shift()));
        if (ended) return Promise.resolve("q");
        return new Promise((r) => (waiting = r));
      },
      close: () => rlRaw.close(),
    };
    const names = new Map(course.concepts.map((x) => [x.id, x.name]));
    let done = 0;
    let right = 0;
    try {
      for (;;) {
        const n = nextQuestions(course, { limit });
        const qid = n.queue[0];
        if (!qid || done >= limit) break;
        const q = /** @type {import("../src/store.js").Question} */ (course.questions.find((x) => x.id === qid));
        console.log(`\n${c.d(`${done + 1}. ${names.get(q.concept)}${course.cards[q.id] && course.cards[q.id].state !== "new" ? " · review" : " · new"}`)}`);
        console.log(c.b(q.type === "tf" ? `True or false? ${q.prompt}` : q.prompt));
        /** @type {any} */
        let answer;
        if (q.type === "mcq") {
          (q.options || []).forEach((o, i) => console.log(`  ${String.fromCharCode(65 + i)}. ${o}`));
          for (;;) {
            const a = (await rl.question("Your answer (letter, or q to quit): ")).trim();
            if (a.toLowerCase() === "q") return;
            const i = a.toUpperCase().charCodeAt(0) - 65;
            if (a.length === 1 && i >= 0 && i < (q.options || []).length) {
              answer = i;
              break;
            }
          }
        } else if (q.type === "tf") {
          for (;;) {
            const a = (await rl.question("t / f (or q to quit): ")).trim().toLowerCase();
            if (a === "q") return;
            if (a === "t" || a === "true") answer = true;
            else if (a === "f" || a === "false") answer = false;
            else continue;
            break;
          }
        } else {
          answer = (await rl.question("Your answer (q to quit): ")).trim();
          if (answer.toLowerCase() === "q") return;
          if (!answer) answer = "(no answer)";
        }
        const g = await grade(course, q.id, answer, llm);
        console.log(g.correct && g.score >= 0.85 ? c.g("✓ " + g.feedback) : g.selfGrade ? c.y(g.feedback) : c.r("✗ " + g.feedback));
        if (q.type === "short") console.log(`${c.b("Model answer:")} ${q.answer}`);
        if (q.explanation) console.log(q.explanation);
        for (const e of q.evidence.slice(0, 2)) console.log(c.i(`  “${e.excerpt.replace(/\s+/g, " ")}”`));
        const iv = g.intervals;
        const pick = (await rl.question(`Rate it: 1 again (${fmt(iv[1])})  2 hard (${fmt(iv[2])})  3 good (${fmt(iv[3])})  4 easy (${fmt(iv[4])})  [Enter = ${g.suggested}]: `)).trim();
        const rating = /** @type {1|2|3|4} */ (/^[1-4]$/.test(pick) ? Number(pick) : g.suggested);
        record(course, q.id, rating, { score: g.score, answer: typeof answer === "string" ? answer : undefined });
        done++;
        if (rating >= 2) right++;
      }
    } finally {
      rl.close();
    }
    const s = stats(course);
    console.log(`\n${done ? `Done: ${right} of ${done} right.` : "Nothing due right now."} ${s.mastered}/${s.concepts} concepts mastered. Next reviews tomorrow: ${s.forecast[1]}.`);
  },

  async ask() {
    const course = courseArg(argv.shift());
    const question = argv.join(" ").trim();
    if (!question) die('usage: masterly ask <course> "your question"');
    const a = await ask(course, question, await model());
    console.log(`\n${a.answer}\n`);
    for (const ci of a.citations) console.log(c.d(`[${ci.chunk}] ${ci.where}: `) + c.i(`“${ci.excerpt.replace(/\s+/g, " ")}”`));
    if (a.unverified) console.log(c.d(`\n${a.unverified} unverifiable quote(s) were left out.`));
  },

  async map() {
    const course = courseArg(argv.shift());
    const states = conceptStates(course);
    const icon = { locked: "🔒", ready: "○", learning: "◐", passed: "●", mastered: c.g("✓") };
    for (const x of [...course.concepts].sort((a, b) => a.order - b.order)) {
      const s = /** @type {import("../src/study.js").ConceptState} */ (states.get(x.id));
      console.log(`${icon[s.status]} ${c.b(x.name)} ${c.d(`${s.status}, ${Math.round(s.mastery * 100)}% recall, ${s.answered}/${s.questions} answered`)}`);
      console.log(`  ${x.summary}`);
    }
  },

  async export() {
    const course = courseArg(argv.shift());
    const anki = flag("--anki");
    const guide = flag("--guide");
    if (!anki && !guide) die("usage: masterly export <course> --anki deck.txt | --guide guide.md");
    if (anki) {
      fs.writeFileSync(anki, ankiTsv(course));
      console.log(`Wrote ${anki}: in Anki use File → Import.`);
    }
    if (guide) {
      fs.writeFileSync(guide, studyGuide(course));
      console.log(`Wrote ${guide}`);
    }
  },

  async model() {
    const base = flag("--base");
    const name = flag("--model");
    const key = flag("--key");
    if (base || name || key) {
      const s = loadSettings();
      if (base) s.baseUrl = base;
      if (name) s.model = name;
      if (key) s.apiKey = key;
      saveSettings(s);
    }
    const cfg = await resolveLlm(loadSettings());
    if (!cfg) return console.log("No model configured. Example:\n  masterly model --base https://api.groq.com/openai/v1 --model llama-3.3-70b-versatile --key gsk_...");
    console.log(`${cfg.model} at ${cfg.baseUrl} ${c.d(`(${cfg.source})`)}`);
    if (bool("--test") || base || name || key) {
      const llm = new Llm(cfg);
      const t0 = Date.now();
      try {
        await llm.json([{ role: "user", content: 'Reply with this JSON object and nothing else: {"ok": true}' }], (v) => {
          if (v?.ok !== true) throw new Error('expected {"ok": true}');
          return v;
        });
        console.log(c.g(`✓ works (${Date.now() - t0} ms)`));
      } catch (e) {
        die(`the model did not answer correctly: ${/** @type {Error} */ (e).message}`);
      }
    }
  },

  async version() {
    const { VERSION } = await import("../src/server.js");
    console.log(VERSION);
  },

  async help() {
    console.log(`${c.b("masterly")}: learn anything from your own material.

  masterly                                  open the app in your browser
  masterly new "Name" <files|folders>       create a course and build it
  masterly add <course> <files|folders>     add material (then: masterly build <course>)
  masterly build <course>                   find concepts and write grounded questions
  masterly study <course> [--limit 20]      study in the terminal
  masterly map <course>                     concepts in learning order, with your progress
  masterly ask <course> "question"          answer from your material, with checked quotes
  masterly export <course> --anki f.txt | --guide f.md
  masterly list                             your courses
  masterly model [--base URL --model NAME --key KEY] [--test]

Material: ${SUPPORTED.join(" ")}
Models: any OpenAI-compatible endpoint. A running freeflow or Ollama is found automatically.
Data: ${home()}`);
  },
};

/** @param {string} url */
function openBrowser(url) {
  const [bin, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no browser */
  }
}

const fn = /** @type {Record<string, () => Promise<any>>} */ (commands)[cmd] || (["-h", "--help"].includes(cmd) ? commands.help : ["-v", "--version"].includes(cmd) ? commands.version : null);
if (!fn) die(`unknown command "${cmd}". Run: masterly help`);
fn().catch((/** @type {any} */ e) => die(e?.message || String(e)));
