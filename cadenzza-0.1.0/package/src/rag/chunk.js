/**
 * Heading-aware chunker: masked blocks -> retrieval-sized chunks.
 *
 *   sections  a heading starts a new section; chunks never span sections
 *   packing   blocks are packed greedily up to targetTokens
 *   splitting an oversized block is split by sentence (prose), line (list/code) or row (table);
 *             every table piece repeats the header row; a row is never split unless it alone is too big
 *   overlap   ~overlapRatio of the target is carried from the end of the previous chunk (not tables)
 *   prefix    embed_text = "Title > H1 > H2" breadcrumb + body; text = body only (for display)
 *
 * Token counts are estimates. Chars/token measured against the bge-m3 tokenizer on 2026-10-04:
 * EN prose 3.39, tables 2.56, code 3.0, DE/RO ~4.5. The divisors below sit under those,
 * so estimates run high and real chunks stay under target.
 */
import crypto from 'node:crypto';

export const CHUNKER_VERSION = '1.0.0';
export const DEFAULTS = { targetTokens: 450, overlapRatio: 0.15 };

const CPT = { table: 2.3, code: 2.3, list: 2.8, default: 3.0 };
const cpt = (type) => CPT[type] || CPT.default;
export const estimateTokens = (text, type) => Math.ceil(String(text).length / cpt(type));

