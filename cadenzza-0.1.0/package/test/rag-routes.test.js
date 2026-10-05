/**
 * Library API: upload -> live SSE progress -> documents -> re-ingest -> delete.
 * Real local Mongo/Qdrant (throwaway namespace), fake embedder, real HTTP server on an ephemeral port.
 */
import '../infra/offline-guard.mjs';
import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CADENZZA_MONGO_DB = `cadenzza_rag_routes_${process.pid}`;
process.env.CADENZZA_QDRANT_PREFIX = `routes${process.pid}`;

const guard = await import('../src/entity/guard.js');
const { setSetting } = await import('../src/db/index.js');
const pages = await import('../src/pages.js');
const mongo = await import('../src/rag/store/mongo.js');
const qdrant = await import('../src/rag/store/qdrant.js');
const { setEmbedderFactory, modelKey } = await import('../src/rag/embed/index.js');
const { buildServer } = await import('../src/server/index.js');
const { sourceKeyOf } = await import('../src/server/rag-routes.js');
const { RAG } = await import('../src/config.js');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fake = (id) => Promise.resolve({
  id, key: modelKey(id), dim: 16, digest: 'fake',
  embed: async (texts) => texts.map((t) => { const v = new Float32Array(16); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 16] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); })
});

let up = true, app, base;
before(async () => {
  try { await mongo.health(); up = await qdrant.health(); } catch { up = false; }
  if (!up) { console.warn('\n*** RAG services not running: rag-routes.test.js SKIPPED ***\n'); return; }
  setEmbedderFactory(fake);
  setSetting('rag_embed_model', 'fake-r');
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  if (app) await app.close();
  if (up) {
    for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) await qdrant.dropCollection(c);
    await (await mongo.mongo()).dropDatabase();
  }
  await mongo.close();
});
const it = (name, fn) => test(name, async (t) => { if (!up) return t.skip('services down'); await fn(t); });

function form(files) {
  const fd = new FormData();
  for (const [rel, buf] of files) fd.append('file', new Blob([buf]), rel);
  return fd;
}

/** Collect SSE progress events until `until(events)` is true. */
async function watch(until, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/rag/events`, { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  const events = [];
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const ready = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = (frame.match(/^data: (.+)$/m) || [])[1];
          if (/^event: progress/m.test(frame) && data) events.push(JSON.parse(data));
          if (until(events)) { ctrl.abort(); return events; }
        }
      }
    } catch { /* aborted */ }
    return events;
  })();
  return { events: ready.finally(() => clearTimeout(timer)) };
}

test('sourceKeyOf strips traversal and drive-relative parts', () => {
  assert.equal(sourceKeyOf('../../etc/passwd'), 'etc/passwd');
  assert.equal(sourceKeyOf('Folder\\sub\\file.pdf'), 'Folder/sub/file.pdf');
  assert.equal(sourceKeyOf('/abs/./x.md'), 'abs/x.md');
});

it('refuses uploads while the registry is empty (409)', async () => {
  const r = await fetch(`${base}/api/rag/ingest`, { method: 'POST', body: form([['a.md', '# A']]) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /registry is empty/);
});

it('upload -> SSE progress through indexed -> documents list -> mirror page', async () => {
  guard.addEntity({ canonical: 'Contoso SE', aliases: ['contoso.com'] });
  guard.addEntity({ canonical: 'Northwind Traders' });
  const w = await watch((ev) => ev.filter((e) => e.stage === 'indexed').length >= 2);
  const r = await fetch(`${base}/api/rag/ingest?space=deployment`, {
    method: 'POST',
    body: form([['Contoso folder/runbook.docx', fs.readFileSync(path.join(FX, 'runbook.docx'))], ['Contoso folder/checklist.md', fs.readFileSync(path.join(FX, 'checklist.md'))], ['tool.exe', 'MZ']])
  });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.equal(body.queued.length, 2);
  assert.deepEqual(body.rejected.map((x) => x.filename), ['tool.exe']);
  const events = await w.events;
  const stages = events.map((e) => e.stage);
  for (const s of ['queued', 'started', 'masked', 'chunked', 'embedding', 'indexed']) assert.ok(stages.includes(s), `stage ${s}: ${stages}`);
  assert.doesNotMatch(JSON.stringify(events), /contoso|northwind/i, 'progress events are masked');
  assert.doesNotMatch(JSON.stringify(body), /contoso/i, 'upload response is masked');

  const docs = await (await fetch(`${base}/api/rag/documents`)).json();
  assert.equal(docs.length, 2);
  for (const d of docs) {
    assert.equal(d.status, 'ready');
    assert.equal(d.space, 'deployment');
    assert.ok(d.has_source && d.page_id && d.chunk_count > 0);
    assert.equal(pages.get(d.page_id).type, 'source-capture');
  }
  assert.doesNotMatch(JSON.stringify(docs), /contoso|northwind/i);
});

it('re-ingest from the stored source runs again; delete removes everything', async () => {
  const [doc] = await (await fetch(`${base}/api/rag/documents`)).json();
  const w = await watch((ev) => ev.some((e) => e.doc_id === doc.doc_id && e.stage === 'indexed'));
  const r = await fetch(`${base}/api/rag/documents/${doc.doc_id}/reingest`, { method: 'POST' });
  assert.equal(r.status, 202);
  await w.events;

  const d = await fetch(`${base}/api/rag/documents/${doc.doc_id}`, { method: 'DELETE' });
  assert.equal(d.status, 200);
  assert.equal(pages.get(doc.page_id), null);
  const left = await (await fetch(`${base}/api/rag/documents`)).json();
  assert.ok(!left.some((x) => x.doc_id === doc.doc_id));
  assert.equal((await fetch(`${base}/api/rag/documents/${doc.doc_id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/rag/documents/not-an-id`, { method: 'DELETE' })).status, 400);
});

it('status, models and settings endpoints', async () => {
  const s = await (await fetch(`${base}/api/rag/status`)).json();
  assert.ok(s.mongo.documents >= 1 && Array.isArray(s.collections) && s.docs === undefined);
  const meta = await (await fetch(`${base}/api/meta`)).json();
  for (const k of ['rag_gen_model', 'rag_retrieval', 'rag_top_k', 'rag_embed_restricted', 'rag_create_page']) assert.ok(k in meta.settings, k);
  const bad = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rag_embed_model: 'other' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /read-only.*reembed/);
  const ok = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rag_top_k: '8', rag_retrieval: 'dense' }) });
  assert.equal(ok.status, 200);
});
