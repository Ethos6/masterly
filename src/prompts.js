// @ts-check
/**
 * Prompt text for every model call. Kept in one place so the rules the model is
 * given and the checks in code can be read side by side.
 */

/** @param {{id: string, label: string, text: string}[]} passages @param {Map<string,string>} [titles] source id -> title */
export function formatPassages(passages, titles) {
  return passages
    .map((p) => {
      const src = titles?.get(/** @type {any} */ (p).source);
      return `[${p.id}] (${[src, p.label].filter(Boolean).join(", ") || "material"})\n${p.text}`;
    })
    .join("\n\n---\n\n");
}

const QUOTE_RULES = `Evidence rules (checked by a program; anything that fails is thrown away):
- "quote" must be copied character for character from the passage named in "passage": no paraphrasing, no fixing typos, no joining sentences from different passages.
- Quote 8 to 40 words: the shortest stretch that fully supports the point.
- To skip words inside one passage, write "..." where they were.`;

/** @param {string} [language] */
function lang(language) {
  return language ? `Write names, summaries, questions and feedback in ${language}.` : "Write names, summaries, questions and feedback in the language the material is written in.";
}

/**
 * @param {string} passagesText
 * @param {{courseName: string, language?: string, max: number}} o
 */
export function conceptsPrompt(passagesText, o) {
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You are an expert teacher turning a learner's own study material into a mastery course on "${o.courseName}".
Identify the key concepts these passages teach: ideas, definitions, processes, methods, results or relationships a learner must understand and be able to use.
- Only concepts the passages actually teach. No outside knowledge, no concepts that are merely mentioned in passing.
- Prefer concepts at a useful grain: something one could ask three different questions about.
- Return at most ${o.max} concepts for these passages, the most important first.
- "prerequisites" lists names of other concepts (from this reply or ones a learner would meet earlier in the material) that must be understood first. Leave it empty when unsure.
${lang(o.language)}

${QUOTE_RULES}

Reply with JSON only:
{"concepts":[{"name":"short name","summary":"one sentence in your own words","prerequisites":["concept name"],"evidence":[{"passage":"P3","quote":"exact words from P3"}]}]}`,
    },
    { role: /** @type {const} */ ("user"), content: `Passages:\n\n${passagesText}` },
  ];
}

/**
 * @param {{id: string, name: string, summary: string}[]} concepts
 * @param {{courseName: string}} o
 */
export function prerequisitesPrompt(concepts, o) {
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You are ordering the concepts of a course on "${o.courseName}" for a learner.
For each concept, list the other concepts in this list that a learner must understand BEFORE it makes sense (direct prerequisites only, not prerequisites of prerequisites). Only add a prerequisite when the concept genuinely depends on it. Many concepts have none.
Reply with JSON only: {"edges":[{"concept":"C3","requires":["C1"]}]}`,
    },
    { role: /** @type {const} */ ("user"), content: concepts.map((c) => `${c.id}: ${c.name}: ${c.summary}`).join("\n") },
  ];
}

/**
 * @param {{name: string, summary: string}} concept
 * @param {string} passagesText
 * @param {{count: number, language?: string, avoid: string[]}} o
 */
