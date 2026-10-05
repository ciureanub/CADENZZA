# CADENZZA 0.1.0 — Phase 0 assessment

Date: 2026-10-04. Line references are to the baseline commit ("Baseline: cadenzza 0.1.0 as found").
Status column: **fixed** = fixed in Phase 0, **planned** = scheduled in a later phase, **ok** = confirmed as described.

## 1. Confirmed as described in the upgrade brief

| Area | Evidence | Status |
|---|---|---|
| Node ≥ 20, ESM, fastify 5, better-sqlite3, commander | `package.json`; machine has v22.18.0 | ok |
| CLI: init, serve, entities, mask, scan, search, doctor | `bin/cadenzza.js:19-149` | ok |
| `CADENZZA_HOME` else `~/.cadenzza`; `chat_mode: 'private'`, `offline: '1'` | `src/config.js:6-9`, `:38-43` | ok |
| Versioned migrations, v1 only | `src/db/index.js:23-155` | ok |
| Importer formats: mhtml/mht, html/htm, md (regex), txt, .doc only if MHTML | `src/server/importer.js:165-219` | ok |
| `/api/upload` allow-list omits docx/doc/html | `src/server/index.js:270` | fixed (Phase 2): + doc/docx/pptx/html/mhtml |
| `/api/import` comment claims `.docx` | `src/server/index.js:218` | fixed |
| `mdToHtml` wraps each `<li>` in its own `<ul>` | `src/server/importer.js:145-146` | fixed (Phase 2): `marked` |
| `POST /api/settings` persists unknown keys | `src/server/index.js:75-78` | ok; RAG keys go into `VALID_SETTINGS` (Phase 4/6) |
| UI: single file, system fonts, no external URLs, `PRIVATE` badge | `web/index.html:114`, `:142`; 28 inline `onclick` | ok |
| Ollama 0.30.8, `gemma4:latest`, bound to `127.0.0.1:11434` | `ollama list`, `netstat` | ok |
| WSL2 Ubuntu present (stopped); no docker / mongod / qdrant | `wsl -l -v`, `Get-Command` | ok |

## 2. Corrections to the brief

