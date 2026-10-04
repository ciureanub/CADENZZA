/**
 * One file through the privacy boundary: extract -> scan/record -> mask -> chunk -> assertClean.
 * Everything returned is pseudonymised; real surfaces only reach the SQLite review queue
 * (store-and-mask, same as pages). Ingest (embedding + storage) builds on this.
 */
import * as guard from '../entity/guard.js';
import { extract } from './extract/index.js';
import { chunk, sha256 } from './chunk.js';

/**
 * @param {Buffer} buffer
 * @param {string} filename   original name; returned masked (filenames carry client names too)
 * @param {object} opts       { docId (required), chunkOpts }
 */
export async function prepareDocument(buffer, filename, { docId, chunkOpts = {}, withLocal = false } = {}) {
  if (!docId) throw new Error('prepareDocument: docId is required');
  const source_sha256 = sha256(buffer);
  const ex = await extract(buffer, filename);

  const fullText = [filename, ex.title, ...ex.blocks.flatMap((b) => [b.text, ...b.heading_path])].join('\n');
  const hits = guard.recordOccurrences(null, fullText, { docId });

  const title = guard.mask(ex.title);
  const blocks = ex.blocks.map((b) => ({ ...b, text: guard.mask(b.text), heading_path: b.heading_path.map((h) => guard.mask(h)) }));
  const chunks = chunk(blocks, { title, ...chunkOpts });

  const doc = {
    doc_id: docId,
    title,
    filename: guard.mask(filename),
    source_sha256,
    meta: { ...ex.meta, warnings: ex.meta.warnings.map((w) => guard.mask(w)) },
    occurrences: {
      protected: hits.filter((h) => h.layer === 'gazetteer').length,
      auto_masked: hits.filter((h) => h.layer === 'pattern' && h.status === 'confirmed').length,
      candidates: hits.filter((h) => h.status === 'candidate').length
    }
  };
  guard.assertClean({ title: doc.title, filename: doc.filename, warnings: doc.meta.warnings }, `document ${docId}`);
  for (const c of chunks) guard.assertClean(c, `chunk ${c.chunk_index} of ${docId}`);
  const out = { ...doc, chunks };
  // Real title/html for the SQLite mirror page only (store-and-mask). Non-enumerable so a
  // spread or JSON.stringify of the result can never carry it into Mongo or Qdrant.
  if (withLocal) Object.defineProperty(out, 'local', { value: { title: ex.title, html: ex.html }, enumerable: false });
  return out;
}
