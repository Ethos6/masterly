// @ts-check
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Turn study material into plain text, keeping where each part came from.
 *
 * Supported: .md .markdown .txt .text .html .htm .pdf .docx .epub
 * DOCX and EPUB are zip files; they are read with a small built-in zip reader,
 * so only PDF needs a library (pdf.js).
 *
 * @typedef {object} Section
 * @property {string} text
 * @property {string} label    human location, e.g. "page 3" or "chapter 2: Cells"
 * @property {number} [page]
 *
 * @typedef {object} Extracted
 * @property {string} title
 * @property {string} type
 * @property {Section[]} sections
 */

export const SUPPORTED = [".md", ".markdown", ".txt", ".text", ".html", ".htm", ".pdf", ".docx", ".epub"];
const MAX_BYTES = 100 * 1024 * 1024;
/** Cap on the text taken from one file (about 30 books' worth). */
const MAX_TEXT = 20_000_000;

/**
 * @param {string} name   file name (for the extension and default title)
 * @param {Buffer} data
 * @returns {Promise<Extracted>}
 */
export async function extract(name, data) {
  if (data.length > MAX_BYTES) throw new Error(`${name} is larger than 100 MB`);
  const out = await extractRaw(name, data);
  if (out.sections.reduce((s, x) => s + x.text.length, 0) > MAX_TEXT) throw new Error(`${name} has more text than masterly reads from one file (20 million characters)`);
  return out;
}

/** @param {string} name @param {Buffer} data @returns {Promise<Extracted>} */
async function extractRaw(name, data) {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, ext);
  switch (ext) {
    case ".md":
    case ".markdown": {
      const md = data.toString("utf8");
      return { title: firstHeading(md) || base, type: "markdown", sections: [{ text: normalizeText(markdownToText(md)), label: "" }] };
    }
    case ".txt":
    case ".text":
      return { title: base, type: "text", sections: [{ text: normalizeText(data.toString("utf8")), label: "" }] };
    case ".html":
    case ".htm": {
      const html = data.toString("utf8");
      return { title: htmlTitle(html) || base, type: "html", sections: [{ text: htmlToText(html), label: "" }] };
    }
    case ".pdf":
      return extractPdf(base, data);
    case ".docx":
      return extractDocx(base, data);
    case ".epub":
      return extractEpub(base, data);
    default:
      throw new Error(`${name}: unsupported file type. Supported: ${SUPPORTED.join(" ")}`);
  }
}

/** @param {string} file */
export async function extractFile(file) {
  return extract(path.basename(file), fs.readFileSync(file));
}

// ------------------------------------------------------------------ text helpers

/** @param {string} s */
export function normalizeText(s) {
  return s
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "") // soft hyphen
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Markdown to readable text: drops syntax (heading marks, links, images, emphasis
 * markers, front matter, HTML) but keeps every word, including code.
 * @param {string} md
 */
export function markdownToText(md) {
  return md
    .replace(/^\uFEFF/, "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^```[^\n]*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "- ")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^ {0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
}

/** @param {string} md */
function firstHeading(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

const ENTITIES = /** @type {Record<string,string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", minus: "−", deg: "°" });

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** @param {string} html */
function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim() : "";
}

/** Readable text from HTML/XHTML: drops scripts and styles, keeps block structure. @param {string} html */
export function htmlToText(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|section|article|h[1-6]|tr|blockquote|pre|ul|ol|table|figure|figcaption|dd|dt)>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return normalizeText(decodeEntities(body));
}

// ------------------------------------------------------------------ zip

/**
 * Minimal zip reader (stored and deflated entries), enough for DOCX and EPUB.
 * @param {Buffer} buf
 * @returns {Map<string, () => Buffer>}
 */
export function readZip(buf) {
  let inflated = 0; // total budget across entries: protects against zip bombs
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  /** @type {Map<string, () => Buffer>} */
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) {
        if (usize > MAX_BYTES || inflated + usize > 2 * MAX_BYTES) throw new Error(`zip entry ${name} is too large`);
        const out = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(MAX_BYTES, 2 * MAX_BYTES - inflated) });
        inflated += out.length;
        return out;
      }
      throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    });
  }
  return entries;
}

