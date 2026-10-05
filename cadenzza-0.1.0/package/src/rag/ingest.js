/**
 * Ingest orchestrator: file -> pipeline (extract, guard, chunk) -> embed -> Mongo -> Qdrant.
 *
 *   idempotent  same doc + same bytes + same registry version + same model = no-op
 *   replacing   a changed file swaps its chunks atomically (Mongo transaction; Qdrant upsert-then-prune)
 *   resumable   chunks are staged in Mongo and embedded in batches; re-running the same ingest
 *               resumes from the vectors already computed
 *   remask      a registry change bumps registry_version; remask() re-runs masking on stored chunks
 *               and re-embeds only the chunks whose text changed
 *
 * Stages per job: extracted -> masked -> chunked -> embedded -> indexed. Only pseudonymised text
 * reaches Mongo, Qdrant, job records, events and the audit log.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as guard from '../entity/guard.js';
import * as vault from '../entity/vault.js';
import * as pages from '../pages.js';
import { getSetting, setSetting, audit } from '../db/index.js';
import { paths, SENSITIVITY, RAG } from '../config.js';
import { prepareDocument } from './pipeline.js';
import { chunkId, uuidv5, sha256, CHUNKER_VERSION } from './chunk.js';
import { SUPPORTED } from './extract/index.js';
import { getEmbedder, modelKey } from './embed/index.js';
import * as mongo from './store/mongo.js';
import * as qdrant from './store/qdrant.js';

export const events = new EventEmitter();
const EMBED_BATCH = 32;

export const activeModel = () => getSetting('rag_embed_model', 'bge-m3');

/** Stable, non-reversible doc id: HMAC (vault key) of space + source path. Same file, same id. */
export function docIdFor(space, sourceKey) {
  const norm = String(sourceKey).replace(/\\/g, '/').toLowerCase();
  return uuidv5(crypto.createHmac('sha256', vault.key()).update(`doc:${space}:${norm}`).digest('hex'));
}

function emit(docId, stage, extra = {}) {
  events.emit('progress', { doc_id: docId, stage, at: new Date().toISOString(), ...extra });
}

const maskErr = (err) => guard.mask(String(err?.message || err)).slice(0, 500);

/* ------------------------------------------------------------------ storage path */

/**
 * Stage rows, embed what is missing, commit to Mongo, sync Qdrant. Shared by ingest and remask.
 * @returns {{ chunks, reused, embedded, embed_ms }}
 */
async function storeChunks(docRec, rows, embedder) {
  const docId = docRec._id;
  const key = embedder.key;
  const { reused } = await mongo.stageChunks(docId, rows, key);
  await mongo.updateJob(docId, {}, 'chunked');
  emit(docId, 'chunked', { chunks: rows.length, reused });

  const missing = await mongo.stagedMissing(docId, key);
  const t0 = performance.now();
  let done = 0;
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await embedder.embed(batch.map((c) => c.embed_text));
    await mongo.setEmbeddings('chunk_staging', key, batch.map((c, j) => ({ _id: c._id, vector: vectors[j] })),
      { model: embedder.id, dim: embedder.dim, digest: embedder.digest });
    done += batch.length;
    emit(docId, 'embedding', { embedded: done, of: missing.length });
  }
  const embed_ms = performance.now() - t0;
  await mongo.updateJob(docId, {}, 'embedded');

  await mongo.commitDocument({ ...docRec, embed_models: [key] });
  await syncQdrant(docId, embedder);
  return { chunks: rows.length, reused, embedded: missing.length, embed_ms };
}

/** Make Qdrant match Mongo for one doc: upsert its points, prune stale ones, in every model's collection. */
async function syncQdrant(docId, embedder) {
  const name = qdrant.collectionName(embedder.key, embedder.dim);
  await qdrant.ensureCollection(name, embedder.dim);
  const points = [];
  for await (const { _id, vector, chunk } of mongo.chunksWithVectors(embedder.key, { doc_id: docId })) {
    points.push({ id: _id, vector, payload: qdrant.payloadOf(chunk, embedder.key) });
  }
  await qdrant.upsert(name, points);
  const keep = points.map((p) => p.id);
  for (const c of await qdrant.listCollections()) {
    if (!c.startsWith(`${RAG.qdrantPrefix}_`)) continue;
    await qdrant.deleteByDoc(c, docId, c === name ? keep : []);
  }
  await mongo.updateJob(docId, { status: 'done', error: null }, 'indexed');
  emit(docId, 'indexed', { points: points.length });
}

