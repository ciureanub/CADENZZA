/**
 * RAG HTTP routes for the UI: drop/ingest, live progress (SSE), library, models, status.
 * Every value returned is pseudonymised (titles, filenames, errors); the only real-name path
 * is the explicit, audited /api/unmask in index.js.
 */
import path from 'node:path';
import * as guard from '../entity/guard.js';
import * as rag from '../rag/ingest.js';
import * as mongo from '../rag/store/mongo.js';
import { SUPPORTED } from '../rag/extract/index.js';
import { SENSITIVITY, RAG, canonicalSpace } from '../config.js';
import { getSetting } from '../db/index.js';
import * as pages from '../pages.js';

/** Browser-supplied relative path ("folder/sub/file.pdf") -> safe source key; no traversal. */
export function sourceKeyOf(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/').slice(0, 400) || 'unnamed';
}

const docView = (d, jobs) => ({
  doc_id: d._id,
  title: d.title,
  filename: d.filename,
  file_type: d.file_type,
  space: d.space,
  sensitivity: d.sensitivity,
  status: d.status,
  chunk_count: d.chunk_count ?? 0,
  pages: d.pages,
  needs_ocr: d.needs_ocr,
  warnings: d.warnings || [],
  embed_models: d.embed_models || [],
  page_id: d.page_id,
  ingested_at: d.ingested_at,
  updated_at: d.updated_at,
  job: jobs.get(d._id) || null,
  has_source: rag.hasSource(d._id)
});

export async function registerRagRoutes(app) {
  /* ---- drop / upload: queue each file, answer at once; progress arrives over /api/rag/events ---- */
  app.post('/api/rag/ingest', async (req, reply) => {
    if (!(req.headers['content-type'] || '').includes('multipart/form-data')) return reply.code(400).send({ error: 'multipart/form-data required' });
    const space = canonicalSpace(String(req.query.space || 'release'));
    const sensitivity = req.query.sensitivity ? String(req.query.sensitivity) : null;
    if (!pages.spaceByKey(space)) return reply.code(400).send({ error: `unknown space: ${space}` });
    if (sensitivity && !SENSITIVITY.includes(sensitivity)) return reply.code(400).send({ error: `invalid sensitivity: ${sensitivity}` });
    if (guard.registrySize() === 0 && req.query.allow_empty_registry !== '1') {
      return reply.code(409).send({ error: 'The protected-entity registry is empty. Add your clients in Guard first, so names are pseudonymised before anything is embedded.' });
    }

    const queued = [], rejected = [];
    for await (const part of req.files()) {
      const buffer = await part.toBuffer();
      const sourceKey = sourceKeyOf(part.filename);
      const filename = path.basename(sourceKey);
      const shown = guard.mask(filename);
      if (!SUPPORTED.includes(path.extname(filename).toLowerCase())) { rejected.push({ filename: shown, error: `unsupported type ${path.extname(filename) || '(none)'}` }); continue; }
      if (!buffer.length) { rejected.push({ filename: shown, error: 'empty file' }); continue; }
      const doc_id = rag.docIdFor(space, sourceKey);
      rag.events.emit('progress', { doc_id, stage: 'queued', filename: shown, at: new Date().toISOString() });
      rag.queue.push(() => rag.ingestFile({ buffer, filename, sourceKey, space, sensitivity, force: req.query.force === '1' }))
        .catch(() => { /* failure already reported as a 'failed' progress event and on the job */ });
      queued.push({ doc_id, filename: shown });
    }
    return reply.code(202).send({ queued, rejected });
  });

  /* ---- live progress: one SSE stream of masked pipeline events ---- */
  app.get('/api/rag/events', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const send = (e) => res.write(`event: progress\ndata: ${JSON.stringify(e)}\n\n`);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    rag.events.on('progress', send);
    res.write(`event: hello\ndata: ${JSON.stringify({ queue: rag.queue.size })}\n\n`);
    res.on('close', () => { clearInterval(beat); rag.events.off('progress', send); });
  });

  /* ---- library ---- */
  app.get('/api/rag/documents', async () => {
    const jobs = new Map((await mongo.listJobs()).map((j) => [j._id, { status: j.status, stage: j.stage, error: j.error, updated_at: j.updated_at }]));
    return (await mongo.listDocuments()).map((d) => docView(d, jobs));
  });

  app.delete('/api/rag/documents/:id', async (req, reply) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: 'invalid id' });
    const found = await rag.queue.push(() => rag.deleteDocument(id));
    return found ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/rag/documents/:id/reingest', async (req, reply) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: 'invalid id' });
    if (!rag.hasSource(id)) return reply.code(409).send({ error: 'Source file not stored for this document. Re-ingest it from disk: cadenzza rag ingest <path> --force' });
    rag.events.emit('progress', { doc_id: id, stage: 'queued', at: new Date().toISOString() });
    rag.queue.push(() => rag.reingest(id)).catch(() => {});
    return reply.code(202).send({ queued: id });
  });

  /* ---- status + models for the header and settings ---- */
  app.get('/api/rag/status', async () => {
    const s = await rag.status();
    return { ...s, docs: undefined, queue: rag.queue.size };
  });

  app.get('/api/rag/models', async (req, reply) => {
    try {
      const r = await fetch(`${RAG.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const { models } = await r.json();
      return {
        embed_model: getSetting('rag_embed_model'),
        gen_model: getSetting('rag_gen_model'),
        installed: models.map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size, digest: m.digest.slice(0, 12) }))
      };
    } catch (err) {
      return reply.code(503).send({ error: `Ollama not reachable: ${err.message}` });
    }
  });
}
