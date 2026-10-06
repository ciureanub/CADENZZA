# CADENZZA — how to use it, step by step

Everything runs on this laptop. Nothing you add, ask or read leaves the machine.
Commands are PowerShell. Your data folder is `C:\E.ON\cadenzza` (`CADENZZA_HOME`).

---

## Step 0 — One-time: make `cadenzza` the 0.2 version

Done on this laptop (2026-10-06): `cadenzza` is linked to this folder, so code changes apply
immediately. On another machine, or if it ever reverts, check:

```powershell
cadenzza --version          # must say 0.2.0
```

If it says 0.1.0, point it at the 0.2 code (one time):

```powershell
cd C:\E.ON\CADENZZA\cadenzza-0.1.0\package
npm link                    # replaces any global install with this folder
cadenzza --version          # 0.2.0
```

Until you do this, use the full path instead of `cadenzza`:
`node C:\E.ON\CADENZZA\cadenzza-0.1.0\package\bin\cadenzza.js <command>`.

---

## Step 1 — Start everything

After every reboot (nothing starts by itself):

```powershell
cd C:\E.ON\CADENZZA\cadenzza-0.1.0\package
infra\start-rag.ps1         # MongoDB, Qdrant, Ollama — local only; safe to run twice
cadenzza doctor             # every line should be green
cadenzza serve              # leave this window open
```

Open **http://127.0.0.1:4173** in your browser.

