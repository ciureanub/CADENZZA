# CADENZZA

Local-first knowledge base and deliverable library for **release, deployment, environment and stakeholder management**, with deterministic entity pseudonymisation and **fully local question answering over your own training material**.

Runs entirely on your machine. **Zero outbound network calls at runtime** — no CDN, no fonts, no telemetry, no cloud model. Your corpus never leaves the laptop. The only network traffic is what *you* start on purpose: installing packages and pulling a model (`ollama pull …`). See [Locality](#locality--what-talks-to-what) for exactly what runs where and how that is checked.

---

## Install

Node **20.19** or newer (`node -v`). Windows + PowerShell is the reference platform.

```powershell
npm install -g C:\path\to\cadenzza-0.2.0.tgz
$env:CADENZZA_HOME = "C:\E.ON\cadenzza"      # or setx CADENZZA_HOME ... to make it permanent
cadenzza init
cadenzza serve                                # http://127.0.0.1:4173
```

That is enough for the wiki, search and the Entity Guard. The **Library** and **Ask** features need three local services:

| Service | Version tested | Role | Install |
|---|---|---|---|
| Ollama | 0.30.8 | runs the embedding and answer models | ollama.com installer; then `ollama pull bge-m3` and `ollama pull qwen3:4b-instruct` |
| MongoDB Community | 9.0.2 (Windows zip) | system of record: documents, chunks, vectors, jobs | unzip `mongod.exe` to `%LOCALAPPDATA%\cadenzza\bin` |
| Qdrant | 1.19.1 (`qdrant-x86_64-pc-windows-msvc.zip`) | vector search index (rebuildable from Mongo) | unzip `qdrant.exe` to `%LOCALAPPDATA%\cadenzza\bin` |

Verify the downloads against the published checksums (MongoDB `.sha256` file; Qdrant GitHub asset digest). Then:

```powershell
infra\start-rag.ps1      # MongoDB, Qdrant, Ollama on 127.0.0.1 only; idempotent
cadenzza doctor          # every check green, including loopback-only binds
```

The data directory (`CADENZZA_HOME`) holds `cadenzza.db`, `vault.key`, `assets/`, `exports/`, `import/` and `rag/` (Mongo and Qdrant data, source copies, logs, evaluation results). **Back it up. Do not commit it.**

---

## First five minutes

```powershell
cadenzza init
cadenzza entities add "E.ON"                  # register employers and clients FIRST
cadenzza entities add "Fluidra"
infra\start-rag.ps1
cadenzza serve
```

Open **Library**, drop a folder of training files, watch them ingest, then **Ask**: *"What is our rollback procedure for a failed cutover?"*

Ingest **refuses to run while the registry is empty** — otherwise client names would be embedded in clear text. Register first; anything you protect later is re-masked in the stored corpus automatically.

---

## What's in it

**Three spaces — Release Management (release and deployment), Environment Management, Stakeholder Management — with seeded deliverable templates**: real structures with inline guidance, not empty pages (Release Plan, Go/No-Go Record, RAID Log, Cutover Plan, PIR, DORA Scorecard, Deployment Runbook, Delta Package Manifest, Environment Inventory, Refresh Runbook, Stakeholder Register, RACI, Communication Plan, ADR, …). Deployment Management was merged into Release Management in 0.2; `deployment` is still accepted as a space key (`--space`, `space:` filters, API) and means `release`. Move a page to another space with the space selector in the editor.

**Editor** — rich text with a `</> HTML` source toggle, tables, `[[wiki links]]` with backlinks, revision history on every save.

**Search — three modes:** Strict (SQLite FTS5 + BM25), Fuzzy (trigram + Levenshtein ≤ 2), Hybrid (reciprocal rank fusion). Field filters: `space:` `tag:` `type:` `owner:` `sensitivity:` `before:` `after:`.

**Library (new in 0.2)** — drop **PDF, DOCX, DOC, PPTX, HTML, Markdown, TXT, MHTML** files or whole folders. Each file is extracted with its structure (headings, lists, tables, page/slide numbers), pseudonymised, chunked, embedded locally and indexed. Live per-file progress; re-ingest and delete per document. Each file also appears as a *Sources* page in the tree (pseudonymised title), searchable with Strict/Fuzzy.

**Ask (new in 0.2)** — a streamed answer that uses **only** the ingested material, cites every claim as `[n]` mapped to file › section › page, and says *"Not found in the ingested material."* when the corpus is silent. Sources expand to the exact (masked) passage.

---

## Entity Guard

**This is pseudonymisation, not anonymisation.** The mapping is deterministic and reversible by design — that's what keeps your own archive readable. Pseudonymised data is still confidential data under GDPR. Say that, not "anonymised", in anything client-facing.

**Three detection layers:**

1. **Gazetteer** — your registry. Normalisation collapses punctuation and spacing, so one entry for `E.ON` catches `E.ON`, `EON`, `E-ON`, `e.on`, `E ON` and `E.ON SE`. Matching is case-insensitive and word-bounded (an entry that is also an ordinary word, such as "Dojo", is masked everywhere it appears). Verified in the test suite.
2. **Pattern rules** — e-mails, IPs, internal hostnames, Salesforce IDs (15/18-char, incl. checksum), Jira keys, IBAN/VAT, legal-entity suffixes. Unambiguous ones mask automatically; the rest become review candidates. Standards and editions (`UTF-8`, `SHA-256`, `ISO-27001`, `ISBN-13`, `Java SE`) are not raised.
3. **Review queue** — everything uncertain lands here for one-click *protect / ignore*. Protecting re-scans the wiki and **re-masks the RAG corpus** (only changed chunks are re-embedded).

**What it will not catch:** context-only references. "The German utility", "our DACH luxury client", an internal codename only you recognise. No tool catches these. The review queue and your own eyes are the last line — that's not a caveat, it's the design.

**Storage mode:** `store-and-mask`. Real names stay in the local wiki (SQLite) so reading works normally; masking is applied at every exit.

**The masking boundary.** Every outbound path routes through `mask()` then `assertClean()`, which *throws* if a protected string survives. In 0.2 the RAG pipeline sits entirely behind it:

- **Mask before embed.** Chunk text, vectors, Mongo records, Qdrant payloads (which hold no text at all), job records, progress events and the audit log contain pseudonyms only. Filenames are masked too.
- **Queries are masked** with the same guard, so "E.ON cutover" and "CLIENT_A cutover" retrieve the same passages.
- **The prompt passes `assertClean()`** before the model sees it — kept even though the model is local, because the generator is swappable.
- **The answer is re-masked as it streams**: a model that guesses a real name, or writes an e-mail address, never shows it unmasked; text is held back just long enough for a split name to complete.
- **Reveal names** in Ask is an explicit toggle; every reveal is written to the audit log by the vault. Auto-masked patterns (e-mails, IPs) are not stored in the vault and stay masked.
- **`Restricted` files** are recorded and mirrored but never embedded (setting, default off).

```powershell
cadenzza mask "E.ON and Fluidra agreed, contact jane@fluidra.com"
# -> CLIENT_A and CLIENT_C agreed, contact [PERSON_EMAIL]
cadenzza scan C:\E.ON\some-repo     # exit code 1 if a real name is found in files
```

**Vault.** Real names are stored AES-256-GCM encrypted in `vault_entry`, keyed by `vault.key` (mode 0600) or `CADENZZA_PASSPHRASE`. Never indexed, never exported, excluded from the npm tarball.

---

## How the RAG pipeline works

```
drop (UI / CLI)
  -> extract   pdf (unpdf) · docx (mammoth) · doc (word-extractor) · pptx (jszip) · html · md (marked) · txt · mhtml
               blocks {type, text, heading_path, page}; image-only PDFs flagged needs_ocr
  -> guard     scan -> review queue -> mask (text, headings, title, filename)
  -> chunk     heading-aware, ~450 est. tokens, 15% overlap, tables split by row with header repeated,
               "Title › H1 › H2" prefix for embedding, sha256 + deterministic UUIDv5 ids
  -> embed     Ollama /api/embed (bge-m3, 1024-d), batched, model digest recorded
  -> MongoDB   system of record (documents, chunks + Float32 vectors per model, jobs)
  -> Qdrant    serving index (chunk id + filter fields only), rebuilt from Mongo on demand
ask -> mask -> embed -> Qdrant dense + Mongo full-text, RRF -> top 6 -> prompt (qa-v1) -> assertClean
    -> local LLM (streamed) -> re-mask -> answer + citations
```

- **Idempotent and resumable.** Same file + same bytes + same registry + same model + same chunking = no-op. A changed file replaces its chunks atomically (Mongo transaction; Qdrant upsert-then-prune). A crash mid-embedding resumes from the vectors already computed.
- **Lineage.** Every chunk records extractor + version, chunker version + configuration, source sha256, embedding model + dimension + digest, ingest time. Every answer logs the masked question, retrieved chunk ids + scores, prompt version, models and latency.
- **Never mixed vectors.** One Qdrant collection per model and dimension (`cadenzza_chunks_bge-m3_1024`); switching models is blue/green.

---

## CLI

```
cadenzza init [--entities file.json]        database, templates, vault key
cadenzza serve [-p 4173] [-h host]          server + UI (binds 127.0.0.1)
cadenzza entities list|add|remove           protected entity registry (add re-masks the RAG corpus)
cadenzza mask [text]                        mask via stdin or argument
cadenzza scan [dir]                         leak check; exit 1 on finding
cadenzza search <query> [-m mode]           wiki search from the terminal
cadenzza ask "<question>" [--mode] [--space] [--type] [--context] [--json]
cadenzza doctor [--no-rag] [-p 4173]        integrity, UI port (free / CADENZZA running / other program), services, models, loopback-only binds, disk
cadenzza backup [dir]                       SQLite (online) + vault key + RAG corpus + source files

cadenzza rag ingest <file|dir> [--space] [--sensitivity] [--force] [--allow-empty-registry]
cadenzza rag status | delete <docId> | remask
cadenzza rag reindex                        rebuild Qdrant entirely from Mongo
cadenzza rag reembed --model <id>           blue/green 1: embed everything with another model (no switch)
cadenzza rag activate --model <id>          blue/green 2: switch (refuses if not fully embedded + indexed)
cadenzza rag prune --yes                    blue/green 3: drop the old model's vectors and collection
cadenzza rag restore <dir> [--replace]      corpus from a backup, then reindex
cadenzza rag wipe --yes [--keep-pages]      delete the whole RAG corpus (wiki, registry, vault stay)
cadenzza rag eval [--retrieval-only] [--mode] [--set files] [--label]
```

---

## Operations

**Start / stop / status.** `infra\start-rag.ps1`, `infra\stop-rag.ps1`, `infra\status-rag.ps1` (`-Only mongo|qdrant|ollama` to act on one). Start is idempotent; stop shuts MongoDB down cleanly and only touches processes running our binaries. Nothing autostarts: after a reboot, run `start-rag.ps1`.

**Integrated GPU.** On Intel Iris Xe laptops, Ollama ignores the iGPU by default. The flag file `CADENZZA_HOME\rag\ollama-igpu.on` makes `start-rag.ps1` enable it (Vulkan) — measured 4–5× faster on this hardware for bge-m3 and qwen3:4b. Large models (gemma4 8B) crashed on the iGPU; run those with *Answer model runs on: CPU only*. Delete the file to go back to CPU.

**Backup.** `cadenzza backup` writes a timestamped folder: SQLite via the online backup API (safe while the server runs), `vault.key`, every Mongo collection as canonical EJSON (vectors preserved bit-exact), stored source files and evaluation sets, plus `manifest.json`. Qdrant is derived and is rebuilt on restore. The backup contains real names (SQLite, vault key, source files): store it as carefully as the original.

**Restore.** Stop the server and services, copy `cadenzza.db` and `vault.key` back into `CADENZZA_HOME`, start the services, then `cadenzza rag restore <backup-dir>` (reloads Mongo and source files, rebuilds Qdrant, verifies counts).

**Re-embed / change model.** `rag reembed --model <id>` → `rag eval` → `rag activate --model <id>` → `rag prune --yes`. Retrieval keeps using the old model until `activate`.

**Upgrade models.** Model tags move (the registry's `gemma4:latest` changed size while this was built). `doctor` shows the digest you run; pull a new version deliberately, re-run `rag eval`, and re-embed if the *embedding* model changed.

**Re-chunk.** Change `rag_chunk_tokens` / `rag_chunk_merge_min`, then `cadenzza rag ingest <dir> --force` (or *re-ingest* in the Library).

**Wipe.** `cadenzza backup` first, then `cadenzza rag wipe --yes`.

**Evaluate.** `cadenzza rag eval` runs the committed fixture set (`test/eval/golden.jsonl`) plus your private set in `CADENZZA_HOME\rag\eval\golden-local.jsonl` (never committed) and reports recall@5/@10, MRR, refusal accuracy, false-refusal rate, must-contain coverage, citation accuracy, groundedness and latency. Results: `CADENZZA_HOME\rag\eval\*.json`.

---

## Locality — what talks to what

| Component | Listens on | Outbound at runtime |
|---|---|---|
| CADENZZA server | 127.0.0.1:4173 | none |
| MongoDB | 127.0.0.1:27017 (single-node replica set `cadenzza`) | none |
| Qdrant | 127.0.0.1:6333 / 6334 | none (`telemetry_disabled`, confirmed in its log by `doctor`) |
| Ollama (`ollama serve`) | 127.0.0.1:11434 | none (`OLLAMA_NO_CLOUD=1`); only `ollama pull`, when you run it |

**Ollama's desktop/tray app** checks for updates on github.com and downloads installers by itself. `start-rag.ps1` runs `ollama serve` headless instead; remove the tray app from Windows startup.

**How it is checked.** `cadenzza doctor` verifies every endpoint resolves to loopback and every port is bound to loopback only. `infra/offline-guard.mjs` can be preloaded (`node --import ./infra/offline-guard.mjs …`) to make *any* non-loopback socket or DNS lookup throw; the extractor, pipeline, RAG and UI tests run under it, and `doctor`, ingest and ask were verified with 0 outbound attempts.

---

## Performance (measured on an i7-1355U, 32 GB, Iris Xe)

Measured with `cadenzza rag eval` on 43 questions (18 synthetic fixture questions, committed; 25 private questions on the real corpus: a 300-page book, a workshop deck, a training workbook — 1,603 chunks). 37 answerable, 6 that must be refused. Integrated GPU on (Vulkan) unless marked CPU.

**Retrieval** (hybrid unless noted; recall = a relevant chunk in the top 5 / 10):

| Embedding · chunking | Chunks | recall@5 | recall@10 | MRR@10 | p50 |
|---|---|---|---|---|---|
| **bge-m3 · 450 tokens · no merge (default)** | 1,603 | 0.92 | 0.95 | 0.83 | 0.43 s |
| bge-m3 · 450 · dense only | 1,603 | 0.95 | 0.97 | 0.86 | 0.37 s |
| bge-m3 · 450 · merge sections < 120 | 1,566 | 0.95 | 0.97 | 0.83 | 0.45 s |
| bge-m3 · 250 tokens | 2,949 | 0.89 | 0.92 | 0.85 | 0.44 s |
| qwen3-embedding 0.6B · 450 | 1,603 | 0.92 | 1.00 | 0.83 | 0.35 s |

All five find **every** real-corpus question in the top 5; the differences come from 5 synthetic fixture questions (one question = 0.027). Qdrant results equal exact brute-force search in every configuration. Nothing beat the default by a margin the set can resolve, so the default stays; hybrid is kept over dense for exact-code and ID lookups.

**Answers** (default retrieval, top 6, prompt `qa-v1`):

| Answer model | Refused correctly | False refusals | Must-contain | Cited correctly | Grounded | First text p50 | Full answer p50 / p95 |
|---|---|---|---|---|---|---|---|
| **qwen3:4b-instruct, iGPU (default)** | 6 / 6 | 8 % (3; 2 had nothing retrieved) | 77 % | 74 % | 83 % | 6.0 s | 11.8 s / 22.0 s |
| gemma4 8B, CPU only | 6 / 6 | 0 % | 77 % | 67 % | 91 % | 29.9 s | 38.9 s / 69.0 s |

*Grounded* = share of answer sentences whose content words appear in the cited passages (a deterministic proxy, not a judge model). gemma4 is more faithful but over three times slower on this laptop; switch to it in *Answering settings* when quality matters more than waiting.

**Ingest** (embedding included): bge-m3 3.7 chunks/s on the iGPU (the 1,603-chunk corpus in ~7 min), qwen3-embedding 2.4 chunks/s. Re-ingesting an unchanged file is a no-op (< 1 s).

---

## What is deliberately not here

- **No OCR.** Scanned / image-only PDFs are detected and flagged *needs OCR*, not read.
- **No NER layer.** Gazetteer and patterns only. Names you have not registered (people, codenames) stay in clear text until you protect them — then the corpus is re-masked.
- **Context-only references** ("the German utility") are not detectable by any layer.
- **No Radar research agent**, no multi-user access or authentication (MongoDB has no auth; everything is bound to 127.0.0.1), no cloud model or hosted vector store.
- **No training or fine-tuning.** "Training material" means reference material for retrieval; no model weights are trained on it.
- Legacy binary `.doc` files carry no heading structure through the parser; SmartArt and charts in PPTX are not extracted (reported per file).

---

## Dependencies

Runtime, all pure JavaScript except `better-sqlite3` (prebuilt binaries):
`fastify`, `@fastify/static`, `@fastify/multipart`, `better-sqlite3`, `commander` (0.1) and, new in 0.2, `mongodb` (driver), `unpdf` (PDF), `mammoth` (DOCX), `word-extractor` (DOC), `marked` (Markdown), `jszip` (PPTX). No build step, no bundler, no framework; the UI is one HTML file using system fonts. Qdrant is called over plain HTTP (no SDK).

External services (installed separately, see above): Ollama, MongoDB Community, Qdrant.

## Licence

MIT.
