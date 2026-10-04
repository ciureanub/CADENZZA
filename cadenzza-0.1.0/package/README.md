# CADENZZA

Local-first knowledge base and deliverable library for **release, deployment, environment and stakeholder management**, with deterministic entity pseudonymisation.

Runs entirely on your machine. **Zero outbound network calls** — no CDN, no fonts, no telemetry, no cloud model. Your corpus never leaves the laptop.

---

## Install

Node 20 or newer required (`node -v`).

```bash
npm install -g cadenzza
cadenzza init
cadenzza serve
```

Open **http://127.0.0.1:4173**

### From the tarball (what you have now)

```powershell
npm install -g C:\path\to\cadenzza-0.1.0.tgz
cadenzza init
cadenzza serve
```

Or without installing globally:

```powershell
npm install C:\path\to\cadenzza-0.1.0.tgz
npx cadenzza serve
```

### Keeping the data in your E.ON working folder

By default everything lives in `%USERPROFILE%\.cadenzza`. To put it somewhere else:

```powershell
# PowerShell — this session only
$env:CADENZZA_HOME = "C:\E.ON\cadenzza"
cadenzza init
cadenzza serve

# permanent
setx CADENZZA_HOME "C:\E.ON\cadenzza"
```

That directory holds `cadenzza.db`, `vault.key`, `assets/` and `exports/`. **Back it up. Do not commit it.**

---

## First five minutes

```powershell
cadenzza init                              # database + 21 deliverable templates
cadenzza entities add "E.ON SE" -a EON "E-ON" eon.com
cadenzza entities add "Allianz"
cadenzza entities add "Fluidra"
cadenzza serve
```

Register your employers and clients **before** you paste anything in. Detection is only as good as the registry.

---

## What's in it

**Four spaces, 21 seeded templates** — real structures with inline guidance, not empty pages.

| Space | Templates |
|---|---|
| Release Management | Release Plan · Go/No-Go Decision Record · RAID Log · Cutover Plan · Post-Implementation Review · DORA Scorecard |
| Deployment Management | Deployment Runbook · Delta Package Manifest · Pipeline Definition · Smoke Test Checklist · Change Record (RFC) |
| Environment Management | Environment Inventory Matrix · Refresh Runbook · Data Seeding & Masking Plan · Drift Report · Integration Endpoint Matrix |
| Stakeholder Management | Stakeholder Register · RACI Matrix · Communication Plan · Go-Live Comms Pack · Decision Log (ADR) |

**Editor** — rich text with a `</> HTML` source toggle, tables, code blocks, `[[wiki links]]` with backlinks, full revision history on every save.

**Search — three modes, switchable in the header:**

| Mode | Engine | Use it when |
|---|---|---|
| Strict | SQLite FTS5 + BM25 | You know the words. Supports `"exact phrase"`, `prefix*`, `AND/OR/NOT`, `NEAR()` |
| Fuzzy | Trigram overlap + Levenshtein ≤ 2 | You don't. `cutver plna` finds *Cutover Plan* |
| Hybrid | Reciprocal rank fusion of both | Default |

Field filters work in all modes: `space:release`, `tag:cutover`, `type:deliverable`, `owner:`, `sensitivity:Restricted`, `before:2026-01-01`, `after:`.

---

## Entity Guard

**This is pseudonymisation, not anonymisation.** The mapping is deterministic and reversible by design — that's what keeps your own archive readable. Pseudonymised data is still confidential data under GDPR. Say that, not "anonymised", in anything client-facing.

**Three detection layers:**

1. **Gazetteer** — your registry. Normalisation collapses punctuation and spacing, so one entry for `E.ON SE` catches `E.ON`, `EON`, `E-ON`, `e.on`, `E ON` and `eon.com`. Verified in the test suite.
2. **Pattern rules** — emails, IPs, internal hostnames, Salesforce IDs, Jira keys, IBAN/VAT, legal-entity suffixes. Unambiguous ones mask automatically; the rest become review candidates.
3. **Review queue** — everything uncertain lands here for one-click *protect / ignore*. Protecting an entity re-scans the whole corpus immediately.

**What it will not catch:** context-only references. "The German utility", "our DACH luxury client", an internal codename only you recognise. No tool catches these. The review queue and your own eyes are the last line — that's not a caveat, it's the design.

**Storage mode:** `store-and-mask` (default). Real names stored locally so search and reading work normally; masking applied at every exit. Change it in `Settings` if you'd rather redact on ingest.

**The masking boundary.** Every outbound path — export, clipboard, and any future cloud call — routes through `mask()` then `assertClean()`, which *throws* if a protected string survives. `Restricted` pages refuse to export at all.

```powershell
cadenzza mask "E.ON and Allianz agreed, contact bogdan@eon.com"
# -> CLIENT_A and CLIENT_B agreed, contact [PERSON_EMAIL]

cadenzza scan C:\E.ON\some-repo     # exit code 1 if a real name is found in files
```

Use `cadenzza scan` as a git pre-commit hook.

**Vault.** Real names are stored AES-256-GCM encrypted in `vault_entry`, keyed by `vault.key` (mode 0600) or `CADENZZA_PASSPHRASE`. Never indexed, never exported, excluded from the npm tarball. Every reveal is written to the audit log.

---

## CLI

```
cadenzza init [--entities file.json]   database, templates, vault key
cadenzza serve [-p 4173] [-h host]     server + UI
cadenzza entities list|add|remove      protected entity registry
cadenzza mask [text]                   mask via stdin or argument
cadenzza scan [dir]                    leak check; exit 1 on finding
cadenzza search <query> [-m mode]      search from the terminal
cadenzza doctor                        integrity and environment check
```

Seed the registry in bulk:

```json
[
  { "canonical": "E.ON SE", "type": "org", "aliases": ["EON", "E-ON", "eon.com"] },
  { "canonical": "Allianz", "type": "org" },
  { "canonical": "Fluidra", "type": "org" }
]
```
```powershell
cadenzza init --entities entities.json
```

---

## Keyboard

`Ctrl/⌘ K` search · `Ctrl/⌘ S` save · `</> HTML` source toggle

---

## What is deliberately not here yet

Being explicit so you don't go looking:

- **No RAG chatbot.** Phase 3. Requires embeddings (`transformers.js` + `bge-small`, ~90 MB model download on first run) — deliberately excluded to keep this install dependency-light and fully offline.
- **No file ingestion.** Phase 2. Upload endpoint and asset store exist; PDF/DOCX/OCR extraction does not. Paste works today.
- **No Radar research agent.** Phase 4. It's the only component that needs network.
- **No NER layer.** Gazetteer and patterns only. NER needs the same model runtime as the chatbot.

The schema, the masking boundary and the search layer are already built to carry all four.

---

## Dependencies

Five, all mainstream: `fastify`, `@fastify/static`, `@fastify/multipart`, `better-sqlite3`, `commander`. No build step, no bundler, no framework. The UI is one HTML file using system fonts.

`better-sqlite3` ships prebuilt binaries for Windows/macOS/Linux on Node 20–22. If your Node version has no prebuild it compiles from source and needs Visual Studio Build Tools — installing a Node LTS avoids this.

## Licence

MIT.
