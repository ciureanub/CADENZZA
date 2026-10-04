-- CADENZZA schema v1
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Migration tracking — managed by runMigrations() in db/index.js
-- Do not edit this table manually.
CREATE TABLE IF NOT EXISTS schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL DEFAULT ''
);

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
  type         TEXT NOT NULL DEFAULT 'note',      -- note | deliverable | template | source-capture
  sensitivity  TEXT NOT NULL DEFAULT 'Internal',  -- Public | Internal | Client-Confidential | Restricted
  template_key TEXT,
  owner        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',     -- draft | review | approved | archived
  review_due   TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_space  ON page(space_id);
CREATE INDEX IF NOT EXISTS idx_page_parent ON page(parent_id);

-- Strict search: FTS5 mirror kept in sync by triggers.
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
  origin     TEXT NOT NULL DEFAULT 'user',  -- user | radar | import
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revision_page ON revision(page_id, created_at DESC);

-- ---------- Entity Guard ----------

CREATE TABLE IF NOT EXISTS protected_entity (
  id          INTEGER PRIMARY KEY,
  canonical   TEXT UNIQUE NOT NULL,
  norm        TEXT NOT NULL,                     -- normalised match key
  type        TEXT NOT NULL DEFAULT 'org',       -- org | person | project | host | other
  aliases     TEXT NOT NULL DEFAULT '[]',        -- JSON array
  pseudonym   TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT 'coded',     -- coded | plausible
  origin      TEXT NOT NULL DEFAULT 'user',      -- seed | user | pattern | ner-accepted
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
  layer      TEXT NOT NULL,                      -- gazetteer | pattern | ner
  confidence REAL NOT NULL DEFAULT 1.0,
  status     TEXT NOT NULL DEFAULT 'confirmed',  -- candidate | confirmed | ignored
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_occ_page   ON entity_occurrence(page_id);
CREATE INDEX IF NOT EXISTS idx_occ_status ON entity_occurrence(status);

-- Vault: encrypted canonical<->pseudonym mapping. Never joined into any index.
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
