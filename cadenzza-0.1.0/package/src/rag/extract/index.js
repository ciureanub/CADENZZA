/**
 * extract(buffer, filename) -> { title, blocks[], html, meta }
 *   blocks  structured text for chunking (see common.js)
 *   html    sanitised HTML for the mirrored wiki page
 *   meta    { extractor, extractor_version, file_type, warnings[], pages?, needs_ocr? }
 * Format is decided by content sniffing first, extension second: Confluence ".doc" files are
 * MHTML, Word "web page" .doc files are HTML, and renamed .docx files are zips.
 */
import path from 'node:path';
import { extractHtml } from './html.js';
import { extractMhtml, isMhtml } from './mhtml.js';
import { extractMd } from './md.js';
import { extractTxt } from './txt.js';
import { extractDocx } from './docx.js';
import { extractDoc, isOle } from './doc.js';
import { extractPdf } from './pdf.js';
import { extractPptx } from './pptx.js';

export { EXTRACTOR_VERSION } from './common.js';

export const SUPPORTED = ['.pdf', '.docx', '.doc', '.pptx', '.html', '.htm', '.md', '.markdown', '.txt', '.mhtml', '.mht'];

const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isPdf = (b) => b.subarray(0, 1024).toString('latin1').includes('%PDF-');
const looksHtml = (b) => /^\s*(?:<!doctype html|<html|<\?xml[^>]*>\s*<html)/i.test(b.subarray(0, 512).toString('latin1'));

export async function extract(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext || '(none)'}. Supported: ${SUPPORTED.join(', ')}`);
  }
  if (!buffer.length) throw new Error('File is empty');

  let out;
  if (ext === '.pdf') {
    if (!isPdf(buffer)) throw new Error('Not a PDF file (missing %PDF header)');
    out = await extractPdf(buffer, filename);
  } else if (ext === '.pptx') {
    out = await extractPptx(buffer, filename);
  } else if (ext === '.docx' || (ext === '.doc' && isZip(buffer))) {
    out = await extractDocx(buffer, filename);
  } else if (ext === '.doc') {
    if (isMhtml(buffer)) out = extractMhtml(buffer, filename);
    else if (isOle(buffer)) out = await extractDoc(buffer, filename);
    else if (looksHtml(buffer)) out = extractHtml(buffer, filename);
    else throw new Error('Unrecognised .doc: not Word 97-2003 (OLE), MHTML, HTML or DOCX');
  } else if (ext === '.mhtml' || ext === '.mht') {
    out = extractMhtml(buffer, filename);
  } else if (ext === '.html' || ext === '.htm') {
    out = isMhtml(buffer) ? extractMhtml(buffer, filename) : extractHtml(buffer, filename);
  } else if (ext === '.md' || ext === '.markdown') {
    out = extractMd(buffer, filename);
  } else {
    out = extractTxt(buffer, filename);
  }

  out.meta.file_type = ext.slice(1);
  if (!out.title) out.title = 'Imported Document';
  return out;
}