If `doctor` shows something red, see [Troubleshooting](#troubleshooting).

---

## Step 2 — Register client names before adding files

CADENZZA replaces protected names with pseudonyms (`E.ON` → `CLIENT_A`) **before** anything is
stored or embedded. It refuses to ingest while the list is empty.

1. Click **Guard** in the top bar.
2. Type the name (e.g. `Fluidra`), add aliases if any, click **Protect**.
3. Spelling variants are covered by one entry: `E.ON` also catches `EON`, `E-ON`, `e.on`, `E.ON SE`.

Already protected: E.ON (`CLIENT_A`), Dojo (`CLIENT_B`), Fluidra (`CLIENT_C`), Richemont (`CLIENT_D`).

Protected a name *after* files were ingested? Nothing to do — the stored corpus is re-masked automatically.

Command line: `cadenzza entities add "Fluidra"` · `cadenzza entities list`

---

## Step 3 — Add training files (drag & drop)

Supported: **PDF, DOCX, DOC, PPTX, HTML, Markdown, TXT, MHTML** — single files or whole folders.

1. **Drag files or a folder onto the browser window** — anywhere. The window shows
   *Drop to add to the Library*; let go, and the **Library** opens and starts ingesting.
   (Or click **Library** → **Choose files** / **Choose folder**.)
2. Optional, before dropping: in the Library, pick a **sensitivity**. Files marked **Restricted** are recorded but not embedded (so not answerable)
   unless you turn that on in settings.
3. Watch the progress list. Each file ends in one of:

   | Status | Meaning |
   |---|---|
   | **done** | Extracted, masked, chunked, embedded, searchable |
   | **unchanged** | Same file was already ingested — nothing redone |
   | **needs_ocr** | Scanned/image-only PDF — no text to read (OCR is not supported) |
   | **failed** | Shown with the reason (corrupt file, unsupported content, …) |

   A 300-page PDF takes a few minutes. You can keep working; closing the browser doesn't stop it.

4. Dropped the same file again after editing it? It replaces the old version cleanly.

Command line (whole folder): `cadenzza rag ingest C:\E.ON\CADENZZA\files`
— add `--force` to redo files that are unchanged (e.g. after changing chunk settings).

---

## Step 4 — Check the review queue

Some things look like they *might* be sensitive (hostnames, ticket keys, codes) but aren't certain.
They wait in **Review (n)** in the top bar.

- **protect** → it is masked everywhere from now on, including already-ingested files.
- **ignore** → never raised again.

Names nobody registered — people, internal codenames, "the German utility" — are **not** detected.
Register them in Guard.

---

## Step 5 — Ask questions

1. Click **Ask**.
2. Type a question, e.g. *What is our rollback procedure for a failed cutover?*, press **Ask**.
3. The answer streams in with citations `[1]`, `[2]`. Under it, **Sources** list file › section › page;
   expand one to see the exact passage the answer used.
4. If the material doesn't cover it, the answer is **"Not found in the ingested material."** — that
   is deliberate; it doesn't guess.

Options next to the question box:

- **Space / file type** — limit where it looks.
- **Retrieval** — leave on *default* (hybrid). *dense* = meaning only; *exact* = slow fallback.
- **Reveal names** — show real names instead of `CLIENT_A`. Every reveal is logged in **Audit**.

Typical speed on this laptop: first words after ~6 s, full answer ~12 s.

Command line: `cadenzza ask "What is our rollback procedure?"`

---

## Step 6 — Manage the Library

In **Library**, each document row has:

- **page** — open its mirror page in the wiki (masked title, searchable).
- **re-ingest** — process it again from the stored copy. Greyed out for files ingested before 0.2
  stored copies; fix by running `cadenzza rag ingest <folder> --force` once.
- **delete** — removes it from answers, the index and the wiki.

---

## Step 7 — Settings (Library → Answering settings)

| Setting | Default | When to change |
|---|---|---|
| Answer model | `qwen3:4b-instruct` | Another local model you pulled with `ollama pull` |
| Answer model runs on | auto (GPU) | *CPU only* for large models such as gemma4, which crash on the integrated GPU |
| Retrieval | hybrid | Rarely |
| Sources per answer (top-k) | 6 | More context for broad questions; slower |
| Embed Restricted files | off | Only if Restricted material should be answerable |
| Mirror files as pages | on | Off if you don't want a wiki page per file |
| Embedding model | `bge-m3` | Read-only here — see *Change embedding model* below |

Click **Save settings**.

---

## Step 8 — Back up

```powershell
cadenzza backup             # -> C:\E.ON\cadenzza\backup\<timestamp>\
```

Safe while the app runs. The backup contains real names and the vault key: keep it as secure as
the original, never in git or a shared drive.

**Restore:** stop the server and `infra\stop-rag.ps1`; copy `cadenzza.db` and `vault.key` from the
backup into `C:\E.ON\cadenzza`; `infra\start-rag.ps1`; `cadenzza rag restore <backup-folder>`.

---

## Step 9 — Stop everything

1. In the `cadenzza serve` window press **Ctrl+C**.
2. `infra\stop-rag.ps1` (shuts MongoDB down cleanly, stops Qdrant and Ollama).

Check what's running any time: `infra\status-rag.ps1`.

---

## Less frequent tasks

**Change embedding model (blue/green, old model keeps serving until you switch):**

```powershell
ollama pull <model>
cadenzza rag reembed --model <model>
cadenzza rag eval                       # compare quality
cadenzza rag activate --model <model>   # switch
cadenzza rag prune --yes                # remove the old vectors
```

**Measure quality:** `cadenzza rag eval` — uses the test questions plus your own in
`C:\E.ON\cadenzza\rag\eval\golden-local.jsonl` (one JSON question per line; never committed).

**Rebuild the search index from MongoDB:** `cadenzza rag reindex`

**Remove the whole corpus** (wiki, names and vault stay): `cadenzza backup` first, then
`cadenzza rag wipe --yes`.

**Leak check a folder before sharing it:** `cadenzza scan C:\path\to\folder` — exits with 1 if a
real protected name is found.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser can't open 127.0.0.1:4173 | Is the `cadenzza serve` window still open? Start it again |
| Library/Ask say services are down | `infra\start-rag.ps1`, then `cadenzza doctor` |
| `doctor`: model missing | `ollama pull bge-m3` / `ollama pull qwen3:4b-instruct` (needs internet, once) |
| Ingest refuses: empty registry | Step 2 — protect at least one name |
| File ends in **needs_ocr** | It's a scan; export a text PDF or the original document instead |
| Answer very slow or empty with a big model | Settings → *Answer model runs on: CPU only* |
| Dropping a file opens it in the browser | Reload the page (Ctrl+F5) to get the current UI |
| `cadenzza --version` says 0.1.0 | Step 0 |
| `cadenzza serve`: *Port 4173 is already in use* | `cadenzza doctor` says who holds it. **CADENZZA already running** → just open http://127.0.0.1:4173 (or close the other `serve` window first). **Another program** → stop it (pid shown), or `cadenzza serve -p 4174` |
| A service port is in use / won't start | `infra\status-rag.ps1`, then `infra\stop-rag.ps1` and start again |