| # | Brief said | Actually | Status |
|---|---|---|---|
| C1 | `npm test` fails (no `test/`) | It **passed with 0 tests** (`1..0`, exit 0) — a false green | fixed: 42 tests; script now `node --test "test/**/*.test.js"` |
| C2 | `/api/import` JSON branch reads any path | Confirmed (`index.js:246-255`). Also: multipart branch only ever read the **first** file (`:225`, `req.file` is always truthy), and multipart parse errors surfaced as **500** | fixed: JSON path confined to `CADENZZA_HOME\import\` (traversal, absolute-elsewhere and junction escapes → 403, no existence oracle); multipart handles every file with per-file `failed[]` |
| C3 | `schema.sql` duplicates v1 and can drift | It is **referenced nowhere** — dead file; `__dirname`, `fs`, `path` imports in `db/index.js` unused | fixed: deleted; migrations are the single source of truth |
| C4 | Stray `web/index-*.html` fragments | `index-fix.html` is a leftover `sed` command; `index-new.html` is `PLACEHOLDER_FOR_FILE` | fixed: deleted (user-approved) |
| C5 | MongoDB local vector search: Community ≥ 8.2 + mongot in WSL2 | Needs **mongod ≥ 8.3.4 + mongot ≥ 1.70.1** (GA), replica set + keyfile; **native Windows and WSL are listed as unsupported** | Decision: option (c) — native Windows mongod, record-only; Qdrant sole ANN; exact kNN in Node as eval baseline |
| C6 | `CADENZZA_HOME` next to the source | `CADENZZA_HOME = C:\E.ON\cadenzza` **is** the repo root, so `backup/`, `import/`, `rag/` land there too | fixed: all in `.gitignore`; training-doc extensions ignored repo-wide except `test/fixtures/` |

## 3. New defects found

| # | Where | Defect | Status |
|---|---|---|---|
| N1 | `src/entity/patterns.js:17-19` | `salesforce-id` auto-masked ordinary words ("accomplishments", "administrations" → `[REF_SALESFORCE_ID]`). Would corrupt training text before embedding | fixed: require ≥ 2 digits |
| N1b | same | 18-char IDs with digits in the checksum (`…YA0`) were **not masked** — suffix allowed letters only; real suffix alphabet is `A-Z0-5`. A leak | fixed |
| N2 | `patterns.js:25` | `jira-key` raises `UTF-8`, `SHA-256`, `ISO-27001` as candidates → review-queue flood at RAG volume | fixed (Phase 3): standards/encodings denylist |
| N3 | `importer.js:62-66`, `:167` | QP decode is byte-wise: `M=C3=BCnchen` → `MÃ¼nchen`. cp1252 decode runs on a string already decoded as UTF-8, so it never works. Hits DE/RO content | fixed (Phase 2): byte-level QP + charset decode in `src/rag/extract/mhtml.js` |
| N4 | `guard.js:207-222`, `server/index.js:175` | Occurrences keyed by `page_id`; review queue `JOIN page`. RAG docs without a page would have invisible, never-deleted occurrences (`DELETE … WHERE page_id = NULL` matches nothing) | fixed (Phase 3): migration v2 `doc_id`; review queue LEFT JOIN |
| N5 | design | store-and-mask: the optional `source-capture` page holds **real** text in SQLite, while Mongo/Qdrant hold pseudonyms only | document in README (Phase 7) |
| N6 | live data | **0 protected entities** in the live registry — only pattern rules mask today | user action before first real ingest |

## 4. Machine notes

- Free space on C: **~20 GB** — the tightest resource for bge-m3 (1.2 GB), Qdrant, Mongo.
- Ollama tray app running with an active updater (`%LOCALAPPDATA%\Ollama\upgrade.log`, 418 KB) → egress conflict; proposal: headless `ollama serve` with `OLLAMA_NO_CLOUD=1`, startup shortcut removed (Phase 1, user decision).
- Out of scope, flagged to the user: an HKCU `Run` entry launching hidden PowerShell with `-ExecutionPolicy Bypass` and an empty `-File`.

## 5. Scope change

PPTX added to the ingest formats (user decision, 2026-10-04).

## 6. Corrections found during the build

| # | Brief said | Measured | Effect |
|---|---|---|---|
| C7 | ≈ 4 chars/token | bge-m3 on this content: EN prose 3.39, tables 2.56, code 3.0, DE/RO ~4.5 | chunker uses 3.0 / 2.3 per type; real/estimate p50 0.79, max 1.06; no chunk > 512 real tokens |
| C8 | Wi-Fi-off `doctor` run | not possible on this setup | `infra/offline-guard.mjs` blocks non-loopback sockets/DNS in-process; `doctor` and extractor tests pass under it with 0 attempts |

## 7. v0.1 UI defects found in Phase 6

| # | Where (baseline) | Defect | Status |
|---|---|---|---|
| U1 | `web/index.html:247` | `/&lt;\/mark&gt;/g` is a regex syntax error, so the **whole UI script never ran** (no spaces, tree or buttons) | fixed; `test/ui.test.js` compiles the script |
| U2 | `web/index.html:124-131` (`api()`) | sends `content-type: application/json` with no body on DELETE; Fastify answers 400, so **Retire and Purge never worked** | fixed: header only with a body |
| U3 | `web/index.html:143`, `:314` | Review button label replaced by the bare count, or by nothing | fixed: "Review (n)" |
| U4 | `web/index.html:169` | page editor's space select lacks Deployment, and PATCH ignores `space` anyway | open (existing behaviour; not changed) |
| U5 | design | the sidebar tree shows real page titles (store-and-mask), while Library/Ask show pseudonyms | open — user decision |
