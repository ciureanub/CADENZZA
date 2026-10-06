import { db, audit } from './db/index.js';
import * as guard from './entity/guard.js';
import { canonicalSpace } from './config.js';

/** Cheap, dependency-free HTML -> text for indexing. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function spaces() {
  return db().prepare('SELECT * FROM space ORDER BY position').all();
}

export function spaceByKey(key) {
  return db().prepare('SELECT * FROM space WHERE key = ?').get(canonicalSpace(key));
}

export function tree(spaceKey) {
  return db().prepare(
    `SELECT p.id, p.parent_id, p.title, p.type, p.sensitivity, p.status, p.updated_at, p.position
       FROM page p JOIN space s ON s.id = p.space_id
      WHERE s.key = ? ORDER BY p.type DESC, p.position, p.title`
  ).all(canonicalSpace(spaceKey));
}

export function get(id) {
  const p = db().prepare(
    `SELECT p.*, s.key AS space_key, s.name AS space_name
       FROM page p JOIN space s ON s.id = p.space_id WHERE p.id = ?`
  ).get(id);
  if (!p) return null;
  p.tags = db().prepare('SELECT t.name FROM page_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.page_id = ? ORDER BY t.name').all(id).map((r) => r.name);
  p.occurrences = db().prepare(
    `SELECT o.*, e.pseudonym FROM entity_occurrence o
     LEFT JOIN protected_entity e ON e.id = o.entity_id
     WHERE o.page_id = ? ORDER BY o.status, o.surface`
  ).all(id);
  p.backlinks = db().prepare(
    `SELECT p2.id, p2.title FROM link l JOIN page p2 ON p2.id = l.src_page_id WHERE l.dst_page_id = ?`
  ).all(id);
  return p;
}

export function create({ space_key, parent_id = null, title = 'Untitled', body_html = '', type = 'note',
                         sensitivity = null, template_key = null, owner = null, tags = [] }) {
  const s = spaceByKey(space_key);
  if (!s) throw new Error(`unknown space: ${space_key}`);
  const info = db().prepare(
    `INSERT INTO page (space_id, parent_id, title, body_html, body_text, type, sensitivity, template_key, owner)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(s.id, parent_id, title, body_html, htmlToText(body_html), type,
        sensitivity || s.default_sensitivity, template_key, owner);
  const id = info.lastInsertRowid;
  for (const name of tags) {
    db().prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)').run(name);
    db().prepare('INSERT OR IGNORE INTO page_tag (page_id, tag_id) SELECT ?, id FROM tag WHERE name = ?').run(id, name);
  }
  guard.recordOccurrences(id, `${title}\n${htmlToText(body_html)}`);
  syncLinks(id, body_html);
  audit('page.create', `id=${id} title=${title}`);
  return get(id);
}

export function update(id, patch) {
  const before = db().prepare('SELECT * FROM page WHERE id = ?').get(id);
  if (!before) throw new Error('not found');
  if (patch.space !== undefined && !spaceByKey(patch.space)) throw new Error(`unknown space: ${patch.space}`);

  if (patch.body_html !== undefined || patch.title !== undefined) {
    db().prepare('INSERT INTO revision (page_id, title, body_html, note) VALUES (?, ?, ?, ?)')
      .run(id, before.title, before.body_html, patch.note || null);
  }

  const fields = ['title', 'body_html', 'type', 'sensitivity', 'owner', 'status', 'review_due', 'parent_id', 'position'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = ?`); vals.push(patch[f]); }
  }
  if (patch.body_html !== undefined) { sets.push('body_text = ?'); vals.push(htmlToText(patch.body_html)); }
  sets.push("updated_at = datetime('now')");
  db().prepare(`UPDATE page SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  if (patch.space !== undefined) moveToSpace(id, patch.space);

  const after = db().prepare('SELECT * FROM page WHERE id = ?').get(id);
  guard.recordOccurrences(id, `${after.title}\n${after.body_text}`);
  syncLinks(id, after.body_html);
  return get(id);
}

/** Move a page and its sub-pages to another space; the page becomes top-level there. */
function moveToSpace(id, spaceKey) {
  const s = spaceByKey(spaceKey);
  if (!s) throw new Error(`unknown space: ${spaceKey}`);
  const page = db().prepare('SELECT space_id FROM page WHERE id = ?').get(id);
  if (page.space_id === s.id) return;
  db().transaction(() => {
    db().prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id)
      UPDATE page SET space_id = ? WHERE id IN (SELECT id FROM sub)`).run(id, s.id);
    db().prepare('UPDATE page SET parent_id = NULL WHERE id = ?').run(id);
  })();
  audit('page.move', `id=${id} space=${s.key}`);
}

export function remove(id) {
  db().prepare('DELETE FROM page WHERE id = ?').run(id);
  audit('page.delete', `id=${id}`);
}

export function revisions(id) {
  return db().prepare(
    'SELECT id, title, note, origin, created_at FROM revision WHERE page_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(id);
}

export function revision(revId) {
  return db().prepare('SELECT * FROM revision WHERE id = ?').get(revId);
}

/** [[Wiki links]] -> resolvable backlinks. */
function syncLinks(pageId, html) {
  const d = db();
  d.prepare('DELETE FROM link WHERE src_page_id = ?').run(pageId);
  const titles = [...String(html || '').matchAll(/\[\[([^\]]{1,120})\]\]/g)].map((m) => m[1].trim());
  const ins = d.prepare('INSERT OR IGNORE INTO link (src_page_id, dst_title, dst_page_id) VALUES (?, ?, ?)');
  for (const t of new Set(titles)) {
    const dst = d.prepare('SELECT id FROM page WHERE title = ? COLLATE NOCASE').get(t);
    ins.run(pageId, t, dst ? dst.id : null);
  }
}
