/**
 * retrieve(question, opts): mask -> embed -> search -> (fuse) -> hydrate.
 *   dense   Qdrant ANN (serving index)
 *   exact   exact cosine kNN over Mongo vectors (baseline / Qdrant-down fallback)
 *   hybrid  dense + Mongo full-text, reciprocal rank fusion (k=60, same code as page search)
 * The question is masked with the same guard as the corpus, so "E.ON cutover" and
 * "CLIENT_A cutover" land on the same vectors and the same text matches.
 */
import * as guard from '../entity/guard.js';
import { getSetting } from '../db/index.js';
import { rrf } from '../search/index.js';
import { getEmbedder } from './embed/index.js';
import { activeModel } from './ingest.js';
import * as mongo from './store/mongo.js';
import * as qdrant from './store/qdrant.js';

const ms = (t) => Math.round(performance.now() - t);

/**
 * @param {string} question  raw question (masked here)
 * @param {object} o { k, candidates, filter: { space, sensitivity, file_type, doc_id }, mode }
 * @returns {{ question_masked, mode, hits: [{ chunk_id, score, dense_rank, lexical_rank, chunk, doc }], timings }}
 */
export async function retrieve(question, o = {}) {
  const k = Number(o.k || getSetting('rag_top_k', '6'));
  const candidates = Math.max(o.candidates || 20, k);
  const mode = o.mode || getSetting('rag_retrieval', 'hybrid');
  const filter = o.filter || {};
  const question_masked = guard.mask(String(question).trim());
  guard.assertClean(question_masked, 'retrieval query');

  let t = performance.now();
  const embedder = await getEmbedder(o.model || activeModel());
  const [vector] = await embedder.embed([question_masked]);
  const embed_ms = ms(t);

  t = performance.now();
  let dense = [];
  if (mode === 'exact') {
    dense = await mongo.exactSearch(vector, embedder.key, { k: candidates, filter });
  } else {
    try {
      dense = await qdrant.search(qdrant.collectionName(embedder.key, embedder.dim), vector, { k: candidates, filter });
    } catch (err) {
      // Qdrant down: fall back to the exact Mongo retriever rather than failing the question
      dense = await mongo.exactSearch(vector, embedder.key, { k: candidates, filter });
      dense.fallback = err.message;
    }
  }
  const denseRanked = dense.map((h, i) => ({ chunk_id: h.chunk_id, rank: i + 1, mode: 'dense', dense_score: h.score, dense_rank: i + 1 }));

  let fused = denseRanked;
  if (mode === 'hybrid') {
    const lexical = (await mongo.lexicalSearch(question_masked, { k: candidates, filter }))
      .map((h, i) => ({ chunk_id: h.chunk_id, rank: i + 1, mode: 'lexical', lexical_score: h.score, lexical_rank: i + 1 }));
    fused = rrf([denseRanked, lexical], { idOf: (r) => r.chunk_id });
  }
  const top = fused.slice(0, k);
  const search_ms = ms(t);

  t = performance.now();
  const chunks = await mongo.getChunks(top.map((h) => h.chunk_id));
  const docs = new Map((await mongo.getDocuments([...new Set(chunks.map((c) => c.doc_id))])).map((d) => [d._id, d]));
  const byId = new Map(chunks.map((c) => [c._id, c]));
  const hits = top.filter((h) => byId.has(h.chunk_id)).map((h) => {
    const chunk = byId.get(h.chunk_id);
    const d = docs.get(chunk.doc_id) || {};
    return {
      chunk_id: h.chunk_id,
      score: h.rrf ?? h.dense_score,
      dense_score: h.dense_score ?? null,
      dense_rank: h.dense_rank ?? null,
      lexical_rank: h.lexical_rank ?? null,
      chunk,
      doc: { doc_id: d._id, title: d.title, filename: d.filename, file_type: d.file_type, page_id: d.page_id, space: d.space }
    };
  });
  return {
    question_masked,
    mode,
    embed_model: embedder.key,
    fallback: dense.fallback || null,
    hits,
    timings: { embed_ms, search_ms, hydrate_ms: ms(t) }
  };
}
