import { db } from '../db/index.js';

/* ---------------- field filters: space: tag: type: sensitivity: owner: before: after: ---------------- */

const FIELDS = ['space', 'tag', 'type', 'sensitivity', 'owner', 'status', 'before', 'after'];

export function parseQuery(raw) {
  const filters = {};
  const terms = [];
  for (const token of String(raw).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const m = token.match(/^([a-z]+):(.+)$/i);
    if (m && FIELDS.includes(m[1].toLowerCase())) {
      filters[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '');
    } else {
      terms.push(token);
    }
  }
  return { text: terms.join(' ').trim(), filters };
}

function whereClause(filters) {
  const where = [];
  const params = [];
  if (filters.space)       { where.push('s.key = ?');            params.push(filters.space); }
  if (filters.type)        { where.push('p.type = ?');           params.push(filters.type); }
  if (filters.sensitivity) { where.push('p.sensitivity = ?');    params.push(filters.sensitivity); }
  if (filters.owner)       { where.push('p.owner = ?');          params.push(filters.owner); }
  if (filters.status)      { where.push('p.status = ?');         params.push(filters.status); }
  if (filters.before)      { where.push('p.updated_at < ?');     params.push(filters.before); }
  if (filters.after)       { where.push('p.updated_at > ?');     params.push(filters.after); }
  if (filters.tag) {
    where.push('EXISTS (SELECT 1 FROM page_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.page_id = p.id AND t.name = ?)');
    params.push(filters.tag);
  }
  return { sql: where.length ? ' AND ' + where.join(' AND ') : '', params };
}

/* ---------------- strict: FTS5 + BM25 ---------------- */

const OPERATORS = /\b(AND|OR|NOT|NEAR)\b|["*^]|:/;

function toMatchExpr(text) {
  if (!text) return null;
  if (OPERATORS.test(text)) return text;
  return text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

export function strict(raw, limit = 50) {
  const { text, filters } = parseQuery(raw);
  const expr = toMatchExpr(text);
  if (!expr) return [];
  const { sql, params } = whereClause(filters);
  try {
    return db().prepare(
      `SELECT p.id, p.title, p.type, p.sensitivity, p.updated_at, s.key AS space,
              snippet(page_fts, 1, '<mark>', '</mark>', '…', 18) AS snippet,
              bm25(page_fts) AS score
         FROM page_fts
         JOIN page  p ON p.id = page_fts.rowid
         JOIN space s ON s.id = p.space_id
        WHERE page_fts MATCH ?${sql}
        ORDER BY score LIMIT ?`
    ).all(expr, ...params, limit).map((r, i) => ({ ...r, mode: 'strict', rank: i + 1 }));
  } catch {
    return []; // malformed FTS expression — fuzzy will still answer
  }
}

/* ---------------- fuzzy: trigram Jaccard + Levenshtein, no dependency ---------------- */

function trigrams(s) {
  const t = ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

export function levenshtein(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function fuzzy(raw, limit = 50) {
  const { text, filters } = parseQuery(raw);
  if (!text) return [];
  const { sql, params } = whereClause(filters);
  const rows = db().prepare(
    `SELECT p.id, p.title, p.type, p.sensitivity, p.updated_at, p.body_text, s.key AS space
       FROM page p JOIN space s ON s.id = p.space_id
      WHERE 1=1${sql}`
  ).all(...params);

  const qGrams = trigrams(text);
  const qTokens = text.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = rows.map((r) => {
    const titleScore = jaccard(qGrams, trigrams(r.title)) * 2.0;
    const bodyScore = jaccard(qGrams, trigrams((r.body_text || '').slice(0, 4000))) * 0.6;
    let lev = 0;
    for (const qt of qTokens) {
      if (qt.length < 4) continue;
      for (const tt of r.title.toLowerCase().split(/\s+/)) {
        if (levenshtein(qt, tt) <= 2) { lev = Math.max(lev, 0.8); break; }
      }
    }
    const score = titleScore + bodyScore + lev;
    const idx = (r.body_text || '').toLowerCase().indexOf(qTokens[0] || '');
    const snippet = idx >= 0
      ? '…' + (r.body_text || '').slice(Math.max(0, idx - 40), idx + 120).trim() + '…'
      : (r.body_text || '').slice(0, 140);
    return { id: r.id, title: r.title, type: r.type, sensitivity: r.sensitivity,
             updated_at: r.updated_at, space: r.space, snippet, score, mode: 'fuzzy' };
  }).filter((r) => r.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}

/* ---------------- hybrid: reciprocal rank fusion ---------------- */

/**
 * Reciprocal rank fusion of ranked lists. Each item needs an id (via idOf) and a 1-based rank;
 * returns merged items (first occurrence wins, later fields fill gaps) with rrf and modes[].
 * Shared by page search and RAG chunk retrieval.
 */
export function rrf(lists, { k = 60, idOf = (r) => r.id } = {}) {
  const acc = new Map();
  for (const list of lists) {
    for (const r of list) {
      const id = idOf(r);
      const cur = acc.get(id) || { ...r, rrf: 0, modes: [] };
      cur.rrf += 1 / (k + r.rank);
      cur.modes.push(r.mode);
      for (const [f, v] of Object.entries(r)) if (cur[f] == null && v != null) cur[f] = v;
      acc.set(id, cur);
    }
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

export function hybrid(raw, limit = 50, k = 60) {
  return rrf([strict(raw, limit), fuzzy(raw, limit)], { k })
    .slice(0, limit)
    .map((r, i) => ({ ...r, mode: 'hybrid', rank: i + 1 }));
}

export function search(raw, mode = 'hybrid', limit = 50) {
  if (mode === 'strict') return strict(raw, limit);
  if (mode === 'fuzzy') return fuzzy(raw, limit);
  return hybrid(raw, limit);
}
