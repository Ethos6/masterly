import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startMockLlm } from "./helpers/mock-llm.js";
import { docx } from "./helpers/files.js";

let mock, srv, base;
const FIXTURE = fs.readFileSync(new URL("./fixtures/biology.md", import.meta.url));

before(async () => {
  process.env.MASTERLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "masterly-api-"));
  mock = await startMockLlm({ conceptName: (p) => p.text.slice(0, 18) });
  const { saveSettings } = await import("../src/store.js");
  saveSettings({ baseUrl: mock.url, model: "mock", apiKey: "sk-secret-value" });
  const { startServer } = await import("../src/server.js");
  srv = await startServer({ port: 0, log: () => {} });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  srv.server.closeAllConnections?.();
  await new Promise((r) => srv.server.close(r));
  await mock.close();
});

const api = async (p, body, method) => {
  const r = await fetch(base + "/api" + p, { method: method || (body === undefined ? "GET" : "POST"), headers: { "x-masterly": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

async function waitBuilt(id) {
  const r = await fetch(`${base}/api/courses/${id}/events`);
  const text = await r.text();
  return text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.slice(6)));
}

test("full flow: create, upload, build with live progress, study, export", async () => {
  const st = await api("/state");
  assert.equal(st.body.llm.model, "mock");
  assert.equal(st.body.settings.hasKey, true);
  assert.ok(!JSON.stringify(st.body).includes("sk-secret-value"), "the API key is never sent to the page");

  const c = (await api("/courses", { name: "Cells" })).body;
  assert.match(c.id, /^cells-[0-9a-f]{6}$/);
  const up = await api(`/courses/${c.id}/sources`, { name: "biology.md", data: FIXTURE.toString("base64") });
  assert.equal(up.status, 200);
  assert.ok(up.body.passages > 2);
  const up2 = await api(`/courses/${c.id}/sources`, { name: "../../lecture.docx", data: docx(["Enzymes speed up chemical reactions without being used up."]).toString("base64") });
  assert.equal(up2.body.source.file, "lecture.docx", "path parts in file names are dropped");
  const bad = await api(`/courses/${c.id}/sources`, { name: "x.exe", data: "AAAA" });
  assert.equal(bad.status, 400);

  assert.equal((await api(`/courses/${c.id}/build`, {})).status, 202);
  assert.equal((await api(`/courses/${c.id}/build`, {})).status, 409, "one build at a time");
  const events = await waitBuilt(c.id);
  assert.ok(events.some((e) => e.type === "progress" && e.stage === "questions"));
  assert.equal(events.at(-1).type, "done");

  const d = (await api(`/courses/${c.id}`)).body;
  assert.ok(d.concepts.length > 0);
  assert.ok(d.concepts[0].evidence[0].where.includes("How Cells Make and Use Energy"));
  assert.equal(typeof d.questions, "number", "only a count: answers are not sent before they are asked");
  assert.ok(!JSON.stringify(d).includes("keyPoints"));

  const n = (await api(`/courses/${c.id}/next`)).body;
  assert.ok(n.question.prompt);
  assert.equal(n.question.answer, undefined);
  assert.equal(n.question.explanation, undefined);
  const q = n.question;
  const ans = q.type === "mcq" ? 0 : q.type === "tf" ? true : "Cells are the basic unit of life";
  const g = (await api(`/courses/${c.id}/answer`, { question: q.id, answer: ans })).body;
  assert.ok(g.reveal.evidence[0].where);
  assert.ok([1, 2, 3, 4].includes(g.suggested));
  const rated = (await api(`/courses/${c.id}/rate`, { question: q.id, rating: g.suggested })).body;
  assert.equal(rated.stats.reviews, 1);
  assert.equal((await api(`/courses/${c.id}/rate`, { question: q.id, rating: 9 })).status, 400);

  const h = (await api(`/courses/${c.id}/hint`, { question: q.id })).body;
  assert.ok(h.hint);
  const a = (await api(`/courses/${c.id}/ask`, { question: "What do mitochondria do?" })).body;
  assert.ok(a.citations.length >= 1);
  assert.equal((await api(`/courses/${c.id}/ask`, { question: " " })).status, 400);

  const anki = await fetch(`${base}/api/courses/${c.id}/export/anki`);
  assert.match(anki.headers.get("content-disposition") || "", /attachment; filename="Cells\.anki\.txt"/);
  assert.match(await anki.text(), /^#separator:tab/);
  const guide = await fetch(`${base}/api/courses/${c.id}/export/guide`);
  assert.match(await guide.text(), /^# Cells/);

  const set = (await api(`/courses/${c.id}/settings`, { name: "Cell biology", newPerDay: 9999, retention: 0.5 })).body;
  assert.equal(set.name, "Cell biology");
  assert.equal(set.settings.newPerDay, 500, "clamped");
  assert.equal(set.settings.retention, 0.7, "clamped");

  const removed = (await api(`/courses/${c.id}/sources/S2`, undefined, "DELETE")).body;
  assert.equal(removed.sources.length, 1);
  assert.equal(removed.build.status, "ready");
  assert.equal((await api(`/courses/${c.id}`, undefined, "DELETE")).status, 200);
  assert.equal((await api(`/courses/${c.id}`)).status, 404);
});

test("security: writes need masterly's header and same origin; foreign hosts refused", async () => {
  const noHeader = await fetch(`${base}/api/courses`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "x" }) });
  assert.equal(noHeader.status, 403);
  const cross = await fetch(`${base}/api/courses`, { method: "POST", headers: { "x-masterly": "1", origin: "https://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
  const status = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: srv.port, path: "/api/state", headers: { host: "evil.example" } }, (r) => resolve(r.statusCode)));
  assert.equal(status, 403);
  assert.equal((await api("/courses/..%2F..%2Fetc")).status, 404);
  const page = await fetch(base);
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes("__MASTERLY_"));
});

test("settings: key kept unless replaced, URL validated, test endpoint", async () => {
  assert.equal((await api("/settings", { baseUrl: "file:///etc/passwd" })).status, 400);
  assert.equal((await api("/settings", { baseUrl: mock.url, model: "mock", apiKey: "" })).status, 200);
  const st = (await api("/state")).body;
  assert.equal(st.settings.hasKey, true, "an empty key field keeps the saved key");
  const t = (await api("/settings/test", {})).body;
  assert.equal(t.ok, true);
});