const toRows = (docId, chunks, base) => chunks.map((c) => ({
  _id: chunkId(docId, c),
  doc_id: docId,
  chunk_index: c.chunk_index,
  text: c.text,
  embed_text: c.embed_text,
  heading_path: c.heading_path,
  page_start: c.page_start,
  page_end: c.page_end,
  block_types: c.block_types,
  token_estimate: c.token_estimate,
  overlap_tokens: c.overlap_tokens,
  chunk_sha256: c.chunk_sha256,
  chunker_version: c.chunker_version,
  ...base
}));

/* ------------------------------------------------------------------ ingest */

/**
 * @param {object} o { buffer, filename, sourceKey?, space?, sensitivity?, force?, allowEmptyRegistry?, model? }
 * @returns {object} { doc_id, status, title, chunks?, reused?, embedded?, ms }
 */
export async function ingestFile(o) {
  const t0 = performance.now();
  const { buffer, filename, sourceKey = filename, space = 'release', force = false, allowEmptyRegistry = false } = o;
  if (!allowEmptyRegistry && guard.registrySize() === 0) {
    throw new Error('protected-entity registry is empty: register clients first (cadenzza entities add), or pass --allow-empty-registry');
  }
  const sp = pages.spaceByKey(space);
  if (!sp) throw new Error(`unknown space: ${space}`);
  const sensitivity = o.sensitivity || sp.default_sensitivity;
  if (!SENSITIVITY.includes(sensitivity)) throw new Error(`invalid sensitivity: ${sensitivity}`);

  const docId = docIdFor(space, sourceKey);
  const sha = sha256(buffer);
  const embedder = await getEmbedder(o.model || activeModel());
  const regVersion = guard.registryVersion();

  const existing = await mongo.getDocument(docId);
  if (!force && existing && existing.source_sha256 === sha && existing.registry_version === regVersion
      && existing.sensitivity === sensitivity && (existing.status !== 'ready' || existing.embed_models?.includes(embedder.key))
      && (await mongo.getJob(docId))?.status === 'done') {
    emit(docId, 'unchanged');
    return { doc_id: docId, status: 'unchanged', title: existing.title, chunks: existing.chunk_count, ms: performance.now() - t0 };
  }
  const dupe = await mongo.findBySha(sha);
  if (dupe && dupe._id !== docId) {
    emit(docId, 'duplicate', { duplicate_of: dupe._id });
    return { doc_id: docId, status: 'duplicate', duplicate_of: dupe._id, title: dupe.title, ms: performance.now() - t0 };
  }

  await mongo.updateJob(docId, { status: 'running', error: null, filename: guard.mask(filename) });
  emit(docId, 'started', { filename: guard.mask(filename) });
  try {
    const createPage = getSetting('rag_create_page', '1') === '1';
    const prepared = await prepareDocument(buffer, filename, { docId, withLocal: createPage });
    for (const s of ['extracted', 'masked']) await mongo.updateJob(docId, { filename: prepared.filename }, s);
    emit(docId, 'masked', { title: prepared.title, occurrences: prepared.occurrences });

    let pageId = null;
    if (createPage) {
      const fields = { title: prepared.local.title, body_html: prepared.local.html, type: 'source-capture', sensitivity };
      const page = existing?.page_id && pages.get(existing.page_id)
        ? pages.update(existing.page_id, { ...fields, note: 'RAG re-ingest' })
        : pages.create({ space_key: space, ...fields });
      pageId = page.id;
      guard.linkDocOccurrences(docId, pageId);
    }

    const now = new Date();
    const status = prepared.meta.needs_ocr ? 'needs_ocr'
      : sensitivity === 'Restricted' && getSetting('rag_embed_restricted', '0') !== '1' ? 'restricted'
      : prepared.chunks.length ? 'ready' : 'empty';
    const docRec = {
      _id: docId,
      title: prepared.title,
      filename: prepared.filename,
      space,
      sensitivity,
      file_type: prepared.meta.file_type,
      pages: prepared.meta.pages ?? null,
      source_sha256: sha,
      source_bytes: buffer.length,
      extractor: prepared.meta.extractor,
      extractor_version: prepared.meta.extractor_version,
      chunker_version: CHUNKER_VERSION,
      warnings: prepared.meta.warnings,
      needs_ocr: !!prepared.meta.needs_ocr,
      occurrences: prepared.occurrences,
      page_id: pageId,
      registry_version: regVersion,
      status,
      ingested_at: existing?.ingested_at || now,
      updated_at: now
    };

    const rows = status === 'ready'
      ? toRows(docId, prepared.chunks, { source_sha256: sha, space, sensitivity, file_type: docRec.file_type, extractor: docRec.extractor, extractor_version: docRec.extractor_version, ingested_at: now })
      : []; // recorded, not embedded: also clears chunks/points left from an earlier ready version
    const stored = await storeChunks(docRec, rows, embedder);
    setSetting('rag_ingested', '1');
    saveSource(docId, buffer, { filename, sourceKey, space, sensitivity });

    audit('rag.ingest', `doc=${docId} status=${status} chunks=${stored.chunks} embedded=${stored.embedded} model=${embedder.key}`);
    return { doc_id: docId, status, title: prepared.title, ...stored, warnings: prepared.meta.warnings, ms: performance.now() - t0 };
  } catch (err) {
    await mongo.updateJob(docId, { status: 'failed', error: maskErr(err) }).catch(() => {});
    emit(docId, 'failed', { error: maskErr(err) });
    throw err;
  }
}

