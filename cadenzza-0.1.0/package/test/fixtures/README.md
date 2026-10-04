# Test fixtures

Synthetic only. The only organisations named are **Contoso** and **Northwind Traders**; the tests
register them as protected entities. Never add real client material here.

| File | Exercises |
|---|---|
| `runbook.docx` | Title style, Heading 1/2, nested bullets (numbering.xml), table, DE/RO diacritics |
| `runbook.doc` | Word 97-2003 binary (OLE) — `runbook.docx` saved by Word as "Word 97-2003 Document" |
| `runbook.pdf` | 3 pages, Helvetica 20/15/13/11 pt headings, hyphenated line break, bullets, repeated footer + page numbers |
| `scanned.pdf` | Image-only page, no text layer → `needs_ocr` |
| `deck.pptx` | Presentation order ≠ file order, hidden slide, subtitle, slide-number placeholder, bullet levels, table, speaker notes |
| `checklist.md` | YAML front matter, nested list, GFM table, fenced code |
| `environments.html` | `<script>`/`<style>`/`<nav>` stripping, inline handler, entities, table, nested ol/ul |
| `confluence-utf8.mhtml` / `confluence-1252.mhtml` | Quoted-printable in UTF-8 and windows-1252 (N3) |
| `notes-cp1252.txt` | windows-1252 text with no BOM |

Regenerate everything except `runbook.doc` with `node test/fixtures/make-fixtures.mjs`.
