/**
 * Integration: real local Mongo + Qdrant (throwaway namespace), fake deterministic embedder.
 * Skips loudly if the services are not running (start them with infra/start-rag.ps1).
 */
import '../infra/offline-guard.mjs';
import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CADENZZA_MONGO_DB = `cadenzza_rag_test_${process.pid}`;
process.env.CADENZZA_QDRANT_PREFIX = `test${process.pid}`;

const guard = await import('../src/entity/guard.js');
const pages = await import('../src/pages.js');
const { db, setSetting, getSetting } = await import('../src/db/index.js');
const rag = await import('../src/rag/ingest.js');
const mongo = await import('../src/rag/store/mongo.js');
const qdrant = await import('../src/rag/store/qdrant.js');
const { setEmbedderFactory, modelKey } = await import('../src/rag/embed/index.js');
const { RAG } = await import('../src/config.js');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LEAK = /contoso|northwind|jane\.doe|fabrikam/i;

/* ---------------- fake embedder: hashed bag of words, unit length ---------------- */

let embedCalls = 0, failAfter = Infinity;
function fakeEmbedder(id) {
  const dim = id === 'fake-b' ? 32 : 64;
  return Promise.resolve({
    id, key: modelKey(id), dim, digest: `sha256:fake-${id}`,
    async embed(texts) {
      if (embedCalls >= failAfter) throw new Error('simulated crash');
      embedCalls++;
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const w of t.toLowerCase().match(/[a-z0-9_]+/g) || []) {
          let h = 2166136261;
          for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
          v[(h >>> 0) % dim] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    }
  });
}

let up = true;
before(async () => {
  try { await mongo.health(); up = await qdrant.health(); } catch { up = false; }
  if (!up) console.warn('\n*** RAG services not running: rag.test.js SKIPPED (run infra/start-rag.ps1) ***\n');
  setEmbedderFactory(fakeEmbedder);
  setSetting('rag_embed_model', 'fake-a');
});

after(async () => {
  if (up) {
    for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) await qdrant.dropCollection(c);
    await (await mongo.mongo()).dropDatabase();
  }
  await mongo.close();
});

const it = (name, fn) => test(name, async (t) => { if (!up) return t.skip('services down'); await fn(t); });
const ingestFx = (f, extra = {}) => rag.ingestFile({ buffer: fs.readFileSync(path.join(FX, f)), filename: f, sourceKey: `fixtures/${f}`, ...extra });
const FIXTURES = fs.readdirSync(FX).filter((f) => /\.(pdf|docx?|pptx|html|md|txt|mhtml)$/.test(f) && f !== 'README.md');
const KEY_A = modelKey('fake-a');
const activeCollection = () => qdrant.collectionName(KEY_A, 64);

async function dumpAll() {
  const d = await mongo.mongo();
  const out = [];
  for (const c of await d.listCollections().toArray()) {
    for (const doc of await d.collection(c.name).find({}, { projection: { 'embeddings': 0 } }).toArray()) out.push(JSON.stringify(doc));
  }
  for (const c of await qdrant.listCollections()) {
    if (!c.startsWith(`${RAG.qdrantPrefix}_`)) continue;
    for await (const p of qdrant.scroll(c)) out.push(JSON.stringify(p.payload));
  }
  return out.join('\n');
}

async function assertConsistent() {
  const c = await mongo.counts(KEY_A);
  assert.equal(c.staging, 0, 'no staging left');
  assert.equal(await qdrant.count(activeCollection()), c.embedded, 'qdrant points == mongo embedded chunks');
  assert.equal(c.embedded, c.chunks, 'every chunk embedded');
}

/* ---------------- tests (order matters) ---------------- */

it('refuses to ingest while the registry is empty, unless overridden', async () => {
  await assert.rejects(ingestFx('checklist.md'), /registry is empty/);
  const r = await ingestFx('notes-cp1252.txt', { allowEmptyRegistry: true });
  assert.equal(r.status, 'ready');
  await rag.deleteDocument(r.doc_id);
});

it('ingests every fixture; Mongo and Qdrant agree; statuses are right', async () => {
  guard.addEntity({ canonical: 'Contoso SE', aliases: ['contoso.com'] });
  guard.addEntity({ canonical: 'Northwind Traders' });
  const events = [];
  rag.events.on('progress', (e) => events.push(e));
  const results = {};
  for (const f of FIXTURES) results[f] = await ingestFx(f);
  rag.events.removeAllListeners('progress');

  assert.equal(results['scanned.pdf'].status, 'needs_ocr');
  for (const f of FIXTURES.filter((f) => f !== 'scanned.pdf')) assert.equal(results[f].status, 'ready', f);
  await assertConsistent();
  const docs = await mongo.listDocuments();
  assert.equal(docs.length, FIXTURES.length);
  for (const d of docs) {
    assert.ok(d.page_id && pages.get(d.page_id).type === 'source-capture', 'mirror page created');
    assert.equal(d.registry_version, guard.registryVersion());
  }
  const chunk = (await (await mongo.mongo()).collection('chunks').findOne({}));
  for (const k of ['chunker_version', 'extractor', 'extractor_version', 'source_sha256', 'ingested_at']) assert.ok(chunk[k], k);
  assert.deepEqual(Object.keys(chunk.embeddings[KEY_A]).sort(), ['digest', 'dim', 'embedded_at', 'model', 'vector']);
  assert.ok(events.some((e) => e.stage === 'indexed') && !LEAK.test(JSON.stringify(events)), 'events masked');
});

