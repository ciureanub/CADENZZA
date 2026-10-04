/**
 * Embedder factory. Backends are swappable; only Ollama ships. Tests inject their own
 * embedder through setEmbedderFactory().
 */
import { ollamaEmbedder } from './ollama.js';

export { modelKey } from './ollama.js';

let factory = ollamaEmbedder;
const cache = new Map();

export function setEmbedderFactory(fn) { factory = fn || ollamaEmbedder; cache.clear(); }

export async function getEmbedder(id) {
  if (!cache.has(id)) cache.set(id, factory(id).catch((err) => { cache.delete(id); throw err; }));
  return cache.get(id);
}
