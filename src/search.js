// @ts-check
/**
 * BM25 keyword search over passages. No embeddings, no external service: good enough
 * to find the passages a question is about, and fully offline.
 */

const STOP = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or so than that the their then there these this those to was were what when where which who why will with you your does do did can could should would about".split(" "),
);

/** @param {string} text */
export function tokenize(text) {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => !STOP.has(t) && (t.length > 1 || /\p{N}/u.test(t))).map(stem);
}

/** Light suffix stripping so "cells"/"cell" and "dividing"/"divide" meet. @param {string} t */
function stem(t) {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("es") && /(ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  return t;
}

export class Index {
  /** @param {{id: string, text: string}[]} docs */
  constructor(docs) {
    this.k1 = 1.4;
    this.b = 0.75;
    /** @type {{id: string, tf: Map<string, number>, len: number}[]} */
    this.docs = docs.map((d) => {
      const tf = new Map();
      const toks = tokenize(d.text);
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { id: d.id, tf, len: toks.length };
    });
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
    /** @type {Map<string, number>} */
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  /**
   * @param {string} query
   * @param {number} [k]
   * @returns {{id: string, score: number}[]}
   */
  search(query, k = 6) {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const scores = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avg || 1)));
      }
      if (s > 0) scores.push({ id: d.id, score: s });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
