/** Plain text: one paragraph per blank-line-separated run. Encoding sniffed (BOM / UTF-8 / cp1252). */
import { decodeBytes, titleFromFilename, escapeHtml, tidy, EXTRACTOR_VERSION } from './common.js';

export function extractTxt(buffer, filename) {
  const text = decodeBytes(buffer).replace(/\r\n?/g, '\n');
  const blocks = tidy(text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', text: p, heading_path: [] })));
  const html = '<p>' + escapeHtml(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  return { title: titleFromFilename(filename), blocks, html, meta: { extractor: 'txt', extractor_version: EXTRACTOR_VERSION, warnings: [] } };
}
