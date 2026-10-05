/**
 * Ollama embedder over plain fetch (/api/embed). Batched, retried with exponential backoff.
 * Embedder: { id, key, dim, digest, embed(texts[]) -> Float32Array[] }
 */
import { RAG } from '../../config.js';

const BATCH = 16;
const RETRIES = 3;
const TIMEOUT_MS = 120_000;

/** Model name -> safe identifier for Mongo field names and Qdrant collection names. */
export const modelKey = (id) => String(id).replace(/:latest$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();

async function post(path, body) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${RAG.ollamaUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) return res.json();
      const text = await res.text();
      if (res.status < 500) throw Object.assign(new Error(`ollama ${path} ${res.status}: ${text.slice(0, 200)}`), { fatal: true });
      last = new Error(`ollama ${path} ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      if (err.fatal) throw err;
      last = err;
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error(`ollama ${path} failed after ${RETRIES + 1} attempts: ${last?.message}`);
}

/**
 * Query-side instructions for models trained with asymmetric prompts (documents are embedded as-is).
 * bge-m3 needs none. Part of the retrieval configuration: changing it requires no re-embed.
 */
const QUERY_PREFIX = [
  [/^qwen3-embedding/, 'Instruct: Given a question about project documentation, retrieve passages that answer it\nQuery: ']
];
export const queryPrefixFor = (id) => (QUERY_PREFIX.find(([re]) => re.test(id)) || [null, ''])[1];

/** Resolve model metadata (digest, dimension) once, then embed in batches. */
export async function ollamaEmbedder(id) {
  const tag = id.includes(':') ? id : `${id}:latest`;
  const tags = await fetch(`${RAG.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const model = tags.models.find((m) => m.name === tag);
  if (!model) throw new Error(`embedding model ${tag} is not pulled (ollama pull ${id})`);
  const [probe] = (await post('/api/embed', { model: id, input: ['dimension probe'] })).embeddings;

  const prefix = queryPrefixFor(id);
  return {
    id,
    key: modelKey(id),
    dim: probe.length,
    digest: model.digest,
    queryPrefix: prefix,
    /** Embed a search query (with the model's query instruction, if any). */
    async embedQuery(text) { return (await this.embed([prefix + text]))[0]; },
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const { embeddings } = await post('/api/embed', { model: id, input: batch, truncate: true });
        if (!embeddings || embeddings.length !== batch.length) throw new Error(`ollama returned ${embeddings?.length} embeddings for ${batch.length} inputs`);
        for (const e of embeddings) {
          if (e.length !== probe.length) throw new Error(`embedding dim ${e.length} != ${probe.length}`);
          out.push(Float32Array.from(e));
        }
      }
      return out;
    }
  };
}
