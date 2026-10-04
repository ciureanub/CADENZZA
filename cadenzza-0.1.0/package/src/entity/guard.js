import { db, audit, getSetting } from '../db/index.js';
import * as vault from './vault.js';
import { detectPatterns } from './patterns.js';

/* ------------------------------------------------------------------ */
/* Normalisation & surface variants                                    */
/* ------------------------------------------------------------------ */

/** Collapse everything that varies between spellings: "E.ON" / "E-ON" / "e on" -> "eon" */
export function normalise(s) {
  return String(s).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const LEGAL_SUFFIX = /\s+(?:SE|AG|GmbH|S\.?A\.?|SRL|S\.?R\.?L\.?|PLC|N\.?V\.?|S\.?p\.?A\.?|Ltd|Limited|Inc|LLC|B\.?V\.?|Oy|AB|A\/S)\.?$/i;

/** Generate the written forms a single entity realistically appears in. */
export function variants(canonical, aliases = []) {
  const out = new Set();
  const seeds = [canonical, canonical.replace(LEGAL_SUFFIX, ''), ...aliases]
    .map((s) => String(s).trim()).filter(Boolean);

  for (const seed of seeds) {
    out.add(seed);
    out.add(seed.replace(/[.\-_'’]/g, ''));      // E.ON -> EON
    out.add(seed.replace(/[.\-_'’]/g, ' ').replace(/\s+/g, ' ').trim()); // E.ON -> E ON
    out.add(seed.replace(/[.\s_'’]+/g, '-'));    // E.ON -> E-ON
  }
  return [...out].filter((v) => normalise(v).length >= 2);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ */
/* Pseudonym allocation                                                */
/* ------------------------------------------------------------------ */

const PREFIX = { org: 'CLIENT', person: 'PERSON', project: 'PROJECT', host: 'HOST', other: 'REF' };

function letters(n) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function nextPseudonym(type) {
  const prefix = PREFIX[type] || PREFIX.other;
  const used = db().prepare('SELECT COUNT(*) c FROM protected_entity WHERE type = ?').get(type).c;
  const suffix = type === 'org' ? letters(used) : String(used + 1).padStart(2, '0');
  let candidate = `${prefix}_${suffix}`;
  let n = used;
  while (db().prepare('SELECT 1 FROM protected_entity WHERE pseudonym = ?').get(candidate)) {
    n += 1;
    candidate = `${prefix}_${type === 'org' ? letters(n) : String(n + 1).padStart(2, '0')}`;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

let _compiled = null;
export function invalidate() { _compiled = null; }

export function addEntity({ canonical, type = 'org', aliases = [], style = null, origin = 'user', sensitivity = 'Client-Confidential' }) {
  canonical = String(canonical).trim();
  if (!canonical) throw new Error('canonical required');
  const existing = db().prepare('SELECT * FROM protected_entity WHERE norm = ?').get(normalise(canonical));
  if (existing) return existing;

  const pseudonym = nextPseudonym(type);
  const info = db().prepare(
    `INSERT INTO protected_entity (canonical, norm, type, aliases, pseudonym, style, origin, sensitivity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(canonical, normalise(canonical), type, JSON.stringify(aliases),
        pseudonym, style || getSetting('pseudonym_style', 'coded'), origin, sensitivity);

  vault.store(info.lastInsertRowid, canonical);
  audit('entity.add', `${pseudonym} type=${type} origin=${origin}`);
  invalidate();
  return db().prepare('SELECT * FROM protected_entity WHERE id = ?').get(info.lastInsertRowid);
}

export function listEntities() {
  return db().prepare('SELECT * FROM protected_entity WHERE active = 1 ORDER BY type, pseudonym').all()
    .map((e) => ({ ...e, aliases: JSON.parse(e.aliases) }));
}

export function removeEntity(id) {
  db().prepare('UPDATE protected_entity SET active = 0 WHERE id = ?').run(id);
  audit('entity.retire', `id=${id}`);
  invalidate();
}

/**
 * Permanently destroy an entity and its vault entry.
 * After this, any pseudonym already present in page content can never be
 * unmasked. Use only when required for compliance (right-to-erasure).
 * Requires explicit intent — callers must pass { confirm: true }.
 */
export function purgeEntity(id, { confirm = false } = {}) {
  if (!confirm) throw new Error('purgeEntity requires { confirm: true }');
  const e = db().prepare('SELECT pseudonym FROM protected_entity WHERE id = ?').get(id);
  if (!e) return;
  db().prepare('DELETE FROM protected_entity WHERE id = ?').run(id);
  audit('entity.purge', `id=${id} pseudonym=${e.pseudonym} — vault entry destroyed`);
  invalidate();
}

/** Compile all variants into one alternation, longest-first so the greediest form wins. */
function compiled() {
  if (_compiled) return _compiled;
  const map = new Map();
  const all = [];
  for (const e of listEntities()) {
    for (const v of variants(e.canonical, e.aliases)) {
      map.set(normalise(v), e);
      all.push(v);
    }
  }
  if (!all.length) { _compiled = { re: null, map }; return _compiled; }
  all.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${all.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi');
  _compiled = { re, map };
  return _compiled;
}

/* ------------------------------------------------------------------ */
/* The masking boundary — every outbound path goes through this        */
/* ------------------------------------------------------------------ */

/** Replace known entities with their pseudonyms, plus auto-maskable pattern hits. */
export function mask(text) {
  if (text == null) return text;
  let out = String(text);

  // 1. Structural rules first. An email or hostname is masked as one unit, otherwise
  //    the gazetteer would rewrite the domain inside it and leak the local part
  //    (bogdan@eon.com -> bogdan@CLIENT_A still exposes the person).
  for (const hit of detectPatterns(out).filter((h) => h.autoMask).reverse()) {
    const label = `${(PREFIX[hit.type] || 'REF')}_${hit.rule.toUpperCase().replace(/-/g, '_')}`;
    out = out.slice(0, hit.start) + `[${label}]` + out.slice(hit.end);
  }

  // 2. Gazetteer over what remains.
  const { re, map } = compiled();
  if (re) {
    out = out.replace(re, (m) => {
      const e = map.get(normalise(m));
      return e ? e.pseudonym : m;
    });
  }
  return out;
}

/** Recursively mask strings inside any JSON-serialisable payload. */
export function maskDeep(value) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  }
  return value;
}

/** Local-only reverse mapping. Logged. */
export function unmask(text, reason = 'user request') {
  let out = String(text);
  // Query ALL entities regardless of active status — retired entities must still
  // be resolvable for historical pages that were written before retirement.
  const all = db().prepare('SELECT id, pseudonym FROM protected_entity').all();
  for (const e of all) {
    const real = vault.reveal(e.id, reason);
    if (real) out = out.replaceAll(e.pseudonym, real);
  }
  return out;
}

/** Detection report for a body of text — gazetteer hits plus candidates for triage. */
export function scanText(text) {
  const found = [];
  const { re, map } = compiled();
  if (re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const e = map.get(normalise(m[0]));
      if (e) found.push({ layer: 'gazetteer', entityId: e.id, pseudonym: e.pseudonym, surface: m[0], start: m.index, confidence: 1 });
    }
  }
  const covered = (i, j) => found.some((f) => i < f.start + f.surface.length && j > f.start);
  for (const h of detectPatterns(text)) {
    if (covered(h.start, h.end)) continue;
    found.push({
      layer: 'pattern', rule: h.rule, type: h.type, surface: h.surface,
      start: h.start, confidence: h.autoMask ? 0.95 : 0.6,
      status: h.autoMask ? 'confirmed' : 'candidate'
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Persist what was found so the review queue has something to show. Keyed by page, or by
 * RAG document id ({ docId }) for ingested files that have no page; replaces earlier rows.
 */
export function recordOccurrences(pageId, text, { docId = null } = {}) {
  const d = db();
  d.transaction(() => {
    if (docId) d.prepare('DELETE FROM entity_occurrence WHERE doc_id = ?').run(docId);
    else d.prepare('DELETE FROM entity_occurrence WHERE page_id = ? AND doc_id IS NULL').run(pageId);
  })();
  const ins = d.prepare(
    `INSERT INTO entity_occurrence (entity_id, page_id, doc_id, surface, layer, confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const hits = scanText(text);
  d.transaction(() => {
    for (const h of hits) {
      ins.run(h.entityId ?? null, pageId ?? null, docId, h.surface, h.layer, h.confidence,
              h.status || (h.layer === 'gazetteer' ? 'confirmed' : 'candidate'));
    }
  })();
  return hits;
}

/** Forget a RAG document's review-queue rows (on delete). */
export function clearDocOccurrences(docId) {
  db().prepare('DELETE FROM entity_occurrence WHERE doc_id = ?').run(docId);
}

/**
 * Egress assertion. Throws if any real entity string survives into an outbound payload.
 * Used by the export path and by the test suite; wire it into every future network call.
 */
export function assertClean(payload, where = 'egress') {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const e of listEntities()) {
    for (const v of variants(e.canonical, e.aliases)) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(v)}(?![A-Za-z0-9_])`, 'i');
      if (re.test(s)) {
        audit('egress.blocked', `${where}: ${e.pseudonym}`);
        throw new Error(`Entity Guard: protected entity leaked at ${where} (${e.pseudonym})`);
      }
    }
  }
  return true;
}
