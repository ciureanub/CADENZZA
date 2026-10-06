import Database from 'better-sqlite3';
import { paths, SPACES, DEFAULT_SETTINGS } from '../config.js';

/* MIGRATIONS below is the single source of truth for the schema. */
let _db = null;

export function db() {
  if (_db) return _db;
  _db = new Database(paths.db);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  runMigrations(_db);
  return _db;
}

/* ------------------------------------------------------------------ */
/* Versioned migration runner                                          */
/* ------------------------------------------------------------------ */

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema: spaces, pages, FTS5, tags, links, revisions, entity guard, vault, audit',
    up(d) {
      d.exec(`
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS space (
  id                  INTEGER PRIMARY KEY,
  key                 TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  glyph               TEXT NOT NULL DEFAULT '',
  default_sensitivity TEXT NOT NULL DEFAULT 'Internal',
  position            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS page (
  id           INTEGER PRIMARY KEY,
  space_id     INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES page(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT 'Untitled',
  body_html    TEXT NOT NULL DEFAULT '',
  body_text    TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'note',
  sensitivity  TEXT NOT NULL DEFAULT 'Internal',
  template_key TEXT,
  owner        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
  review_due   TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_space  ON page(space_id);
CREATE INDEX IF NOT EXISTS idx_page_parent ON page(parent_id);

CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
  title, body_text, content='page', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS page_ai AFTER INSERT ON page BEGIN
  INSERT INTO page_fts(rowid, title, body_text) VALUES (new.id, new.title, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS page_ad AFTER DELETE ON page BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, body_text) VALUES ('delete', old.id, old.title, old.body_text);
END;
CREATE TRIGGER IF NOT EXISTS page_au AFTER UPDATE ON page BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, body_text) VALUES ('delete', old.id, old.title, old.body_text);
  INSERT INTO page_fts(rowid, title, body_text) VALUES (new.id, new.title, new.body_text);
END;

CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS page_tag (
  page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (page_id, tag_id)
);

CREATE TABLE IF NOT EXISTS link (
  src_page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  dst_title   TEXT NOT NULL,
  dst_page_id INTEGER REFERENCES page(id) ON DELETE SET NULL,
  PRIMARY KEY (src_page_id, dst_title)
);

CREATE TABLE IF NOT EXISTS revision (
  id         INTEGER PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  note       TEXT,
  origin     TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revision_page ON revision(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS protected_entity (
  id          INTEGER PRIMARY KEY,
  canonical   TEXT UNIQUE NOT NULL,
  norm        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'org',
  aliases     TEXT NOT NULL DEFAULT '[]',
  pseudonym   TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT 'coded',
  origin      TEXT NOT NULL DEFAULT 'user',
  sensitivity TEXT NOT NULL DEFAULT 'Client-Confidential',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_norm ON protected_entity(norm);

CREATE TABLE IF NOT EXISTS entity_occurrence (
  id         INTEGER PRIMARY KEY,
  entity_id  INTEGER REFERENCES protected_entity(id) ON DELETE CASCADE,
  page_id    INTEGER REFERENCES page(id) ON DELETE CASCADE,
  surface    TEXT NOT NULL,
  layer      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  status     TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_occ_page   ON entity_occurrence(page_id);
CREATE INDEX IF NOT EXISTS idx_occ_status ON entity_occurrence(status);

CREATE TABLE IF NOT EXISTS vault_entry (
  entity_id  INTEGER PRIMARY KEY REFERENCES protected_entity(id) ON DELETE CASCADE,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_event (
  id     INTEGER PRIMARY KEY,
  ts     TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_event(ts DESC);
      `);
    }
  },
  {
    version: 2,
    description: 'entity_occurrence.doc_id: review-queue entries for RAG documents without a page',
    up(d) {
      d.exec(`
ALTER TABLE entity_occurrence ADD COLUMN doc_id TEXT;
CREATE INDEX IF NOT EXISTS idx_occ_doc ON entity_occurrence(doc_id);
      `);
    }
  },
  {
    version: 3,
    description: 'Merge the Deployment Management space into Release Management',
    up(d) { mergeSpace(d, 'deployment'); }
  },
  {
    version: 4,
    description: 'Merge Environment and Stakeholder Management into Release Management; tag pages with their former space',
    up(d) {
      mergeSpace(d, 'environment');
      mergeSpace(d, 'stakeholder');
      // Databases where v3 ran before it tagged: the seeded Deployment templates are recognisable by template key.
      const keys = ['deployment-runbook', 'delta-manifest', 'pipeline-definition', 'smoke-checklist', 'change-record'];
      for (const { id } of d.prepare(`SELECT id FROM page WHERE template_key IN (${keys.map(() => '?').join(',')})`).all(...keys)) tagPage(d, id, 'deployment');
    }
  }
];