const SKIP_FILE = /^(?:~\$|\.|Thumbs\.db$|desktop\.ini$)/i;

/** Files under a path that ingest would take, with their source keys. */
export function collectFiles(target) {
  const abs = path.resolve(target);
  const st = fs.statSync(abs);
  if (st.isFile()) {
    const rel = path.relative(paths.importRoot, abs);
    return [{ file: abs, sourceKey: !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(abs) }];
  }
  const out = [];
  const base = path.basename(abs);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_FILE.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (SUPPORTED.includes(path.extname(e.name).toLowerCase())) out.push({ file: full, sourceKey: path.join(base, path.relative(abs, full)) });
    }
  };
  walk(abs);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Ingest a file or a folder, one file at a time; per-file errors are collected, not fatal. */
export async function ingestPath(target, opts = {}, onResult = () => {}) {
  const results = [];
  for (const { file, sourceKey } of collectFiles(target)) {
    let r;
    try {
      r = await ingestFile({ ...opts, buffer: fs.readFileSync(file), filename: path.basename(file), sourceKey });
    } catch (err) {
      r = { status: 'failed', filename: guard.mask(path.basename(file)), error: maskErr(err) };
      if (/registry is empty/.test(err.message)) { onResult(r); results.push(r); break; }
    }
    onResult(r);
    results.push(r);
  }
  return results;
}

/* ------------------------------------------------------------------ maintenance */

export async function deleteDocument(docId) {
  const doc = await mongo.getDocument(docId);
  for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) await qdrant.deleteByDoc(c, docId);
  await mongo.deleteDocument(docId);
  if (doc?.page_id && pages.get(doc.page_id)) pages.remove(doc.page_id);
  guard.clearDocOccurrences(docId);
  removeSource(docId);
  audit('rag.delete', `doc=${docId}`);
  emit(docId, 'deleted');
  return !!doc;
}

/* ------------------------------------------------------------------ local source copies */

/**
 * The original bytes of each ingested file are kept under CADENZZA_HOME/rag/sources so a document
 * can be re-ingested (new extractor/chunker) from the UI. Local only and unmasked, like the
 * mirror page: same back-up / never-commit rule as the database. Mongo and Qdrant never see them.
 */
const sourcesDir = () => { const d = path.join(paths.rag, 'sources'); fs.mkdirSync(d, { recursive: true }); return d; };
const sourcePaths = (docId) => ({ bin: path.join(sourcesDir(), `${docId}.bin`), meta: path.join(sourcesDir(), `${docId}.json`) });

