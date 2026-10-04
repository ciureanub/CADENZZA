/**
 * Qdrant: ANN serving index, derived from Mongo and rebuildable at any time (`cadenzza rag reindex`).
 * Points: id = chunk_id, vector, payload = filter fields only (no text).
 * One collection per embedding model + dim: <prefix>_<modelKey>_<dim>. Never mixed vectors.
 */
import { RAG } from '../../config.js';

const TIMEOUT_MS = 30_000;
const UPSERT_BATCH = 128;
export const PAYLOAD_INDEXES = { doc_id: 'keyword', space: 'keyword', sensitivity: 'keyword', file_type: 'keyword', embed_model: 'keyword', ingested_at: 'datetime' };

export const collectionName = (key, dim) => `${RAG.qdrantPrefix}_${key}_${dim}`;

async function q(method, path, body) {
  const res = await fetch(`${RAG.qdrantUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`qdrant ${method} ${path} ${res.status}: ${json?.status?.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

export async function listCollections() {
  return (await q('GET', '/collections')).collections.map((c) => c.name);
}

export async function exists(name) {
  try { await q('GET', `/collections/${name}`); return true; } catch (err) { if (err.status === 404) return false; throw err; }
}

/** Create the collection (cosine, HNSW defaults) and its payload indexes if missing. */
export async function ensureCollection(name, dim) {
  if (await exists(name)) {
    const info = await q('GET', `/collections/${name}`);
    const size = info.config.params.vectors.size;
    if (size !== dim) throw new Error(`collection ${name} has dim ${size}, expected ${dim}`);
    return false;
  }
  await q('PUT', `/collections/${name}`, { vectors: { size: dim, distance: 'Cosine' } });
  for (const [field, schema] of Object.entries(PAYLOAD_INDEXES)) {
    await q('PUT', `/collections/${name}/index?wait=true`, { field_name: field, field_schema: schema });
  }
  return true;
}

export async function dropCollection(name) {
  if (await exists(name)) await q('DELETE', `/collections/${name}`);
}

/** Qdrant payload for a chunk: filterable metadata only. */
export const payloadOf = (chunk, model) => ({
  doc_id: chunk.doc_id,
  chunk_index: chunk.chunk_index,
  space: chunk.space,
  sensitivity: chunk.sensitivity,
  file_type: chunk.file_type,
  ingested_at: chunk.ingested_at instanceof Date ? chunk.ingested_at.toISOString() : chunk.ingested_at,
  embed_model: model
});

/** points: [{ id, vector: Float32Array|number[], payload }] */
export async function upsert(name, points) {
  for (let i = 0; i < points.length; i += UPSERT_BATCH) {
    await q('PUT', `/collections/${name}/points?wait=true`, {
      points: points.slice(i, i + UPSERT_BATCH).map((p) => ({ id: p.id, vector: Array.from(p.vector), payload: p.payload }))
    });
  }
}

/** Remove a doc's points, optionally keeping `keepIds` (upsert-then-prune: no window with zero points). */
export async function deleteByDoc(name, docId, keepIds = []) {
  const filter = { must: [{ key: 'doc_id', match: { value: docId } }] };
  if (keepIds.length) filter.must_not = [{ has_id: keepIds }];
  await q('POST', `/collections/${name}/points/delete?wait=true`, { filter });
}

/** { doc_id, space, sensitivity, file_type } (value or array) -> Qdrant filter */
export function toFilter(filter = {}) {
  const must = [];
  for (const [key, v] of Object.entries(filter)) {
    if (v == null || v === '') continue;
    must.push(Array.isArray(v) ? { key, match: { any: v } } : { key, match: { value: v } });
  }
  return must.length ? { must } : undefined;
}

export async function search(name, vector, { k = 20, filter } = {}) {
  const res = await q('POST', `/collections/${name}/points/query`, {
    query: Array.from(vector), limit: k, filter: toFilter(filter), with_payload: true
  });
  return res.points.map((p) => ({ chunk_id: p.id, score: p.score, payload: p.payload }));
}

export async function count(name, filter) {
  if (!(await exists(name))) return 0;
  return (await q('POST', `/collections/${name}/points/count`, { exact: true, filter: toFilter(filter) })).count;
}

/** Every payload in a collection (for leak checks and audits). */
export async function* scroll(name) {
  let offset = null;
  do {
    const r = await q('POST', `/collections/${name}/points/scroll`, { limit: 256, offset, with_payload: true, with_vector: false });
    for (const p of r.points) yield p;
    offset = r.next_page_offset;
  } while (offset != null);
}

export async function health() {
  const res = await fetch(`${RAG.qdrantUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}
