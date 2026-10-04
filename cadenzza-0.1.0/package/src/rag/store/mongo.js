/**
 * MongoDB: system of record for the RAG corpus. Everything stored here is pseudonymised.
 *
 *   documents      one per source file   { _id: doc_id, title, filename, space, sensitivity, source_sha256, status, ... }
 *   chunks         { _id: chunk_id, doc_id, chunk_index, text, embed_text, ..., embeddings: { <modelKey>: { vector, dim, digest, model, embedded_at } } }
 *   chunk_staging  chunks of an ingest in progress (resumable embedding)
 *   ingest_jobs    { _id: doc_id, stage, status, error, stages: { <stage>: ts }, attempts }
 *
 * Vectors are BSON Float32 (subtype 9). Embeddings are keyed by model so a re-embed can be
 * built next to the active one (blue/green) and Qdrant can always be rebuilt from here.
 * The second retriever is exact cosine kNN in Node (record-only Mongo, option c).
 */
import { MongoClient, Binary } from 'mongodb';
import { RAG } from '../../config.js';

let _client = null;
let _db = null;

export async function mongo() {
  if (_db) return _db;
  _client = new MongoClient(RAG.mongoUri, { serverSelectionTimeoutMS: 3000 });
  await _client.connect();
  _db = _client.db(RAG.mongoDb);
  await ensureIndexes(_db);
  return _db;
}

export const client = () => _client;

export async function close() {
  if (_client) await _client.close().catch(() => {});
  _client = null;
  _db = null;
}

async function ensureIndexes(db) {
  await db.collection('documents').createIndexes([
    { key: { source_sha256: 1 }, name: 'uniq_source_sha256', unique: true, partialFilterExpression: { source_sha256: { $type: 'string' } } },
    { key: { status: 1 }, name: 'status' }
  ]);
  await db.collection('chunks').createIndexes([
    { key: { doc_id: 1, chunk_index: 1 }, name: 'doc_chunk' },
    { key: { doc_id: 1, chunk_sha256: 1 }, name: 'doc_sha' }
  ]);
  await db.collection('chunk_staging').createIndex({ doc_id: 1, chunk_index: 1 }, { name: 'doc_chunk' });
  await db.collection('ingest_jobs').createIndex({ status: 1, updated_at: -1 }, { name: 'status_updated' });
}

export const toBinary = (f32) => Binary.fromFloat32Array(f32);
export const fromBinary = (b) => b.toFloat32Array();

/* ------------------------------------------------------------------ documents & jobs */

export async function getDocument(docId) { return (await mongo()).collection('documents').findOne({ _id: docId }); }
export async function findBySha(sha) { return (await mongo()).collection('documents').findOne({ source_sha256: sha }); }

export async function listDocuments(filter = {}) {
  return (await mongo()).collection('documents').find(filter).sort({ ingested_at: -1 }).toArray();
}

