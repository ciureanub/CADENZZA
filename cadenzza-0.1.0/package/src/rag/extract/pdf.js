/**
 * PDF via unpdf (pdf.js, pure JS). PDFs carry no structure, so it is rebuilt from layout:
 *   lines      items grouped by baseline
 *   headings   font size >= 1.15x the body size, short line; distinct sizes ranked into levels 1-3
 *   paragraphs consecutive lines with normal leading; de-hyphenated
 *   lists      lines starting with a bullet or "1." / "a)"
 *   chrome     lines repeated on >= half the pages (headers/footers) and bare page numbers dropped
 * Every block carries its 1-based page number for citations.
 * A document with almost no text is flagged needs_ocr (scanned); OCR itself is out of scope.
 */
import { getDocumentProxy, extractTextItems, getMeta } from 'unpdf';
import { titleFromFilename, blocksToHtml, HeadingTracker, squash, tidy, EXTRACTOR_VERSION } from './common.js';

const BULLET = /^\s*(?:[•◦▪●‣⁃∙·*\-–]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/;
const PAGE_NO = /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
const MIN_CHARS_PER_PAGE = 25;
const HEADING_RATIO = 1.15; // H3s are often ~1.15x body size

/** Group text items into lines: [{ text, size, y, x, page }] */
function toLines(items, page) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    const size = Math.abs(it.fontSize) || it.height || 0;
    if (cur && Math.abs(it.y - cur.y) > Math.max(size, cur.size) * 0.5) { lines.push(cur); cur = null; }
    if (!cur) cur = { text: '', size: 0, y: it.y, x: it.x, end: it.x, page };
    if (it.str) {
      const gap = it.x - cur.end;
      if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && gap > size * 0.15) cur.text += ' ';
      cur.text += it.str;
      cur.end = it.x + it.width;
      if (it.str.trim()) cur.size = Math.max(cur.size, size);
    }
    if (it.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ ...l, text: squash(l.text) })).filter((l) => l.text);
}

/** Text that repeats on many pages at the same spot: running headers and footers. */
function chromeKeys(pages) {
  if (pages.length < 3) return new Set();
  const seen = new Map();
  for (const lines of pages) {
    for (const k of new Set(lines.map((l) => l.text.replace(/\d+/g, '#')))) seen.set(k, (seen.get(k) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n >= Math.ceil(pages.length / 2)).map(([k]) => k));
}

/** Char-weighted most common font size = body size. */
function bodySize(lines) {
  const w = new Map();
  for (const l of lines) { const s = Math.round(l.size * 2) / 2; w.set(s, (w.get(s) || 0) + l.text.length); }
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

export async function extractPdf(buffer, filename) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, items } = await extractTextItems(pdf);
  const meta = { extractor: 'pdf', extractor_version: EXTRACTOR_VERSION, pages: totalPages, warnings: [] };

  const pages = items.map((pageItems, i) => toLines(pageItems, i + 1));
  const chars = pages.reduce((n, ls) => n + ls.reduce((m, l) => m + l.text.length, 0), 0);
  const empty = pages.map((ls, i) => (ls.length ? 0 : i + 1)).filter(Boolean);

  let info = {};
  try { ({ info } = await getMeta(pdf)); } catch { /* metadata is optional */ }
  const metaTitle = squash(info?.Title || '').replace(/^Microsoft (?:Word|PowerPoint) - /, '').replace(/\.(docx?|pptx?)$/i, '');

  if (chars < MIN_CHARS_PER_PAGE * Math.max(totalPages, 1)) {
    meta.needs_ocr = true;
    meta.warnings.push(`no usable text layer (${chars} chars over ${totalPages} page(s)) - scanned PDF? OCR is not supported in this release`);
    const title = metaTitle || titleFromFilename(filename);
    return { title, blocks: [], html: '', meta };
  }
  if (empty.length) meta.warnings.push(`page(s) without text: ${empty.join(', ')}`);

  const chrome = chromeKeys(pages);
  const lines = pages.flat().filter((l) => !PAGE_NO.test(l.text) && !chrome.has(l.text.replace(/\d+/g, '#')));
  const body = bodySize(lines);
  const headingSizes = [...new Set(lines.filter((l) => l.size >= body * HEADING_RATIO && l.text.length <= 150)
    .map((l) => Math.round(l.size * 2) / 2))].sort((a, b) => b - a);
  const levelOf = (l) => {
    if (l.size < body * HEADING_RATIO || l.text.length > 150) return 0;
    return Math.min(headingSizes.indexOf(Math.round(l.size * 2) / 2) + 1, 3) || 3;
  };

  const blocks = [];
  const hp = new HeadingTracker();
  let para = null;
  const close = () => { if (para) blocks.push(para); para = null; };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const level = levelOf(l);

    if (level) {
      // Multi-line headings: same size, same page, directly below.
      const last = blocks[blocks.length - 1];
      if (!para && last?.type === 'heading' && last.level === level && last.page === l.page && prev && levelOf(prev) === level
          && Math.abs(prev.y - l.y) <= l.size * 1.6) {
        last.text = `${last.text} ${l.text}`;
        hp.stack[hp.stack.length - 1].text = last.text;
        last.heading_path = hp.path();
        continue;
      }
      close();
      blocks.push({ type: 'heading', level, text: l.text, heading_path: hp.push(level, l.text), page: l.page });
      continue;
    }

    const bullet = BULLET.test(l.text);
    const sameFlow = para && prev && prev.page === l.page && Math.abs(prev.y - l.y) <= Math.max(l.size, prev.size) * 1.6;
    if (bullet) {
      if (!(para && para.type === 'list' && sameFlow)) { close(); para = { type: 'list', text: '', heading_path: hp.path(), page: l.page }; }
      para.text += `${para.text ? '\n' : ''}- ${l.text.replace(BULLET, '')}`;
      para.itemX = l.x;
      continue;
    }
    if (para && sameFlow && (para.type === 'paragraph' || (para.type === 'list' && l.x > para.itemX + 1))) {
      para.text = /[a-z]-$/.test(para.text) && /^[a-z]/.test(l.text) ? para.text.slice(0, -1) + l.text : `${para.text} ${l.text}`;
      continue;
    }
    close();
    para = { type: 'paragraph', text: l.text, heading_path: hp.path(), page: l.page };
  }
  close();

  const clean = tidy(blocks.map(({ itemX, ...b }) => b));
  const firstH1 = clean.find((b) => b.type === 'heading' && b.level === 1);
  const title = metaTitle || firstH1?.text || titleFromFilename(filename);
  return { title, blocks: clean, html: blocksToHtml(clean), meta };
}
