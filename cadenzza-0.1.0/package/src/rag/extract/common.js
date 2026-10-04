/**
 * Shared pieces for the extractors.
 *
 * A block is the unit every extractor emits:
 *   { type: 'heading'|'paragraph'|'list'|'table'|'code'|'note', text, level?, heading_path: string[], page? }
 * heading_path is the chain of headings in force for the block (a heading includes itself).
 * Tables are text rows joined with " | ", one row per line, so the chunker can keep rows whole.
 */

export const EXTRACTOR_VERSION = '1.0.0';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
  middot: '·', euro: '€', copy: '©', reg: '®', trade: '™', deg: '°',
  laquo: '«', raquo: '»', times: '×', rarr: '→', larr: '←', shy: ''
};

/** Decode HTML/XML character references. Unknown named entities are left as-is. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Collapse runs of whitespace (incl. nbsp) to one space and trim. */
export const squash = (s) => String(s).replace(/[\s ]+/g, ' ').trim();

/** Bytes -> string. Honours a BOM, then the declared charset, then sniffs UTF-8 vs windows-1252. */
export function decodeBytes(buf, charset = null) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (charset) {
    try { return new TextDecoder(charset.toLowerCase()).decode(buf); } catch { /* unknown label: sniff */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Title from a filename: "release_notes-v2.docx" -> "release notes v2". */
export const titleFromFilename = (filename) => String(filename).replace(/\.[^.]+$/, '')
  .replace(/[_+\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Tracks the heading path while blocks are emitted in document order.
 * push(level, text) for a heading; path() for everything else.
 */
export class HeadingTracker {
  constructor() { this.stack = []; }
  push(level, text) {
    this.stack = this.stack.filter((h) => h.level < level);
    this.stack.push({ level, text });
    return this.path();
  }
  path() { return this.stack.map((h) => h.text); }
}

/** Render blocks back to safe HTML, for the wiki page that mirrors an ingested file. */
export function blocksToHtml(blocks) {
  const out = [];
  for (const b of blocks) {
    const t = escapeHtml(b.text);
    const h = Math.min(Math.max(b.level || 2, 1), 6);
    switch (b.type) {
      case 'heading': out.push(`<h${h}>${t}</h${h}>`); break;
      case 'list': out.push(`<ul>${b.text.split('\n').map((l) => `<li>${escapeHtml(l.replace(/^\s*[-*•]\s*/, ''))}</li>`).join('')}</ul>`); break;
      case 'table': out.push(`<table><tbody>${b.text.split('\n').map((r) =>
        `<tr>${r.split(' | ').map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); break;
      case 'code': out.push(`<pre><code>${t}</code></pre>`); break;
      case 'note': out.push(`<blockquote>${t}</blockquote>`); break;
      default: out.push(`<p>${t.replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** Drop empty blocks and squash text (except code/table/list, whose newlines carry structure). */
export function tidy(blocks) {
  return blocks
    .map((b) => ({ ...b, text: ['code', 'table', 'list'].includes(b.type)
      ? b.text.split('\n').map((l) => l.replace(/[ \t ]+$/g, '')).filter((l) => l.trim()).join('\n')
      : squash(b.text) }))
    .filter((b) => b.text);
}