export function questionsPrompt(concept, passagesText, o) {
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You write practice questions that check whether a learner has mastered one concept, using ONLY the passages provided.
Write ${o.count} questions about the concept, mixing types:
- "mcq": 4 options, exactly one correct according to the passages; wrong options must be plausible to someone with a shallow understanding. "answer" is the 0-based index of the correct option.
- "tf": a statement that is clearly true or clearly false according to the passages. "answer" is true or false. Make false statements by changing something that matters.
- "short": a question answered in one to three sentences. "answer" is a model answer; "keyPoints" lists the 2 to 4 points a full answer must contain.
Test understanding (why, how, what follows, what differs) rather than recall of trivial wording. Every question must be answerable from the passages alone.
"explanation" says in one or two sentences why the correct answer is correct.
Each question's "evidence" must contain the passage text that proves the correct answer.
${lang(o.language)}
${o.avoid.length ? `Do not repeat these existing questions:\n${o.avoid.map((a) => `- ${a}`).join("\n")}\n` : ""}
${QUOTE_RULES}

Reply with JSON only:
{"questions":[{"type":"mcq","prompt":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","evidence":[{"passage":"P3","quote":"..."}]},
{"type":"tf","prompt":"statement","answer":false,"explanation":"...","evidence":[...]},
{"type":"short","prompt":"...","answer":"...","keyPoints":["...","..."],"explanation":"...","evidence":[...]}]}`,
    },
    { role: /** @type {const} */ ("user"), content: `Concept: ${concept.name}\nSummary: ${concept.summary}\n\nPassages:\n\n${passagesText}` },
  ];
}

/**
 * @param {import("./store.js").Question} q
 * @param {string} learnerAnswer
 * @param {string} [language]
 */
export function gradePrompt(q, learnerAnswer, language) {
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You grade a learner's short answer fairly and kindly, against a reference answer and key points taken from their study material.
- Judge meaning, not wording. Synonyms and different phrasing are fine; spelling mistakes don't matter.
- A key point is "covered" only if the answer states it or something equivalent. Vague or contradictory answers don't cover it.
- "score" is between 0 and 1: the share of key points covered, lowered if the answer also says something wrong.
- "feedback": two or three sentences to the learner. Say what was right, then what was missing or wrong, specifically.
- "misconception": if the answer reveals a misunderstanding, name it in one sentence; otherwise "".
${language ? `Write feedback in ${language}.` : "Write feedback in the language of the question."}
Reply with JSON only: {"score":0.5,"covered":[0],"missing":[1],"feedback":"...","misconception":""}`,
    },
    {
      role: /** @type {const} */ ("user"),
      content: `Question: ${q.prompt}
Reference answer: ${q.answer}
Key points:
${(q.keyPoints || []).map((k, i) => `${i}. ${k}`).join("\n")}
Supporting text from the material:
${q.evidence.map((e) => `"${e.excerpt}"`).join("\n")}

Learner's answer:
${learnerAnswer.slice(0, 4000)}`,
    },
  ];
}

/** @param {import("./store.js").Question} q @param {string} passagesText */
export function hintPrompt(q, passagesText) {
  const shown = q.type === "mcq" ? `${q.prompt}\nOptions:\n${(q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n")}` : q.prompt;
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You are a Socratic tutor. Give ONE short hint (one or two sentences) that helps the learner work out the answer to the question themselves.
Never state the answer, never say which option is correct, never say whether a statement is true or false. Point them toward the idea or the part of the material that matters, or ask a guiding question.
Reply with JSON only: {"hint":"..."}`,
    },
    { role: /** @type {const} */ ("user"), content: `Question: ${shown}\n\nMaterial:\n\n${passagesText}` },
  ];
}

/** @param {string} question @param {string} passagesText @param {string} [language] */
export function askPrompt(question, passagesText, language) {
  return [
    {
      role: /** @type {const} */ ("system"),
      content: `You answer a learner's question using ONLY the passages from their study material below.
- If the passages don't contain the answer, set "found" to false and say briefly what the material does cover instead. Never fill gaps with outside knowledge.
- Otherwise answer clearly and concisely (Markdown allowed) and mark each claim with the passage it comes from, like [P3].
- "citations" lists the exact text supporting the answer.
${language ? `Answer in ${language}.` : "Answer in the language of the question."}

${QUOTE_RULES}

Reply with JSON only: {"found":true,"answer":"... [P3]","citations":[{"passage":"P3","quote":"..."}]}`,
    },
    { role: /** @type {const} */ ("user"), content: `Question: ${question}\n\nPassages:\n\n${passagesText}` },
  ];
}
