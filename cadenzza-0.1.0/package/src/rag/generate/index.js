/** Generator factory. Only Ollama ships; tests inject their own via setGeneratorFactory(). */
import { getSetting } from '../../db/index.js';
import { ollamaGenerator } from './ollama.js';

let factory = ollamaGenerator;
export function setGeneratorFactory(fn) { factory = fn || ollamaGenerator; }

/** The configured generator (model and GPU placement from settings). */
export function getGenerator(id = getSetting('rag_gen_model', 'qwen3:4b-instruct')) {
  return factory(id, { numGpu: getSetting('rag_gen_num_gpu', 'auto') });
}
