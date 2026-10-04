/**
 * Phase 5: retrieval + generation. Real local Mongo/Qdrant (throwaway namespace), fake embedder,
 * fake generator that records the prompt it was given and streams a scripted answer.
 */
import '../infra/offline-guard.mjs';
import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CADENZZA_MONGO_DB = `cadenzza_rag_asktest_${process.pid}`;
process.env.CADENZZA_QDRANT_PREFIX = `asktest${process.pid}`;

const guard = await import('../src/entity/guard.js');
const { setSetting, db } = await import('../src/db/index.js');
const rag = await import('../src/rag/ingest.js');
const mongo = await import('../src/rag/store/mongo.js');
const qdrant = await import('../src/rag/store/qdrant.js');
const { setEmbedderFactory, modelKey } = await import('../src/rag/embed/index.js');
const { setGeneratorFactory } = await import('../src/rag/generate/index.js');
const { ask, maskingStream } = await import('../src/rag/ask.js');
const { retrieve } = await import('../src/rag/retrieve.js');
const { citedNumbers, isRefusal, NOT_FOUND, fitContexts } = await import('../src/rag/prompt.js');
const { buildServer } = await import('../src/server/index.js');
const { RAG } = await import('../src/config.js');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fakeEmbedder(id) {
  const dim = 64;
  return Promise.resolve({
    id, key: modelKey(id), dim, digest: 'fake',
    async embed(texts) {
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

let lastMessages = null, script = 'If the cutover fails, CLIENT_A restores the snapshot [1].';
function fakeGenerator(id) {
  return {
    id,
    async chat(messages, { onToken }) {
      lastMessages = messages;
      for (const piece of script.match(/.{1,3}/gs)) onToken(piece);
      return { text: script, stats: { first_token_ms: 5, prompt_tokens: 100, output_tokens: 20 } };
    }
  };
}

let up = true;
before(async () => {
  try { await mongo.health(); up = await qdrant.health(); } catch { up = false; }
  if (!up) { console.warn('\n*** RAG services not running: ask.test.js SKIPPED ***\n'); return; }
  setEmbedderFactory(fakeEmbedder);
  setGeneratorFactory(fakeGenerator);
  setSetting('rag_embed_model', 'fake-a');
  guard.addEntity({ canonical: 'Contoso SE', aliases: ['contoso.com'] });
  guard.addEntity({ canonical: 'Northwind Traders' });
  for (const f of ['runbook.docx', 'runbook.pdf', 'deck.pptx', 'checklist.md', 'environments.html']) {
    await rag.ingestFile({ buffer: fs.readFileSync(path.join(FX, f)), filename: f, sourceKey: f });
  }
});

after(async () => {
  if (up) {
    for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) await qdrant.dropCollection(c);
    await (await mongo.mongo()).dropDatabase();
  }
  await mongo.close();
});

const it = (name, fn) => test(name, async (t) => { if (!up) return t.skip('services down'); await fn(t); });

/* ---------------- pure ---------------- */

test('citedNumbers: singles, lists, ranges, out-of-range dropped, order of first use', () => {
  assert.deepEqual(citedNumbers('A [2]. B [1][3]. C [2, 4]. D [5-6]. E [9].', 6), [2, 1, 3, 4, 5, 6]);
  assert.deepEqual(citedNumbers('no citations', 3), []);
});

test('isRefusal accepts the exact phrase with or without quotes', () => {
  assert.ok(isRefusal(NOT_FOUND));
  assert.ok(isRefusal(`"${NOT_FOUND}"`));
  assert.ok(!isRefusal('Restore the snapshot [1].'));
});

test('fitContexts respects the budget but always keeps one', () => {
  const big = { text: 'x '.repeat(3000) };
  assert.equal(fitContexts([big, big], 100).length, 1);
  assert.equal(fitContexts([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 1000).length, 3);
});

/* ---------------- retrieval ---------------- */

it('the question is masked before retrieval: real and pseudonymous wording retrieve the same chunks', async () => {
  const a = await retrieve('How does Contoso roll back a failed cutover snapshot?', { mode: 'dense' });
  const b = await retrieve('How does CLIENT_A roll back a failed cutover snapshot?', { mode: 'dense' });
  assert.equal(a.question_masked, 'How does CLIENT_A roll back a failed cutover snapshot?');
  assert.deepEqual(a.hits.map((h) => h.chunk_id), b.hits.map((h) => h.chunk_id));
});

it('hybrid fuses dense and lexical ranks; exact and dense agree on the top hit', async () => {
  const h = await retrieve('restore snapshot rollback', { mode: 'hybrid', k: 6 });
  assert.ok(h.hits.length > 0);
  assert.ok(h.hits.some((x) => x.dense_rank && x.lexical_rank), 'at least one chunk found by both');
  assert.ok(h.hits.every((x, i, a) => i === 0 || a[i - 1].score >= x.score), 'sorted by fused score');
  const d = await retrieve('restore snapshot rollback', { mode: 'dense', k: 3 });
  const e = await retrieve('restore snapshot rollback', { mode: 'exact', k: 3 });
  assert.equal(d.hits[0].chunk_id, e.hits[0].chunk_id);
});

it('filters restrict retrieval (file_type, doc)', async () => {
  const r = await retrieve('cutover', { mode: 'hybrid', k: 10, filter: { file_type: 'pdf' } });
  assert.ok(r.hits.length && r.hits.every((h) => h.doc.file_type === 'pdf'));
});

it('falls back to exact Mongo search when the Qdrant collection is unavailable', async () => {
  const saved = process.env.CADENZZA_QDRANT_PREFIX;
  process.env.CADENZZA_QDRANT_PREFIX = 'nonexistent_prefix';
  try {
    const r = await retrieve('restore snapshot', { mode: 'dense' });
    assert.ok(r.fallback, 'fallback recorded');
    assert.ok(r.hits.length > 0);
  } finally { process.env.CADENZZA_QDRANT_PREFIX = saved; }
});

/* ---------------- ask ---------------- */

it('ask: prompt contains only pseudonyms; answer cites sources mapped to file + section + page', async () => {
  script = 'If the cutover fails, CLIENT_A restores the snapshot taken at T-0 [1].';
  const tokens = [];
  const r = await ask('What does Contoso do if the cutover fails?', { mode: 'hybrid', onToken: (d) => tokens.push(d) });
  const prompt = JSON.stringify(lastMessages);
  assert.doesNotMatch(prompt, /contoso|northwind|jane\.doe/i);
  assert.match(prompt, /Question: What does CLIENT_A do if the cutover fails\?/);
  assert.match(prompt, /Use ONLY the numbered sources/);
  assert.equal(r.answer, script);
  assert.equal(tokens.join(''), script, 'streamed text equals final answer');
  assert.equal(r.refused, false);
  const c1 = r.citations.find((c) => c.n === 1);
  assert.equal(c1.cited, true);
  assert.ok(c1.title && Array.isArray(c1.heading_path) && c1.chunk_id && c1.doc_id && c1.page_id);
  assert.ok(r.timings.total_ms >= 0 && r.timings.embed_ms >= 0 && r.timings.search_ms >= 0);
});

it('ask: a model that "guesses" a real name is re-masked, in the stream and the result', async () => {
  script = 'Contoso SE (jane.doe@contoso.com) restores the snapshot and calls Northwind Traders [1].';
  const tokens = [];
  const r = await ask('who restores the snapshot?', { onToken: (d) => tokens.push(d) });
  const streamed = tokens.join('');
  assert.doesNotMatch(streamed, /contoso|northwind|jane/i, `stream leaked: ${streamed}`);
  assert.doesNotMatch(r.answer, /contoso|northwind|jane/i);
  assert.equal(r.answer, 'CLIENT_A ([PERSON_EMAIL]) restores the snapshot and calls CLIENT_B [1].');
  const row = db().prepare("SELECT detail FROM audit_event WHERE action='rag.ask' ORDER BY id DESC").get();
  assert.match(row.detail, /"remasked_output":true/);
  assert.doesNotMatch(row.detail, /contoso|northwind/i);
});

it('ask: refusal is detected and nothing is marked cited', async () => {
  script = NOT_FOUND;
  const r = await ask('What is the office canteen menu?');
  assert.equal(r.refused, true);
  assert.ok(r.citations.every((c) => !c.cited));
});

it('ask: an answer without citations is flagged uncited', async () => {
  script = 'Restore the snapshot.';
  const r = await ask('rollback?');
  assert.equal(r.uncited, true);
});

it('ask: audit row holds masked question, chunk ids + scores, prompt version, models, latency', async () => {
  script = 'Restore the snapshot [1].';
  await ask('Contoso rollback?');
  const d = JSON.parse(db().prepare("SELECT detail FROM audit_event WHERE action='rag.ask' ORDER BY id DESC").get().detail);
  assert.equal(d.question_masked, 'CLIENT_A rollback?');
  assert.ok(d.retrieved.length && d.retrieved[0].length === 2);
  assert.equal(d.prompt_version, 'qa-v1');
  assert.ok(d.gen_model && d.embed_model && d.latency_ms >= 0);
});

/* ---------------- streaming masker ---------------- */

test('maskingStream never emits a protected surface split across tokens', () => {
  const out = [];
  const s = maskingStream((d) => out.push(d));
  const text = 'Escalate to North' + 'wind Tra' + 'ders and mail jane.d' + 'oe@contoso' + '.com today. ' + 'More filler text so the hold-back window releases the earlier part of the sentence safely and completely.';
  for (const ch of text.match(/.{1,2}/gs)) s.push(ch);
  const fin = s.end();
  const streamed = out.join('');
  assert.doesNotMatch(streamed, /northwind|jane|contoso/i);
  assert.equal(streamed, fin.text);
  assert.equal(fin.replaced, false);
});

/* ---------------- HTTP ---------------- */

it('POST /api/ask streams sources, tokens and done as SSE', async () => {
  script = 'Restore the snapshot [1].';
  const app = await buildServer();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/ask', payload: { question: 'How do we roll back?', k: 4 } });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    const events = r.body.trim().split('\n\n').map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
    assert.equal(events[0].event, 'sources');
    assert.ok(events.some((e) => e.event === 'token'));
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.answer, 'Restore the snapshot [1].');
    assert.equal(events.filter((e) => e.event === 'token').map((e) => e.data.delta).join(''), done.data.answer);
  } finally { await app.close(); }
});

it('POST /api/ask validates input', async () => {
  const app = await buildServer();
  try {
    for (const payload of [{}, { question: 'x', k: 99 }, { question: 'x', mode: 'magic' }, { question: 'x', filter: { space: { $ne: 1 } } }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/ask', payload })).statusCode, 400, JSON.stringify(payload));
    }
  } finally { await app.close(); }
});

it('POST /api/unmask reveals only on request, audits it, and never confuses CLIENT_A with CLIENT_AA', async () => {
  for (let i = 0; i < 25; i++) guard.addEntity({ canonical: `Filler Org ${i}` });
  const aa = guard.listEntities().find((e) => e.pseudonym === 'CLIENT_AA');
  assert.ok(aa, 'CLIENT_AA allocated');
  const app = await buildServer();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/unmask', payload: { text: 'CLIENT_A and CLIENT_AA met.' } });
    assert.equal(r.json().text, `Contoso SE and ${aa.canonical} met.`);
    const reveals = db().prepare("SELECT COUNT(*) c FROM audit_event WHERE action='vault.reveal'").get().c;
    assert.ok(reveals >= 2);
    assert.ok(db().prepare("SELECT COUNT(*) c FROM audit_event WHERE action='reveal.request'").get().c >= 1);
  } finally { await app.close(); }
});
