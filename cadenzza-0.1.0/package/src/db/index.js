import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, SPACES, DEFAULT_SETTINGS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  }
  // Future migrations go here, e.g.:
  // { version: 2, description: '...', up(d) { d.exec(`ALTER TABLE ...`); } }
];

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
