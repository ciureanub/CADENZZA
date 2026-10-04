/**
 * HTML -> blocks. Also the shared back end for MHTML, DOCX (via mammoth) and Markdown (via marked).
 * extractBody/sanitiseHtml moved here from server/importer.js unchanged in behaviour.
 */
import { decodeBytes, decodeEntities, squash, titleFromFilename, HeadingTracker, tidy, EXTRACTOR_VERSION } from './common.js';

/** Pull <body>, drop head/script/style/nav and Confluence chrome; title from the first <h1>. */
export function extractBody(html) {
  let out = html;
  const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) out = bodyMatch[1];

  out = out
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<div[^>]+id=["'][^"']*(?:breadcrumb|sidebar|footer|header|nav|menu)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]+class=["'][^"']*(?:breadcrumb|sidebar|footer|header|nav|menu)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

  const h1 = out.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? squash(decodeEntities(h1[1].replace(/<[^>]+>/g, ' '))) : '';
  return { title, html: sanitiseHtml(out).trim() };
}

/** Strip event handlers, javascript: links, external src, <link>, <meta>. */
export function sanitiseHtml(html) {
  return html
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["'](?!data:image)[^"']*["']/gi, 'src=""')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'title', 'object', 'iframe']);
const BREAK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'blockquote',
  'figure', 'figcaption', 'caption', 'dl', 'dt', 'dd', 'hr', 'address', 'center', 'form', 'fieldset']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'wbr', 'area', 'base', 'source']);

/**
 * Walk HTML in document order and emit blocks. Lists and tables become single blocks
 * (lines / " | "-joined rows) so the chunker can treat them as units.
 */
export function htmlToBlocks(html, { page } = {}) {
  const blocks = [];
  const hp = new HeadingTracker();
  const at = page == null ? {} : { page };
  let buf = '';
  let skip = 0;
  let heading = 0;
  let pre = 0;
  let listDepth = 0, listLines = [], item = null;
  let tableDepth = 0, rows = [], row = null;

  const emit = (type, text, extra = {}) => blocks.push({ type, text, heading_path: hp.path(), ...at, ...extra });
  const flush = () => {
    if (buf.trim() && !listDepth && !tableDepth) emit(pre ? 'code' : 'paragraph', buf);
    buf = '';
  };
  const endItem = () => {
    if (item && squash(buf)) listLines.push(`${'  '.repeat(item.depth)}- ${squash(buf)}`);
    buf = '';
    item = null;
  };

  for (const tok of String(html).split(/(<!--[\s\S]*?-->|<[^>]*>)/)) {
    if (!tok) continue;
    if (tok[0] !== '<' || tok.startsWith('<!--') || tok.startsWith('<!')) {
      if (!skip && tok[0] !== '<') buf += decodeEntities(tok);
      continue;
    }
    const m = tok.match(/^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)/);
    if (!m) continue;
    const close = !!m[1];
    const tag = m[2].toLowerCase();

    if (SKIP.has(tag)) { if (!VOID.has(tag) && !tok.endsWith('/>')) skip += close ? -1 : 1; skip = Math.max(skip, 0); continue; }
    if (skip) continue;

    if (tag === 'br') { buf += pre ? '\n' : ' '; continue; }

    if (tableDepth && !(tag === 'table' || ((tag === 'tr' || tag === 'td' || tag === 'th') && tableDepth === 1))) {
      buf += ' '; // anything nested in a cell is just text
      continue;
    }

    if (/^h[1-6]$/.test(tag) && !listDepth) {
      if (!close) { flush(); heading = Number(tag[1]); }
      else if (heading) {
        const text = squash(buf);
        buf = '';
        if (text) blocks.push({ type: 'heading', level: heading, text, heading_path: hp.push(heading, text), ...at });
        heading = 0;
      }
      continue;
    }

    switch (tag) {
      case 'pre':
        if (!close) { flush(); pre++; } else { if (buf.trim() && !listDepth) emit('code', buf.replace(/^\n+|\s+$/g, '')); buf = ''; pre = Math.max(pre - 1, 0); }
        break;
      case 'ul': case 'ol':
        if (!close) {
          if (!listDepth) flush(); else if (item) endItem();
          listDepth++;
        } else {
          if (item) endItem();
          listDepth = Math.max(listDepth - 1, 0);
          if (!listDepth && listLines.length) { emit('list', listLines.join('\n')); listLines = []; }
        }
        break;
      case 'li':
        if (!listDepth) { flush(); break; }
        if (!close) { if (item) endItem(); item = { depth: listDepth - 1 }; } else endItem();
        break;
      case 'table':
        if (!close) { if (!tableDepth) { flush(); rows = []; } tableDepth++; }
        else {
          tableDepth = Math.max(tableDepth - 1, 0);
          if (!tableDepth) { if (row) { rows.push(row); row = null; } emitTable(); buf = ''; }
        }
        break;
      case 'tr':
        if (!close) { if (row) rows.push(row); row = []; } else if (row) { rows.push(row); row = null; }
        break;
      case 'td': case 'th':
        if (!close) buf = ''; else { (row ||= []).push(squash(buf)); buf = ''; }
        break;
      default:
        if (BREAK.has(tag)) { if (listDepth) buf += ' '; else flush(); }
    }
  }
  flush();
  if (listLines.length) emit('list', listLines.join('\n'));
  return tidy(blocks);

  function emitTable() {
    const lines = rows.filter((r) => r.some((c) => c)).map((r) => r.join(' | '));
    if (lines.length) emit('table', lines.join('\n'));
    rows = [];
  }
}

/** Plain or Word-saved HTML file. */
export function extractHtml(buffer, filename) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const cs = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  return fromHtmlString(decodeBytes(buffer, cs && cs[1]), filename, 'html');
}

/** Shared by html / mhtml / docx / md: sanitise, split into blocks, pick a title. */
export function fromHtmlString(html, filename, extractor, extraMeta = {}) {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const body = extractBody(html);
  const blocks = htmlToBlocks(body.html);
  const title = body.title || (titleTag && squash(decodeEntities(titleTag[1]))) || titleFromFilename(filename);
  return { title, blocks, html: body.html, meta: { extractor, extractor_version: EXTRACTOR_VERSION, warnings: [], ...extraMeta } };
}
