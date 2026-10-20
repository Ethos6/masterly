// @ts-check
/**
 * Grounding: every fact masterly teaches must be traceable to the learner's own
 * material. Models are asked to quote the passage that supports each concept,
 * question and answer; this module checks that each quote really appears there.
 *
 * Matching ignores differences that don't change meaning (case, whitespace, curly
 * vs straight quotes, dash styles, Markdown emphasis, Unicode compatibility forms)
 * but never accepts paraphrases. A quote may skip text with "..." as long as each
 * piece appears, in order, within the same passage.
 */

const MIN_CHARS = 15;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const MIN_WORDS = 3;

/**
 * Normalize text and keep a map from each normalized character back to its
 * position in the original string.
 * @param {string} s
 * @returns {{ norm: string, map: number[] }}
 */
export function normalizeWithMap(s) {
  let norm = "";
  /** @type {number[]} */
  const map = [];
  let lastSpace = true;
  // Work grapheme by grapheme so "e" + combining accent matches a precomposed "é".
  for (const { segment, index: i } of segmenter.segment(s)) {
    let out = segment.normalize("NFKC").toLowerCase();
    out = out
      .replace(/[‘’‚‛′`]/g, "'")
      .replace(/[“”„‟″«»]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/[­​-‍﻿*_]/g, "");
    for (const c of out) {
      if (/\s/.test(c)) {
        if (lastSpace) continue;
        norm += " ";
        map.push(i);
        lastSpace = true;
      } else {
        norm += c;
        map.push(i);
        lastSpace = false;
      }
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/** The grapheme starting at offset i. @param {string} s @param {number} i */
function graphemeAt(s, i) {
  const it = segmenter.segment(s.slice(i, i + 16))[Symbol.iterator]().next();
  return it.done ? s[i] : it.value.segment;
}

/** @param {string} s */
export function normalize(s) {
  return normalizeWithMap(s).norm;
}

/**
 * @typedef {object} Match
 * @property {true} ok
 * @property {number} start   offset in the original text
 * @property {number} end
 * @property {string} excerpt the original text that was matched
 *
 * @typedef {object} Miss
 * @property {false} ok
 * @property {string} reason
 */

/**
 * Find `quote` in `text`.
 * @param {string} quote
 * @param {string} text
 * @param {{norm: string, map: number[]}} [pre]  pre-normalized text, for speed
 * @returns {Match | Miss}
 */
export function findQuote(quote, text, pre) {
  if (typeof quote !== "string") return { ok: false, reason: "quote is missing" };
  const cleaned = quote.trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  const pieces = cleaned
    .split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/)
    .map((p) => normalize(p).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ""))
    .filter(Boolean);
  const joined = pieces.join(" ");
  if (joined.length < MIN_CHARS || joined.split(" ").length < MIN_WORDS) return { ok: false, reason: `quote is too short to be evidence (need at least ${MIN_WORDS} words)` };
  const { norm, map } = pre || normalizeWithMap(text);
  let from = 0;
  let first = -1;
  let last = -1;
  for (const piece of pieces) {
    const at = norm.indexOf(piece, from);
    if (at < 0) return { ok: false, reason: pieces.length > 1 ? `the part "${piece.slice(0, 60)}" is not in the passage` : "the quote does not appear in the passage" };
    if (first < 0) first = at;
    last = at + piece.length;
    from = last;
  }
  const start = map[first];
  const endIdx = map[last - 1];
  let end = endIdx + graphemeAt(text, endIdx).length;
  // include closing punctuation the model trimmed, so excerpts read as sentences
  while (end < text.length && /[.!?;:,)\]"'\u201d\u2019*_]/.test(text[end]) && end - endIdx < 5) end++;
  return { ok: true, start, end, excerpt: text.slice(start, end) };
}

/**
 * @typedef {object} Evidence
 * @property {string} chunk   passage id
 * @property {string} quote
 *
 * @typedef {Evidence & {excerpt: string, start: number, end: number}} VerifiedEvidence
 */

/**
 * Keep only the evidence that checks out. A quote attributed to the wrong passage is
 * moved to the passage that actually contains it, if that passage was available to
 * the model.
 * @param {unknown} evidence           model output
 * @param {Map<string, {text: string}>} passages  the passages the model was shown
 * @returns {{ verified: VerifiedEvidence[], rejected: {quote: string, reason: string}[] }}
 */
export function verifyEvidence(evidence, passages) {
  /** @type {VerifiedEvidence[]} */
  const verified = [];
  const rejected = [];
  const list = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  for (const item of list) {
    const quote = typeof item === "string" ? item : item?.quote;
    const claimed = typeof item === "object" && item ? String(item.chunk ?? item.passage ?? item.id ?? "") : "";
    if (typeof quote !== "string" || !quote.trim()) {
      rejected.push({ quote: String(quote ?? ""), reason: "empty quote" });
      continue;
    }
    const order = [...passages.keys()].sort((a, b) => (a === claimed ? -1 : b === claimed ? 1 : 0));
    let found = null;
    /** @type {string} */
    let reason = "the quote does not appear in any passage it was given";
    for (const id of order) {
      const p = passages.get(id);
      if (!p) continue;
      const m = findQuote(quote, p.text);
      if (m.ok) {
        found = { chunk: id, quote, excerpt: m.excerpt, start: m.start, end: m.end };
        break;
      }
      if (id === claimed) reason = m.reason;
    }
    if (found) {
      if (!verified.some((v) => v.chunk === found.chunk && v.start === found.start && v.end === found.end)) verified.push(found);
    } else rejected.push({ quote, reason });
  }
  return { verified, rejected };
}