function saveSource(docId, buffer, meta) {
  const p = sourcePaths(docId);
  fs.writeFileSync(p.bin, buffer);
  fs.writeFileSync(p.meta, JSON.stringify(meta));
}

export function hasSource(docId) { return fs.existsSync(sourcePaths(docId).bin); }

function removeSource(docId) {
  const p = sourcePaths(docId);
  for (const f of [p.bin, p.meta]) fs.rmSync(f, { force: true });
}

/** Re-run the full pipeline on a stored source (force: re-extract, re-chunk, re-embed what changed). */
export async function reingest(docId) {
  const p = sourcePaths(docId);
  if (!fs.existsSync(p.bin)) throw new Error('source file not stored for this document; re-ingest it from disk (cadenzza rag ingest <path> --force)');
  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  return ingestFile({ ...meta, buffer: fs.readFileSync(p.bin), force: true });
}

/** Drop and rebuild a model's Qdrant collection entirely from Mongo. */
export async function reindex({ model = activeModel() } = {}) {
  const embedder = await getEmbedder(model);
  const name = qdrant.collectionName(embedder.key, embedder.dim);
  await qdrant.dropCollection(name);
  await qdrant.ensureCollection(name, embedder.dim);
  let batch = [], n = 0;
  for await (const { _id, vector, chunk } of mongo.chunksWithVectors(embedder.key)) {
    batch.push({ id: _id, vector, payload: qdrant.payloadOf(chunk, embedder.key) });
    if (batch.length === 256) { await qdrant.upsert(name, batch); n += batch.length; batch = []; }
  }
  if (batch.length) { await qdrant.upsert(name, batch); n += batch.length; }
  audit('rag.reindex', `collection=${name} points=${n}`);
  return { collection: name, points: n, qdrant_count: await qdrant.count(name), mongo_embedded: (await mongo.counts(embedder.key)).embedded };
}

/** Blue/green step 1: embed every chunk with another model into its own field + collection. Does not switch. */
export async function reembed({ model }, onProgress = () => {}) {
  const embedder = await getEmbedder(model);
  let done = 0;
  for (;;) {
    const batch = await mongo.chunksMissing(embedder.key, 64);
    if (!batch.length) break;
    const vectors = await embedder.embed(batch.map((c) => c.embed_text));
    await mongo.setEmbeddings('chunks', embedder.key, batch.map((c, i) => ({ _id: c._id, vector: vectors[i] })),
      { model: embedder.id, dim: embedder.dim, digest: embedder.digest });
    done += batch.length;
    onProgress(done);
  }
  const idx = await reindex({ model });
  audit('rag.reembed', `model=${embedder.key} embedded=${done}`);
  return { model: embedder.id, embedded: done, ...idx };
}

/** Blue/green step 2: point the app at a fully embedded + indexed model. */
export async function activate({ model }) {
  const embedder = await getEmbedder(model);
  const c = await mongo.counts(embedder.key);
  const name = qdrant.collectionName(embedder.key, embedder.dim);
  const points = await qdrant.count(name);
  if (c.embedded !== c.chunks || points !== c.chunks) {
    throw new Error(`${model} is not ready: ${c.embedded}/${c.chunks} chunks embedded, ${points} points in ${name}. Run: cadenzza rag reembed --model ${model}`);
  }
  const previous = activeModel();
  setSetting('rag_embed_model', model);
  audit('rag.activate', `model=${model} previous=${previous}`);
  return { previous, active: model, collection: name };
}

/** Blue/green step 3: drop collections and stored vectors of every model except the active one. */
export async function prune() {
  const keep = modelKey(activeModel());
  const dropped = [];
  for (const c of await qdrant.listCollections()) {
    const m = c.slice(RAG.qdrantPrefix.length + 1).replace(/_\d+$/, '');
    if (c.startsWith(`${RAG.qdrantPrefix}_`) && m !== keep) {
      await qdrant.dropCollection(c);
      const unset = await mongo.dropEmbeddings(m);
      dropped.push({ collection: c, vectors_removed: unset });
    }
  }
  audit('rag.prune', JSON.stringify(dropped.map((d) => d.collection)));
  return dropped;
}

