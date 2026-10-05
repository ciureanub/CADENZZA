/** backup -> wipe -> restore round trip on a throwaway namespace (real local Mongo/Qdrant, fake embedder). */
import '../infra/offline-guard.mjs';
import { HOME } from './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CADENZZA_MONGO_DB = `cadenzza_rag_backup_${process.pid}`;
process.env.CADENZZA_QDRANT_PREFIX = `backup${process.pid}`;

const guard = await import('../src/entity/guard.js');
const pages = await import('../src/pages.js');
const { setSetting, getSetting } = await import('../src/db/index.js');
const rag = await import('../src/rag/ingest.js');
const mongo = await import('../src/rag/store/mongo.js');
const qdrant = await import('../src/rag/store/qdrant.js');
const { setEmbedderFactory, modelKey } = await import('../src/rag/embed/index.js');
const { backupAll, restoreRag, wipeRag } = await import('../src/rag/backup.js');
const { RAG } = await import('../src/config.js');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fake = (id) => Promise.resolve({
  id, key: modelKey(id), dim: 16, digest: 'fake',
  embed: async (texts) => texts.map((t) => { const v = new Float32Array(16); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 16] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); })
});

let up = true;
before(async () => {
  try { await mongo.health(); up = await qdrant.health(); } catch { up = false; }
  if (!up) return console.warn('\n*** RAG services not running: backup.test.js SKIPPED ***\n');
  setEmbedderFactory(fake);
  setSetting('rag_embed_model', 'fake-b');
  guard.addEntity({ canonical: 'Contoso SE' });
  for (const f of ['runbook.docx', 'deck.pptx']) await rag.ingestFile({ buffer: fs.readFileSync(path.join(FX, f)), filename: f, sourceKey: f });
});
after(async () => {
  if (up) {
    for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) await qdrant.dropCollection(c);
    await (await mongo.mongo()).dropDatabase();
  }
  await mongo.close();
});
const it = (name, fn) => test(name, async (t) => { if (!up) return t.skip('services down'); await fn(t); });

it('backup -> wipe -> restore brings back identical chunks and vectors, and rebuilds Qdrant', async () => {
  const before = await mongo.counts(modelKey('fake-b'));
  const [v] = await (await fake('fake-b')).embed(['restore the snapshot']);
  const hitsBefore = await mongo.exactSearch(v, modelKey('fake-b'), { k: 3 });
  const pageIds = (await mongo.listDocuments()).map((d) => d.page_id);

  const dir = path.join(HOME, 'bk');
  const { manifest } = await backupAll(dir);
  assert.equal(manifest.sqlite.integrity, 'ok');
  assert.equal(manifest.collections.chunks, before.chunks);
  assert.ok(fs.existsSync(path.join(dir, 'vault.key')) && fs.existsSync(path.join(dir, 'cadenzza.db')));
  assert.equal(fs.readdirSync(path.join(dir, 'rag', 'sources')).filter((f) => f.endsWith('.bin')).length, 2);

  const w = await wipeRag();
  assert.equal(w.documents, 2);
  assert.equal((await mongo.counts()).chunks, 0);
  assert.equal(await qdrant.count(qdrant.collectionName(modelKey('fake-b'), 16)), 0);
  for (const id of pageIds) assert.equal(pages.get(id), null, 'mirror pages removed');
  assert.equal(getSetting('rag_ingested'), '0');

  const r = await restoreRag(dir);
  assert.equal(r.counts.chunks, before.chunks);
  assert.equal(r.reindex.qdrant_count, before.chunks);
  const hitsAfter = await mongo.exactSearch(v, modelKey('fake-b'), { k: 3 });
  assert.deepEqual(hitsAfter, hitsBefore, 'vectors survive the EJSON round trip bit-exact');
  assert.equal(rag.hasSource((await mongo.listDocuments())[0]._id), true);
  await assert.rejects(restoreRag(dir), /not empty/);
});

it('backup works when no source files are stored (documents ingested before 0.2 source copies)', async () => {
  fs.rmSync(path.join(HOME, 'rag', 'sources'), { recursive: true, force: true });
  const { manifest } = await backupAll(path.join(HOME, 'bk-nosources'));
  assert.equal(manifest.sqlite.integrity, 'ok');
  assert.ok(manifest.collections.chunks > 0);
});
