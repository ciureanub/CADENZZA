import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Resolve the data directory. CADENZZA_HOME wins, else ~/.cadenzza */
export function home() {
  const dir = process.env.CADENZZA_HOME || path.join(os.homedir(), '.cadenzza');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  get home() { return home(); },
  get db() { return path.join(home(), 'cadenzza.db'); },
  get vaultKey() { return path.join(home(), 'vault.key'); },
  get assets() {
    const d = path.join(home(), 'assets');
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  get exports() {
    const d = path.join(home(), 'exports');
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  /** The only directory /api/import may read from by path. */
  get importRoot() {
    const d = path.join(home(), 'import');
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  /** Mongo + Qdrant data, logs, eval output. Same back-up / never-commit rule as the db. */
  get rag() { return path.join(home(), 'rag'); }
};

/** Local RAG service endpoints. Loopback only; `cadenzza doctor` enforces it. */
export const RAG = {
  get mongoUri()  { return process.env.CADENZZA_MONGO_URI  || 'mongodb://127.0.0.1:27017/?replicaSet=cadenzza&directConnection=true'; },
  get qdrantUrl() { return process.env.CADENZZA_QDRANT_URL || 'http://127.0.0.1:6333'; },
  get ollamaUrl() { return process.env.CADENZZA_OLLAMA_URL || 'http://127.0.0.1:11434'; },
  /** Overridable so tests run in their own database / collection namespace. */
  get mongoDb()   { return process.env.CADENZZA_MONGO_DB || 'cadenzza_rag'; },
  get qdrantPrefix() { return process.env.CADENZZA_QDRANT_PREFIX || 'cadenzza_chunks'; }
};

export const SENSITIVITY = ['Public', 'Internal', 'Client-Confidential', 'Restricted'];

export const SPACES = [
  { key: 'release',     name: 'Release Management',     glyph: 'RM', position: 1 },
  { key: 'environment', name: 'Environment Management', glyph: 'EM', position: 2 },
  { key: 'stakeholder', name: 'Stakeholder Management', glyph: 'SM', position: 3 }
];

/** Retired space keys still accepted on input (CLI, API, search filters). Deployment merged into Release in 0.2. */
export const SPACE_ALIASES = { deployment: 'release' };
export const canonicalSpace = (key) => (key == null ? key : SPACE_ALIASES[String(key).toLowerCase()] || key);

/** Storage mode. store-and-mask is the default; see README. */
export const DEFAULT_SETTINGS = {
  storage_mode: 'store-and-mask',
  pseudonym_style: 'coded',
  chat_mode: 'private',
  offline: '1',
  rag_embed_model: 'bge-m3',       // active embedding model (blue/green pointer)
  rag_gen_model: 'qwen3:4b-instruct', // gemma4 8B: unstable on the iGPU, ~66 s/answer on this CPU
  rag_gen_num_gpu: 'auto',         // 'auto' or a layer count; '0' forces the generator onto the CPU
  rag_retrieval: 'hybrid',         // hybrid (Qdrant dense + Mongo lexical, RRF) | dense | exact
  rag_context_tokens: '1200',      // budget for retrieved context in the prompt
  rag_chunk_tokens: '450',         // chunk target (estimated tokens); a change re-chunks on re-ingest
  rag_chunk_merge_min: '0',        // merge sibling sections while a chunk is below this size (0 = off)
  rag_top_k: '6',
  rag_embed_restricted: '0',       // Restricted files are recorded but not embedded unless '1'
  rag_create_page: '1',            // mirror each ingested file as a source-capture page
  registry_version: '0'            // bumped on every registry change; stale docs get re-masked
};