/**
 * Re-apply masking to stored documents whose registry_version is behind (a name was protected
 * after they were ingested). Only chunks whose text changes are re-embedded.
 */
export async function remask({ model = activeModel() } = {}) {
  const embedder = await getEmbedder(model);
  const version = guard.registryVersion();
  const stale = await mongo.listDocuments({ $or: [{ registry_version: { $lt: version } }, { registry_version: { $exists: false } }] });
  const out = [];
  for (const doc of stale) {
    const db = await mongo.mongo();
    const old = await db.collection('chunks').find({ doc_id: doc._id }, { projection: { embeddings: 0 } }).sort({ chunk_index: 1 }).toArray();
    const docRec = { ...doc, title: guard.mask(doc.title), filename: guard.mask(doc.filename), registry_version: version, updated_at: new Date() };
    const rows = old.map((c) => {
      const text = guard.mask(c.text);
      const embed_text = guard.mask(c.embed_text);
      const changed = embed_text !== c.embed_text;
      const chunk_sha256 = changed ? sha256(embed_text) : c.chunk_sha256;
      const row = { ...c, text, embed_text, heading_path: c.heading_path.map((h) => guard.mask(h)), chunk_sha256 };
      row._id = changed ? chunkId(doc._id, { chunk_index: c.chunk_index, chunk_sha256 }) : c._id;
      guard.assertClean(row, `remask ${doc._id}#${c.chunk_index}`);
      return row;
    });
    guard.assertClean({ title: docRec.title, filename: docRec.filename }, `remask ${doc._id}`);
    const changedCount = rows.filter((r, i) => r._id !== old[i]._id).length;
    await mongo.updateJob(doc._id, { status: 'running', error: null });
    const stored = await storeChunks(docRec, rows, embedder);
    audit('rag.remask', `doc=${doc._id} changed=${changedCount} reembedded=${stored.embedded}`);
    out.push({ doc_id: doc._id, chunks: rows.length, changed: changedCount, reembedded: stored.embedded });
  }
  return out;
}

export async function status() {
  const model = activeModel();
  const key = modelKey(model);
  const docs = await mongo.listDocuments();
  const byStatus = {};
  for (const d of docs) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  const c = await mongo.counts(key);
  const collections = [];
  for (const name of await qdrant.listCollections()) {
    if (name.startsWith(`${RAG.qdrantPrefix}_`)) collections.push({ name, points: await qdrant.count(name) });
  }
  const version = guard.registryVersion();
  return {
    active_model: model,
    registry: { entities: guard.registrySize(), version },
    mongo: c,
    documents_by_status: byStatus,
    stale_documents: docs.filter((d) => (d.registry_version ?? -1) < version).length,
    jobs_running: (await mongo.listJobs({ status: 'running' })).length,
    collections,
    docs
  };
}

/**
 * Called after any registry change (CLI, API, review queue). Re-masks stale documents if any exist.
 * Never throws: if the services are down the documents stay stale, and doctor / rag status say so.
 */
export async function remaskAfterRegistryChange() {
  if (getSetting('rag_ingested', '0') !== '1') return { stale: 0 }; // RAG never used: nothing to do
  try {
    if (!(await mongo.listDocuments({ registry_version: { $lt: guard.registryVersion() } })).length) return { stale: 0 };
    const done = await remask();
    return { stale: done.length, remasked: done };
  } catch (err) {
    audit('rag.remask.deferred', maskErr(err));
    return { error: maskErr(err) };
  }
}

/* ------------------------------------------------------------------ queue */

/** Bounded FIFO for the server: one ingest at a time keeps embedding from starving the UI. */
export function createQueue(concurrency = 1) {
  const pending = [];
  let active = 0;
  const next = () => {
    while (active < concurrency && pending.length) {
      const { fn, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return {
    push(fn) { return new Promise((resolve, reject) => { pending.push({ fn, resolve, reject }); next(); }); },
    get size() { return pending.length + active; }
  };
}

/** The server's single ingest/remask lane. */
export const queue = createQueue(1);