it('no real protected name in Mongo, Qdrant payloads, jobs, events or the RAG audit trail', async () => {
  assert.doesNotMatch(await dumpAll(), LEAK);
  const auditRows = db().prepare("SELECT detail FROM audit_event WHERE action LIKE 'rag.%'").all();
  assert.ok(auditRows.length > 0);
  assert.doesNotMatch(JSON.stringify(auditRows), LEAK);
  const p = await qdrant.scroll(activeCollection()).next();
  assert.deepEqual(Object.keys(p.value.payload).sort(), ['chunk_index', 'doc_id', 'embed_model', 'file_type', 'ingested_at', 'sensitivity', 'space'], 'payload has no text');
});

it('re-ingesting unchanged files is a no-op', async () => {
  const before = embedCalls;
  for (const f of FIXTURES) assert.equal((await ingestFx(f)).status, 'unchanged', f);
  assert.equal(embedCalls, before, 'no embedding calls');
});

it('identical bytes under another path are reported as a duplicate', async () => {
  const r = await rag.ingestFile({ buffer: fs.readFileSync(path.join(FX, 'runbook.pdf')), filename: 'copy.pdf', sourceKey: 'elsewhere/copy.pdf' });
  assert.equal(r.status, 'duplicate');
});

it('a changed file replaces its chunks atomically and reuses unchanged vectors', async () => {
  const f = 'checklist.md';
  const orig = await ingestFx(f);
  const oldIds = await mongo.chunkIds(orig.doc_id);
  const edited = fs.readFileSync(path.join(FX, f), 'utf8') + '\n## Post-checks\n\nConfirm monitoring dashboards are green.\n';
  const r = await rag.ingestFile({ buffer: Buffer.from(edited), filename: f, sourceKey: `fixtures/${f}` });
  assert.equal(r.doc_id, orig.doc_id, 'same document identity');
  assert.equal(r.status, 'ready');
  assert.ok(r.reused >= 1 && r.embedded >= 1, JSON.stringify(r));
  const newIds = await mongo.chunkIds(r.doc_id);
  assert.equal(newIds.length, r.chunks);
  assert.equal(await qdrant.count(activeCollection(), { doc_id: r.doc_id }), r.chunks);
  for (const id of oldIds.filter((x) => !newIds.includes(x))) {
    assert.equal(await (await mongo.mongo()).collection('chunks').countDocuments({ _id: id }), 0);
  }
  await assertConsistent();
});

it('a crash mid-embedding resumes without re-embedding finished batches', async () => {
  const long = Array.from({ length: 2000 }, (_, i) => `Step ${i}: Contoso operators verify environment ${i} before the cutover window.`).join('\n\n');
  const buf = Buffer.from(`# Long runbook\n\n${long}`);
  embedCalls = 0; failAfter = 2;
  try {
    await assert.rejects(rag.ingestFile({ buffer: buf, filename: 'long.md', sourceKey: 'long.md' }), /simulated crash/);
  } finally { failAfter = Infinity; }
  const docId = rag.docIdFor('release', 'long.md');
  const job = await mongo.getJob(docId);
  assert.equal(job.status, 'failed');
  assert.equal(job.stage, 'chunked');
  const staged = await (await mongo.mongo()).collection('chunk_staging').countDocuments({ doc_id: docId });
  const stagedDone = await (await mongo.mongo()).collection('chunk_staging').countDocuments({ doc_id: docId, [`embeddings.${KEY_A}`]: { $exists: true } });
  assert.ok(stagedDone > 0 && stagedDone < staged, `${stagedDone}/${staged}`);

  const r = await rag.ingestFile({ buffer: buf, filename: 'long.md', sourceKey: 'long.md' });
  assert.equal(r.status, 'ready');
  assert.equal(r.reused, stagedDone, 'finished batches reused');
  assert.equal(r.embedded, staged - stagedDone, 'only the remainder embedded');
  assert.equal((await mongo.getJob(docId)).stage, 'indexed');
  await assertConsistent();
});