// ------------------------------------------------------------------ docx

/** @param {string} base @param {Buffer} data @returns {Extracted} */
function extractDocx(base, data) {
  const zip = readZip(data);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error(`${base}.docx has no word/document.xml`);
  const xml = doc().toString("utf8");
  const paras = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const text = (p.match(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
      .map((t) => (t === "<w:tab/>" ? "\t" : t === "<w:br/>" ? "\n" : decodeEntities(t.replace(/<[^>]+>/g, ""))))
      .join("");
    if (text.trim()) paras.push(text);
  }
  let title = base;
  const core = zip.get("docProps/core.xml");
  if (core) {
    const m = core().toString("utf8").match(/<dc:title>([\s\S]*?)<\/dc:title>/);
    if (m && m[1].trim()) title = decodeEntities(m[1].trim());
  }
  return { title, type: "docx", sections: [{ text: normalizeText(paras.join("\n\n")), label: "" }] };
}

// ------------------------------------------------------------------ epub

/** @param {string} base @param {Buffer} data @returns {Extracted} */
function extractEpub(base, data) {
  const zip = readZip(data);
  const container = zip.get("META-INF/container.xml");
  if (!container) throw new Error(`${base}.epub has no META-INF/container.xml`);
  const opfPath = container().toString("utf8").match(/full-path="([^"]+)"/)?.[1];
  const opfEntry = opfPath && zip.get(opfPath);
  if (!opfPath || !opfEntry) throw new Error(`${base}.epub: package file not found`);
  const opf = opfEntry().toString("utf8");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  /** @type {Map<string,string>} */
  const manifest = new Map();
  for (const m of opf.match(/<item\b[^>]*>/g) || []) {
    const id = m.match(/\bid="([^"]+)"/)?.[1];
    const href = m.match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const title = decodeEntities(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1]?.trim() || base);
  /** @type {Section[]} */
  const sections = [];
  let n = 0;
  let total = 0;
  const seen = new Set();
  for (const ref of opf.match(/<itemref\b[^>]*>/g) || []) {
    const idref = ref.match(/idref="([^"]+)"/)?.[1];
    const href = idref && manifest.get(idref);
    const file = href && path.posix.normalize(dir + href);
    if (!file || seen.has(file)) continue; // each chapter once, however often the spine lists it
    seen.add(file);
    const entry = zip.get(file);
    if (!entry) continue;
    const html = entry().toString("utf8");
    const text = htmlToText(html);
    if (!text) continue;
    total += text.length;
    if (total > MAX_TEXT) throw new Error(`${base}.epub has more text than masterly reads from one file (20 million characters)`);
    n++;
    const heading = htmlTitle(html);
    sections.push({ text, label: heading ? `chapter ${n}: ${heading}` : `chapter ${n}` });
  }
  if (!sections.length) throw new Error(`${base}.epub contains no readable chapters`);
  return { title, type: "epub", sections };
}

// ------------------------------------------------------------------ pdf

/** @param {string} base @param {Buffer} data @returns {Promise<Extracted>} */
async function extractPdf(base, data) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  /** @type {Section[]} */
  const sections = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of /** @type {any[]} */ (content.items)) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
        else if (item.str && !text.endsWith(" ")) text += " ";
      }
      // join words split by a line-end hyphen: "photo-\nsynthesis" -> "photosynthesis"
      text = normalizeText(text.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2"));
      if (text) sections.push({ text, label: `page ${i}`, page: i });
      page.cleanup();
    }
    let title = base;
    try {
      const meta = await doc.getMetadata();
      const t = /** @type {any} */ (meta.info)?.Title;
      if (typeof t === "string" && t.trim()) title = t.trim();
    } catch {
      /* no metadata */
    }
    if (!sections.length) throw new Error(`${base}.pdf has no extractable text (it may be a scanned image; run OCR first)`);
    return { title, type: "pdf", sections };
  } finally {
    await doc.destroy();
  }
}