function tagPage(d, pageId, name) {
  d.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)').run(name);
  d.prepare('INSERT OR IGNORE INTO page_tag (page_id, tag_id) SELECT ?, id FROM tag WHERE name = ?').run(pageId, name);
}

/**
 * Move every page of space `fromKey` (sub-pages included, hierarchy kept) into Release, after the existing
 * top-level Release pages, tag each with `fromKey` so the former grouping stays searchable (tag:<key>),
 * delete the space and renumber the rest. No-op when the space does not exist (fresh database).
 */
function mergeSpace(d, fromKey) {
  const from = d.prepare('SELECT id FROM space WHERE key = ?').get(fromKey);
  if (!from) return;
  const relId = d.prepare("SELECT id FROM space WHERE key = 'release'").get()?.id
    ?? d.prepare("INSERT INTO space (key, name, glyph, position) VALUES ('release', 'Release Management', 'RM', 1)").run().lastInsertRowid;
  for (const { id } of d.prepare('SELECT id FROM page WHERE space_id = ?').all(from.id)) tagPage(d, id, fromKey);
  const offset = d.prepare('SELECT COALESCE(MAX(position), 0) m FROM page WHERE space_id = ? AND parent_id IS NULL').get(relId).m;
  d.prepare('UPDATE page SET space_id = ?, position = position + CASE WHEN parent_id IS NULL THEN ? ELSE 0 END WHERE space_id = ?')
    .run(relId, offset + 1, from.id);
  d.prepare('DELETE FROM space WHERE id = ?').run(from.id);
  d.prepare('SELECT id FROM space ORDER BY position, id').all()
    .forEach((s, i) => d.prepare('UPDATE space SET position = ? WHERE id = ?').run(i + 1, s.id));
}

function runMigrations(d) {
  // Always ensure the migration-tracking table exists first.
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL DEFAULT ''
    )
  `);

  const applied = new Set(
    d.prepare('SELECT version FROM schema_migration').all().map((r) => r.version)
  );

  for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;

    d.transaction(() => {
      migration.up(d);
      d.prepare(
        'INSERT INTO schema_migration (version, description) VALUES (?, ?)'
      ).run(migration.version, migration.description);
    })();
  }

  /* ---- seed spaces ---- */
  const insSpace = d.prepare(
    'INSERT OR IGNORE INTO space (key, name, glyph, position) VALUES (?, ?, ?, ?)'
  );
  for (const s of SPACES) insSpace.run(s.key, s.name, s.glyph, s.position);

  /* ---- seed default settings ---- */
  const insSetting = d.prepare('INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, String(v));
}

/* ------------------------------------------------------------------ */
/* Public helpers                                                      */
/* ------------------------------------------------------------------ */

export function getSetting(key, fallback = null) {
  const row = db().prepare('SELECT value FROM setting WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db().prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function audit(action, detail = null) {
  db().prepare('INSERT INTO audit_event (action, detail) VALUES (?, ?)')
    .run(action, detail == null ? null : String(detail));
}

export function close() {
  if (_db) { _db.close(); _db = null; }
}