const SEP = ' › ';
const SENTENCE = /(?<=[.!?…])\s+(?=["„(\[]?[\p{Lu}\d])/u;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------------ ids */

const NAMESPACE = Buffer.from('b3c1e7a25d4f4e8a9c217f0d3a6b9e14', 'hex');

/** RFC 4122 v5 UUID of `name` in the CADENZZA namespace. */
export function uuidv5(name) {
  const b = crypto.createHash('sha1').update(NAMESPACE).update(String(name)).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Deterministic chunk / Qdrant point id: UUIDv5(doc_id:chunk_index:chunk_sha256). */
export const chunkId = (docId, c) => uuidv5(`${docId}:${c.chunk_index}:${c.chunk_sha256}`);

/* ------------------------------------------------------------------ splitting */

/** Last-resort split by words into pieces of at most `target` estimated tokens. */
function hardSplit(text, type, target) {
  const max = Math.floor(target * cpt(type));
  const out = [];
  let cur = '';
  for (const w of text.split(/(\s+)/)) {
    if ((cur + w).length > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
    cur += w.length > max ? w.slice(0, max) : w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Pack parts (joined by `joiner`) into pieces <= target; parts that are too big are hard-split. */
function pack(parts, joiner, type, target, head = null) {
  const out = [];
  let cur = head ? [head] : [];
  const fits = (arr) => estimateTokens(arr.join(joiner), type) <= target;
  for (const p of parts) {
    if (fits([...cur, p])) { cur.push(p); continue; }
    if (cur.length > (head ? 1 : 0)) out.push(cur.join(joiner));
    cur = head ? [head] : [];
    if (fits([...cur, p])) { cur.push(p); continue; }
    for (const piece of hardSplit(p, type, target - (head ? estimateTokens(head, type) : 0))) {
      out.push((head ? [head, piece] : [piece]).join(joiner));
    }
  }
  if (cur.length > (head ? 1 : 0)) out.push(cur.join(joiner));
  return out;
}

/** A block -> one or more units, each <= target tokens. */
function units(block, target) {
  const unit = (text, extra = {}) => ({ type: block.type, text, page: block.page, tokens: estimateTokens(text, block.type), ...extra });
  if (estimateTokens(block.text, block.type) <= target) return [unit(block.text)];

  if (block.type === 'table') {
    const [head, ...rows] = block.text.split('\n');
    return pack(rows, '\n', 'table', target, head).map((t) => unit(t));
  }
  if (block.type === 'list' || block.type === 'code') {
    return pack(block.text.split('\n'), '\n', block.type, target).map((t) => unit(t));
  }
  return pack(block.text.split(SENTENCE), ' ', block.type, target).map((t) => unit(t));
}

/** Carry the tail of a chunk into the next one: whole units, else trailing sentences. */
function overlapTail(cur, budget) {
  const tail = [];
  let tok = 0;
  for (let i = cur.length - 1; i >= 0; i--) {
    const u = cur[i];
    if (u.type === 'table') break;
    if (tok + u.tokens <= budget) { tail.unshift({ ...u, overlap: true }); tok += u.tokens; continue; }
    if (!tail.length) {
      const sentences = u.text.split(SENTENCE);
      const picked = [];
      for (let j = sentences.length - 1; j > 0; j--) {
        const t = estimateTokens([sentences[j], ...picked].join(' '), u.type);
        if (t > budget) break;
        picked.unshift(sentences[j]);
      }
      if (picked.length) tail.unshift({ ...u, text: picked.join(' '), tokens: estimateTokens(picked.join(' '), u.type), overlap: true });
    }
    break;
  }
  return tail;
}

/* ------------------------------------------------------------------ chunk */

/**
 * @param {object[]} blocks  masked blocks from extract()
 * @param {object}   opts    { title, targetTokens, overlapRatio }
 * @returns chunk[] { chunk_index, heading_path, text, embed_text, page_start, page_end, block_types,
 *                    token_estimate, overlap_tokens, chunk_sha256, chunker_version }
 */
export function chunk(blocks, opts = {}) {
  const { title = '', targetTokens, overlapRatio } = { ...DEFAULTS, ...opts };

  // 1. sections
  const sections = [];
  let sec = null;
  for (const b of blocks) {
    const key = JSON.stringify(b.heading_path || []);
    if (b.type === 'heading' || !sec || sec.key !== key) {
      sec = { key, heading_path: b.heading_path || [], blocks: [] };
      sections.push(sec);
      if (b.type === 'heading') continue;
    }
    sec.blocks.push(b);
  }

  // 2. pack each section. Oversized blocks are split against the budget left after the
  //    breadcrumb *and* the overlap, so the carried tail always fits in front of the next piece.
  const chunks = [];
  const overlapBudget = Math.floor(targetTokens * overlapRatio);
  for (const s of sections) {
    const crumbs = [title, ...s.heading_path].filter((x, i, a) => x && x !== a[i - 1]);
    const prefix = crumbs.join(SEP);
    const budget = Math.max(targetTokens - estimateTokens(prefix), Math.ceil(targetTokens / 2));
    s.units = s.blocks.flatMap((b) => units(b, b.type === 'table' ? budget : budget - overlapBudget));
    let cur = [];
    const tokens = () => cur.reduce((n, u) => n + u.tokens, 0);
    const emit = () => {
      if (!cur.some((u) => !u.overlap)) return;
      const text = cur.map((u) => u.text).join('\n\n');
      const embed_text = prefix ? `${prefix}\n\n${text}` : text;
      const pages = cur.map((u) => u.page).filter((p) => p != null);
      chunks.push({
        chunk_index: chunks.length,
        heading_path: s.heading_path,
        text,
        embed_text,
        page_start: pages.length ? Math.min(...pages) : null,
        page_end: pages.length ? Math.max(...pages) : null,
        block_types: [...new Set(cur.filter((u) => !u.overlap).map((u) => u.type))],
        token_estimate: estimateTokens(prefix) + tokens(),
        overlap_tokens: cur.filter((u) => u.overlap).reduce((n, u) => n + u.tokens, 0),
        chunk_sha256: sha256(embed_text),
        chunker_version: CHUNKER_VERSION
      });
    };
    for (const u of s.units) {
      if (cur.length && tokens() + u.tokens > budget) {
        emit();
        cur = overlapTail(cur, overlapBudget);
        if (tokens() + u.tokens > budget) cur = [];
      }
      cur.push(u);
    }
    emit();
  }
  return chunks;
}