it('Restricted files are recorded and mirrored, not embedded', async () => {
  const r = await rag.ingestFile({ buffer: Buffer.from('Contoso board minutes: secret.'), filename: 'board.txt', sourceKey: 'board.txt', sensitivity: 'Restricted' });
  assert.equal(r.status, 'restricted');
  assert.equal(r.chunks, 0);
  const doc = await mongo.getDocument(r.doc_id);
  assert.equal(doc.chunk_count, 0);
  assert.equal(await qdrant.count(activeCollection(), { doc_id: r.doc_id }), 0);
  assert.equal(pages.get(doc.page_id).sensitivity, 'Restricted');
});

it('remask: a name protected after ingest disappears from every store; only changed chunks re-embed', async () => {
  const r = await rag.ingestFile({ buffer: Buffer.from('# Vendors\n\nFabrikam Logistics ships the hardware.\n\n## Other\n\nUnrelated paragraph.'), filename: 'vendors.md', sourceKey: 'vendors.md' });
  const before = await mongo.chunkIds(r.doc_id);
  assert.match(await dumpAll(), /Fabrikam/, 'not yet protected');

  setSetting('rag_ingested', '1');
  guard.addEntity({ canonical: 'Fabrikam Logistics' });
  const out = await rag.remaskAfterRegistryChange();
  assert.ok(out.stale >= 1, JSON.stringify(out));
  const mine = out.remasked.find((d) => d.doc_id === r.doc_id);
  assert.equal(mine.changed, 1);
  assert.equal(mine.reembedded, 1);
  assert.doesNotMatch(await dumpAll(), LEAK);
  const after = await mongo.chunkIds(r.doc_id);
  assert.equal(after.filter((id) => before.includes(id)).length, before.length - 1, 'unchanged chunk keeps its id');
  assert.equal((await rag.status()).stale_documents, 0);
  await assertConsistent();
});

it('Qdrant rebuilds entirely from Mongo (reindex) with matching counts', async () => {
  await qdrant.dropCollection(activeCollection());
  const r = await rag.reindex();
  assert.equal(r.qdrant_count, r.mongo_embedded);
  assert.ok(r.points > 0);
  await assertConsistent();
});

it('exact Mongo kNN and Qdrant ANN agree on the top hit', async () => {
  const [v] = await (await fakeEmbedder('fake-a')).embed(['restore the snapshot rollback deadline']);
  const exact = await mongo.exactSearch(v, KEY_A, { k: 3 });
  const ann = await qdrant.search(activeCollection(), v, { k: 3 });
  assert.equal(ann[0].chunk_id, exact[0].chunk_id);
  assert.ok(Math.abs(ann[0].score - exact[0].score) < 1e-4);
  const filtered = await qdrant.search(activeCollection(), v, { k: 50, filter: { file_type: 'pdf' } });
  assert.ok(filtered.length && filtered.every((h) => h.payload.file_type === 'pdf'));
});

it('blue/green: reembed builds a second collection, activate switches, prune drops the old one', async () => {
  await assert.rejects(rag.activate({ model: 'fake-b' }), /not ready/);
  const r = await rag.reembed({ model: 'fake-b' });
  assert.equal(r.qdrant_count, r.mongo_embedded);
  assert.equal(await qdrant.count(activeCollection()), r.qdrant_count, 'old collection untouched');
  const a = await rag.activate({ model: 'fake-b' });
  assert.equal(a.active, 'fake-b');
  assert.equal(getSetting('rag_embed_model'), 'fake-b');
  const dropped = await rag.prune();
  assert.deepEqual(dropped.map((d) => d.collection), [activeCollection()]);
  assert.equal(await (await mongo.mongo()).collection('chunks').countDocuments({ [`embeddings.${KEY_A}`]: { $exists: true } }), 0);
  setSetting('rag_embed_model', 'fake-a');
});

it('delete removes the document everywhere: Mongo, Qdrant, mirror page, review queue', async () => {
  const docId = rag.docIdFor('release', 'fixtures/runbook.docx');
  const doc = await mongo.getDocument(docId);
  assert.ok(doc);
  assert.equal(await rag.deleteDocument(docId), true);
  assert.equal(await mongo.getDocument(docId), null);
  assert.equal((await mongo.chunkIds(docId)).length, 0);
  for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) assert.equal(await qdrant.count(c, { doc_id: docId }), 0);
  assert.equal(pages.get(doc.page_id), null);
  assert.equal(db().prepare('SELECT COUNT(*) c FROM entity_occurrence WHERE doc_id = ?').get(docId).c, 0);
});

it('collectFiles skips Office lock files and unsupported types', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-collect-'));
  for (const f of ['a.docx', '~$a.docx', 'b.exe', '.hidden.md', 'c.pptx']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'd.pdf'), 'x');
  const keys = rag.collectFiles(dir).map((f) => f.sourceKey.replace(/\\/g, '/'));
  const base = path.basename(dir);
  assert.deepEqual(keys, [`${base}/a.docx`, `${base}/c.pptx`, `${base}/sub/d.pdf`]);
  fs.rmSync(dir, { recursive: true, force: true });
});
