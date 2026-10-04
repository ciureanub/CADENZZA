/**
 * Document importer: any supported file -> a CADENZZA page.
 * All parsing lives in src/rag/extract; this only turns the result into a page.
 * No outbound network calls. No native parsers.
 */
import * as pages from '../pages.js';
import { extract } from '../rag/extract/index.js';

/**
 * @param {object} opts
 * @param {string}  opts.filename    - original filename (for extension detection)
 * @param {Buffer}  opts.buffer      - file contents
 * @param {string}  opts.space_key   - target CADENZZA space
 * @param {string|null} opts.sensitivity - override sensitivity (null = space default)
 * @returns {{ id, title, space_key, warnings, needs_ocr? }} created page
 */
export async function importDocument({ filename, buffer, space_key = 'release', sensitivity = null }) {
  const { title, html, meta } = await extract(buffer, filename);
  const page = pages.create({
    space_key,
    title,
    body_html: html,
    type: 'note',
    sensitivity: sensitivity || undefined
  });
  const out = { id: page.id, title: page.title, space_key, warnings: meta.warnings };
  if (meta.needs_ocr) out.needs_ocr = true;
  return out;
}