export async function saveDocument(doc) {
  await (await mongo()).collection('documents').replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function updateJob(docId, patch, stage = null) {
  const now = new Date();
  const set = { ...patch, updated_at: now };
  if (stage) { set.stage = stage; set[`stages.${stage}`] = now; }
  await (await mongo()).collection('ingest_jobs').updateOne(
    { _id: docId }, { $set: set, $setOnInsert: { created_at: now }, ...(patch.status === 'running' ? { $inc: { attempts: 1 } } : {}) },
    { upsert: true });
}

export async function getJob(docId) { return (await mongo()).collection('ingest_jobs').findOne({ _id: docId }); }
export async function listJobs(filter = {}) {
  return (await mongo()).collection('ingest_jobs').find(filter).sort({ updated_at: -1 }).toArray();
}

/* ------------------------------------------------------------------ staging (resumable embedding) */

/**
 * Replace the staged chunks of a doc. Vectors of unchanged chunks (same sha) are reused from the
 * live set and from an interrupted earlier run's staging rows, so a crashed ingest resumes.
 */
export async function stageChunks(docId, rows, key) {
  const db = await mongo();
  const live = new Map();
  for (const coll of ['chunks', 'chunk_staging']) {
    for (const c of await db.collection(coll)
      .find({ doc_id: docId, [`embeddings.${key}`]: { $exists: true } }, { projection: { chunk_sha256: 1, [`embeddings.${key}`]: 1 } })
      .toArray()) live.set(c.chunk_sha256, c.embeddings[key]);
  }
  await db.collection('chunk_staging').deleteMany({ doc_id: docId });
  let reused = 0;
  const docs = rows.map((r) => {
    const prev = live.get(r.chunk_sha256);
    if (prev) reused++;
    return prev ? { ...r, embeddings: { [key]: prev } } : r;
  });
  if (docs.length) await db.collection('chunk_staging').insertMany(docs, { ordered: false });
  return { staged: docs.length, reused };
}

export async function stagedMissing(docId, key) {
  return (await mongo()).collection('chunk_staging')
    .find({ doc_id: docId, [`embeddings.${key}`]: { $exists: false } }, { projection: { embed_text: 1, chunk_index: 1 } })
    .sort({ chunk_index: 1 }).toArray();
}

export async function setEmbeddings(collection, key, items, meta) {
  if (!items.length) return;
  const now = new Date();
  await (await mongo()).collection(collection).bulkWrite(items.map(({ _id, vector }) => ({
    updateOne: { filter: { _id }, update: { $set: { [`embeddings.${key}`]: { vector: toBinary(vector), ...meta, embedded_at: now } } } }
  })), { ordered: false });
}

/** Atomically swap a document's live chunks for its staged ones and save the document record. */
export async function commitDocument(doc) {
  const db = await mongo();
  const session = _client.startSession();
  try {
    await session.withTransaction(async () => {
      const staged = await db.collection('chunk_staging').find({ doc_id: doc._id }, { session }).toArray();
      await db.collection('chunks').deleteMany({ doc_id: doc._id }, { session });
      if (staged.length) await db.collection('chunks').insertMany(staged, { session });
      await db.collection('documents').replaceOne({ _id: doc._id }, { ...doc, chunk_count: staged.length }, { upsert: true, session });
      await db.collection('chunk_staging').deleteMany({ doc_id: doc._id }, { session });
    });
  } finally {
    await session.endSession();
  }
}

export async function deleteDocument(docId) {
  const db = await mongo();
  const session = _client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const c of ['chunks', 'chunk_staging']) await db.collection(c).deleteMany({ doc_id: docId }, { session });
      await db.collection('documents').deleteOne({ _id: docId }, { session });
      await db.collection('ingest_jobs').deleteOne({ _id: docId }, { session });
    });
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ reading */

export async function chunkIds(docId) {
  return (await (await mongo()).collection('chunks').find({ doc_id: docId }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
}

/** Stream chunks that have a vector for `key`, as { _id, vector, chunk } (vector as Float32Array). */
export async function* chunksWithVectors(key, filter = {}) {
  const cur = (await mongo()).collection('chunks').find({ ...filter, [`embeddings.${key}`]: { $exists: true } });
  for await (const c of cur) {
    const { embeddings, ...chunk } = c;
    yield { _id: c._id, vector: fromBinary(embeddings[key].vector), chunk };
  }
}

export async function chunksMissing(key, limit = 0) {
  return (await mongo()).collection('chunks')
    .find({ [`embeddings.${key}`]: { $exists: false } }, { projection: { embed_text: 1 } }).limit(limit).toArray();
}

export async function getChunks(ids) {
  const rows = await (await mongo()).collection('chunks').find({ _id: { $in: ids } }, { projection: { embeddings: 0 } }).toArray();
  const byId = new Map(rows.map((r) => [r._id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function counts(key) {
  const db = await mongo();
  return {
    documents: await db.collection('documents').countDocuments(),
    chunks: await db.collection('chunks').countDocuments(),
    embedded: key ? await db.collection('chunks').countDocuments({ [`embeddings.${key}`]: { $exists: true } }) : undefined,
    staging: await db.collection('chunk_staging').countDocuments(),
    jobs_failed: await db.collection('ingest_jobs').countDocuments({ status: 'failed' })
  };
}

/** Exact cosine kNN in Node (vectors are unit length, so dot product). Baseline / fallback retriever. */
export async function exactSearch(vector, key, { k = 10, filter = {} } = {}) {
  const top = [];
  for await (const { _id, vector: v } of chunksWithVectors(key, filterToMongo(filter))) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * vector[i];
    if (top.length < k || s > top[top.length - 1].score) {
      top.push({ chunk_id: _id, score: s });
      top.sort((a, b) => b.score - a.score);
      if (top.length > k) top.pop();
    }
  }
  return top;
}

/** { doc_id, space, sensitivity, file_type } (values or arrays) -> Mongo filter */
export function filterToMongo(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (v == null || v === '') continue;
    out[k] = Array.isArray(v) ? { $in: v } : v;
  }
  return out;
}

export async function dropEmbeddings(key) {
  return (await (await mongo()).collection('chunks').updateMany({}, { $unset: { [`embeddings.${key}`]: '' } })).modifiedCount;
}

export async function health() {
  const db = await mongo();
  await db.command({ ping: 1 });
  return true;
}
