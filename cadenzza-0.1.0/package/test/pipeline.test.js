import '../infra/offline-guard.mjs';
import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as guard from '../src/entity/guard.js';
import { db } from '../src/db/index.js';
import { prepareDocument } from '../src/rag/pipeline.js';
import { SUPPORTED } from '../src/rag/extract/index.js';
import { DEFAULTS } from '../src/rag/chunk.js';
import { buildServer } from '../src/server/index.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURES = fs.readdirSync(FX).filter((f) => SUPPORTED.includes(path.extname(f)) && f !== 'README.md');

guard.addEntity({ canonical: 'Contoso SE', type: 'org', aliases: ['contoso.com'] });
guard.addEntity({ canonical: 'Northwind Traders', type: 'org' });
// Real surfaces that must never appear in anything prepareDocument returns.
const LEAK = /contoso|northwind|jane\.doe/i;

test('migration v2 adds entity_occurrence.doc_id', () => {
  const cols = db().prepare('PRAGMA table_info(entity_occurrence)').all().map((c) => c.name);
  assert.ok(cols.includes('doc_id'));
  assert.deepEqual(db().prepare('SELECT version FROM schema_migration ORDER BY version').all().map((r) => r.version), [1, 2, 3]);
});

test('no protected surface survives in any chunk, title, filename or warning of any fixture', async () => {
  for (const f of FIXTURES) {
    const doc = await prepareDocument(fs.readFileSync(path.join(FX, f)), `Contoso ${f}`, { docId: `fx-${f}` });
    const { chunks, ...rest } = doc;
    assert.doesNotMatch(JSON.stringify(rest), LEAK, `${f}: document fields`);
    for (const c of chunks) {
      assert.doesNotMatch(JSON.stringify(c), LEAK, `${f} chunk ${c.chunk_index}`);
      assert.equal(guard.assertClean(c), true);
      assert.ok(c.token_estimate <= DEFAULTS.targetTokens, `${f} chunk ${c.chunk_index} too big`);
    }
    assert.match(doc.filename, /^CLIENT_A /);
    if (f !== 'scanned.pdf') assert.ok(chunks.length > 0, `${f}: no chunks`);
  }
});

test('pseudonyms and pattern masks are what replaces the names', async () => {
  const doc = await prepareDocument(fs.readFileSync(path.join(FX, 'runbook.docx')), 'runbook.docx', { docId: 'fx-docx' });
  const all = doc.chunks.map((c) => c.embed_text).join('\n');
  assert.match(all, /CLIENT_A restores the org snapshot/);
  assert.match(all, /Escalate to \[PERSON_EMAIL\]/);
  assert.match(all, /Notify CLIENT_B integration team/);
  assert.equal(doc.title, 'CLIENT_A Cutover Runbook');
  assert.equal(doc.occurrences.protected >= 4, true, JSON.stringify(doc.occurrences));
});

test('chunks carry page numbers through masking (pdf, pptx)', async () => {
  const pdf = await prepareDocument(fs.readFileSync(path.join(FX, 'runbook.pdf')), 'runbook.pdf', { docId: 'fx-pdf' });
  assert.deepEqual(pdf.chunks.map((c) => [c.heading_path.at(-1), c.page_start]),
    [['Rollback procedure', 1], ['Decision points', 2], ['Communications', 3]]);
  const deck = await prepareDocument(fs.readFileSync(path.join(FX, 'deck.pptx')), 'deck.pptx', { docId: 'fx-pptx' });
  assert.ok(deck.chunks.every((c) => c.page_start >= 1 && c.page_start <= 2));
  // slide 1's heading equals the title, so it is not repeated in the breadcrumb
  assert.match(deck.chunks[0].embed_text, /^CLIENT_B Release Train\n\nQuarterly deck for CLIENT_A$/);
  assert.match(deck.chunks[1].embed_text, /^CLIENT_B Release Train › Rollback strategy\n\n/);
});

test('candidates are recorded against the doc and replaced, not duplicated, on re-prepare', async () => {
  const buf = Buffer.from('# Vendor review\n\nFabrikam AG raised OPS-42 about UTF-8 handling (see SHA-256 notes).');
  for (let i = 0; i < 2; i++) await prepareDocument(buf, 'vendor.md', { docId: 'doc-vendor' });
  const rows = db().prepare("SELECT surface, layer, status, page_id FROM entity_occurrence WHERE doc_id = 'doc-vendor' ORDER BY surface").all();
  assert.deepEqual(rows.map((r) => [r.surface, r.status, r.page_id]), [['Fabrikam AG', 'candidate', null], ['OPS-42', 'candidate', null]]);
  guard.clearDocOccurrences('doc-vendor');
  assert.equal(db().prepare("SELECT COUNT(*) c FROM entity_occurrence WHERE doc_id = 'doc-vendor'").get().c, 0);
});

test('review queue shows document candidates (N4)', async () => {
  await prepareDocument(Buffer.from('Fabrikam AG approved.'), 'x.txt', { docId: 'doc-review' });
  const app = await buildServer();
  try {
    const rows = (await app.inject({ url: '/api/review' })).json();
    const row = rows.find((r) => r.doc_id === 'doc-review');
    assert.ok(row, JSON.stringify(rows));
    assert.equal(row.page_title, 'document doc-review');
  } finally { await app.close(); }
});

test('docId is required', async () => {
  await assert.rejects(prepareDocument(Buffer.from('x'), 'x.txt'), /docId is required/);
});
