// @ts-check
/**
 * Split extracted text into passages: units small enough to show a model alongside
 * others, large enough to keep an idea together. Splits fall on paragraph, then
 * sentence, boundaries; a passage never crosses a page or chapter.
 *
 * @typedef {object} Passage
 * @property {string} id
 * @property {string} source   source id
 * @property {string} label    "page 3", "chapter 2: Cells", ...
 * @property {string} text
 */

const TARGET = 1200;

/** "Notes, page 3", or just "Notes" for single-part files. @param {string} title @param {string} label */
export function placeOf(title, label) {
  return [title, label].filter(Boolean).join(", ");
}
const MAX = 2000;

/**
 * @param {import("./extract.js").Section[]} sections
 * @param {string} sourceId
 * @param {() => string} nextId
 * @returns {Passage[]}
 */
export function chunk(sections, sourceId, nextId) {
  /** @type {Passage[]} */
  const out = [];
  for (const section of sections) {
    const paras = section.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    /** @type {string[]} */
    const units = [];
    for (const p of paras) {
      if (p.length <= MAX) units.push(p);
      else units.push(...splitLong(p));
    }
    let buf = "";
    for (const u of units) {
      if (buf && buf.length + u.length + 2 > TARGET) {
        out.push({ id: nextId(), source: sourceId, label: section.label, text: buf });
        buf = "";
      }
      buf = buf ? `${buf}\n\n${u}` : u;
    }
    if (buf) out.push({ id: nextId(), source: sourceId, label: section.label, text: buf });
  }
  return out;
}

/** @param {string} p */
function splitLong(p) {
  const sentences = p.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*\s*|$)/g) || [p];
  /** @type {string[]} */
  const out = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > TARGET) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > MAX) {
      for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
