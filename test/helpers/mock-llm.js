// A scripted OpenAI-compatible model for tests and demos. It reads the prompt,
// recognises which task it is, and answers with JSON built from the real passages,
// plus some deliberately bad items (invented quotes, broken questions) that
// masterly must reject.
import http from "node:http";

/** Pull "[P3] (label)\ntext" blocks out of a prompt. */
export function passagesIn(text) {
  const out = [];
  const re = /\[(P\d+)\][^\n]*\n([\s\S]*?)(?=\n\n---\n\n\[P\d+\]|$)/g;
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], text: m[2].trim() });
  return out;
}

/** First sentence of a passage with at least `min` words. */
export function sentence(text, skip = 0, min = 6) {
  const all = text.split(/\n+/).flatMap((line) => line.match(/[^.!?]+[.!?]/g) || []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= min);
  return all[skip % Math.max(1, all.length)] || text.slice(0, 120);
}

function titleOf(s) {
  const words = s.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 3);
  return words.slice(0, 3).join(" ") || "Idea";
}

export function respond(messages, opts = {}) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.filter((m) => m.role === "user").at(-1)?.content || "";
  if (/Identify the key concepts/.test(system)) {
    const ps = passagesIn(user);
    const concepts = ps.map((p, i) => ({
      name: opts.conceptName ? opts.conceptName(p, i) : titleOf(sentence(p.text)),
      summary: `About: ${sentence(p.text).slice(0, 80)}`,
      prerequisites: i > 0 ? [opts.conceptName ? opts.conceptName(ps[i - 1], i - 1) : titleOf(sentence(ps[i - 1].text))] : [],
      evidence: [{ passage: p.id, quote: sentence(p.text) }],
    }));
    concepts.push({ name: "Invented concept", summary: "not in the text", prerequisites: [], evidence: [{ passage: ps[0]?.id, quote: "this sentence was never written by anyone at all" }] });
    return { concepts };
  }
  if (/ordering the concepts/.test(system)) {
    const ids = [...user.matchAll(/^(C\d+):/gm)].map((m) => m[1]);
    return { edges: ids.slice(1).map((id, i) => ({ concept: id, requires: [ids[i]] })) };
  }
  if (/practice questions/.test(system)) {
    const ps = passagesIn(user);
    const p = ps[0];
    const s1 = sentence(p.text, 0);
    const s2 = sentence(p.text, 1);
    return {
      questions: [
        { type: "mcq", prompt: `Which statement matches the material about ${titleOf(s1)}?`, options: [s1.slice(0, 60), "Something unrelated A", "Something unrelated B", "Something unrelated C"], answer: 0, explanation: "The passage says so.", evidence: [{ passage: p.id, quote: s1 }] },
        { type: "tf", prompt: `${s2}`, answer: true, explanation: "Stated directly.", evidence: [{ passage: p.id, quote: s2 }] },
        { type: "short", prompt: `Explain in your own words: ${titleOf(s1)}.`, answer: s1, keyPoints: [titleOf(s1), "uses the material"], explanation: "From the passage.", evidence: [{ passage: p.id, quote: s1 }] },
        { type: "mcq", prompt: "A question with an invented quote", options: ["a", "b", "c", "d"], answer: 1, explanation: "x", evidence: [{ passage: p.id, quote: "completely invented words that are not in the passage" }] },
        { type: "mcq", prompt: "A question with duplicate options here", options: ["same", "same", "other", "x"], answer: 0, explanation: "x", evidence: [{ passage: p.id, quote: s1 }] },
      ],
    };
  }
  if (/grade a learner's short answer/.test(system)) {
    const answer = user.split("Learner's answer:\n")[1] || "";
    const ref = (user.match(/Reference answer: (.*)/) || [])[1] || "";
    const words = new Set(ref.toLowerCase().match(/\p{L}{4,}/gu) || []);
    const hit = (answer.toLowerCase().match(/\p{L}{4,}/gu) || []).filter((w) => words.has(w)).length;
    const score = Math.min(1, hit / Math.max(1, Math.min(6, words.size)));
    return { score: Math.round(score * 100) / 100, covered: score > 0.5 ? [0] : [], missing: score > 0.5 ? [] : [0], feedback: score > 0.5 ? "Good: you captured the main idea." : "You missed the main idea of the passage.", misconception: "" };
  }
  if (/Socratic tutor/.test(system)) {
    if (opts.leakyHint) {
      const opt = (user.match(/\nA\. (.*)/) || [])[1] || "";
      return { hint: `The answer is ${opt}` };
    }
    return { hint: "Think about what the passage says happens first, and why." };
  }
  if (/answer a learner's question/.test(system)) {
    const ps = passagesIn(user);
    if (/unanswerable/i.test(user)) return { found: false, answer: "The material does not cover that.", citations: [] };
    const p = ps[0];
    return { found: true, answer: `According to the material, ${sentence(p.text).toLowerCase()} [${p.id}] [P999]`, citations: [{ passage: p.id, quote: sentence(p.text) }, { passage: p.id, quote: "a quote that is not there at all" }] };
  }
  if (/\{"ok": true\}/.test(user)) return { ok: true };
  return { error: "mock does not know this prompt" };
}

/**
 * @param {{conceptName?: (p, i) => string, fail?: (body: any, n: number) => {status: number, body: any} | null, prose?: boolean, leakyHint?: boolean, noJsonMode?: boolean}} [opts]
 */
export async function startMockLlm(opts = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      calls.push(body);
      const failed = opts.fail?.(body, calls.length);
      if (failed) {
        res.writeHead(failed.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(failed.body));
      }
      if (opts.noJsonMode && body.response_format) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "response_format is not supported by this model" } }));
      }
      const out = respond(body.messages || [], opts);
      const content = opts.prose ? `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\`\nHope that helps.` : JSON.stringify(out);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, calls, server, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
