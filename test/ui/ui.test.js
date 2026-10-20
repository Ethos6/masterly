// Browser test: the whole learner journey in a real Chromium, against the mock model.
// Run with: npm run test:ui   (needs: npx playwright install chromium)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startMockLlm } from "../helpers/mock-llm.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "biology.md");
const NAMES = [["called the cell theory", "Cell theory"], ["plasma membrane", "Membranes"], ["Mitochondria produce", "Respiration"], ["chloroplasts, where", "Photosynthesis"], ["The nucleus stores", "DNA to protein"], ["reproduce by dividing", "Cell division"]];
let mock, srv, browser, base;
const errors = [];

before(async () => {
  process.env.MASTERLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "masterly-ui-"));
  mock = await startMockLlm({ conceptName: (p) => NAMES.find(([k]) => p.text.includes(k))?.[1] || "Energy" });
  const { saveSettings } = await import("../../src/store.js");
  saveSettings({ baseUrl: mock.url, model: "mock-model" });
  const { startServer } = await import("../../src/server.js");
  srv = await startServer({ port: 0, log: () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  srv?.server.closeAllConnections?.();
  srv?.server.close();
  await mock?.close();
});

/** @param {import("playwright").Page} page */
function watch(page) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
}

/** Answer the current question (correctly when the type allows) and accept the suggested rating. */
async function answerOne(page, { wrong = false, keyboard = false } = {}) {
  await page.waitForSelector(".qcard .qprompt");
  const type = await page.evaluate(() => (document.querySelector(".opt[data-i]") ? "mcq" : document.querySelector(".opt[data-tf]") ? "tf" : "short"));
  if (type === "mcq") {
    if (keyboard) await page.keyboard.press(wrong ? "D" : "A");
    else await page.click(wrong ? ".opt[data-i='3']" : ".opt[data-i='0']");
  } else if (type === "tf") await page.click(".opt[data-tf='true']");
  else {
    await page.fill("#ans", wrong ? "no idea" : "The cell is the smallest unit that can carry out all the processes of life.");
    await page.keyboard.press("Control+Enter");
  }
  await page.waitForSelector(".rate");
  const result = await page.textContent(".result");
  if (keyboard) await page.keyboard.press("Enter");
  else await page.click(".rate.sug");
  await page.waitForFunction(() => !document.querySelector(".rate"));
  return { type, result };
}

test("a learner creates a course, builds it, studies, and sees progress", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page);
  await page.goto(base);
  await page.click("text=Create your first course");
  await page.fill("#n-name", "Cell biology");
  await page.press("#n-name", "Enter");
  await page.waitForSelector("#drop");
  await page.setInputFiles("#file", FIXTURE);
  await page.waitForSelector(".src >> text=How Cells Make and Use Energy");
  await page.click("#build");
  await page.waitForSelector("text=Your course is ready", { timeout: 30_000 });
  assert.match(await page.textContent("#panel"), /backed by a verified quote/);
  assert.match(await page.textContent("#panel"), /discarded because (their quotes weren't|its quote wasn't) in your material/);

  // study: first question is new, from the first concept
  await page.click('.tabs button[data-tab="study"]');
  await page.waitForSelector(".qcard .qprompt");
  assert.match(await page.textContent(".qcard"), /Cell theory/);
  assert.match(await page.textContent(".qcard"), /New/);

  // hint does not reveal the answer
  await page.click("#hint");
  await page.waitForSelector("#hintbox .banner");
  assert.match(await page.textContent("#hintbox"), /Think about/);

  const a1 = await answerOne(page, { keyboard: true });
  assert.match(a1.result || "", /Correct/);
  const a2 = await answerOne(page);
  assert.ok(a2.result);
  const a3 = await answerOne(page);
  assert.ok(a3.result);

  // the source quote is shown with its location after answering
  // (checked on the next question)
  await page.waitForSelector(".qcard .qprompt");
  const t = await page.evaluate(() => document.querySelector(".opt[data-i]") ? "mcq" : "other");
  if (t === "mcq") {
    await page.click(".opt[data-i='3']");
    await page.waitForSelector(".quote");
    assert.equal(await page.textContent(".quote .w"), "How Cells Make and Use Energy");
    assert.match(await page.textContent(".result"), /Not quite/);
    await page.click(".rate.sug");
  }

  // map: the first concept is passed, the second is unlocked
  await page.click('.tabs button[data-tab="map"]');
  await page.waitForSelector(".path");
  const statuses = await page.$$eval(".nbody summary .chip", (els) => els.map((e) => e.textContent));
  assert.equal(statuses[0], "Passed");
  assert.notEqual(statuses[1], "Locked");
  assert.ok(statuses.slice(2).includes("Locked"), "later concepts wait for their prerequisites");

  // ask: verified quotes only
  await page.click('.tabs button[data-tab="ask"]');
  await page.fill("#askq", "What do mitochondria produce?");
  await page.press("#askq", "Enter");
  await page.waitForSelector(".msg.ai .quote");
  assert.equal(await page.$$eval(".msg.ai .quote", (q) => q.length), 1);
  assert.match(await page.textContent(".msg.ai"), /could not be found in your material/);

  // progress
  await page.click('.tabs button[data-tab="progress"]');
  await page.waitForSelector("svg.chart");
  assert.match(await page.textContent("#panel"), /right in your last 4 answers/);

  // the sidebar reflects the course
  assert.match(await page.textContent("#clist"), /Cell biology/);
  await page.close();
  assert.deepEqual(errors, []);
});

test("the app works at phone width without horizontal scrolling", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  watch(page);
  await page.goto(base);
  await page.waitForSelector(".qcard .qprompt, .empty");
  for (const tab of ["study", "map", "material", "progress"]) {
    await page.click(`.tabs button[data-tab="${tab}"]`);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${tab} fits`);
  }
  await page.close();
  assert.deepEqual(errors, []);
});

test("pressing a rating key twice records one review", async () => {
  const { listCourses } = await import("../../src/store.js");
  const course = listCourses()[0];
  const before = course.log.length;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page);
  await page.goto(base);
  await page.click('.tabs button[data-tab="map"]');
  await page.waitForSelector(".node:nth-child(2) summary");
  await page.click(".node:nth-child(2) summary");
  await page.click(".node:nth-child(2) [data-focus]");
  await page.waitForSelector(".qcard .qprompt");
  assert.match(await page.textContent("#panel"), /Focused/);
  const type = await page.evaluate(() => (document.querySelector(".opt[data-i]") ? "mcq" : document.querySelector(".opt[data-tf]") ? "tf" : "short"));
  if (type === "mcq") await page.click(".opt[data-i='0']");
  else if (type === "tf") await page.click(".opt[data-tf='true']");
  else { await page.fill("#ans", "answer"); await page.click("#submit"); }
  await page.waitForSelector(".rate");
  await page.keyboard.press("3");
  await page.keyboard.press("3");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const after = listCourses().find((c) => c.id === course.id);
  assert.equal(after.log.length, before + 1);
  await page.close();
  assert.deepEqual(errors, []);
});
