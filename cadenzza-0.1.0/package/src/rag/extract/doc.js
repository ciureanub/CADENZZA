/**
 * Legacy binary Word (.doc, OLE compound file) via word-extractor.
 * The format carries no reliable heading structure through this parser, so blocks are paragraphs.
 */
import WordExtractor from 'word-extractor';
import { titleFromFilename, escapeHtml, tidy, EXTRACTOR_VERSION } from './common.js';

export const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const isOle = (buf) => buf.subarray(0, 8).equals(OLE_MAGIC);

export async function extractDoc(buffer, filename) {
  let doc;
  try {
    doc = await new WordExtractor().extract(buffer);
  } catch (err) {
    throw new Error(`Could not read legacy .doc (OLE Compound): ${err.message}`);
  }
  const body = doc.getBody({ filterUnicode: false }).replace(/\r\n?/g, '\n');
  // word-extractor separates table cells with tabs: consecutive tabbed lines form one table.
  const raw = [];
  for (const line of body.split(/\n+/)) {
    const cells = line.split('\t').map((c) => c.trim());
    if (cells.filter(Boolean).length > 1) {
      const row = cells.filter(Boolean).join(' | ');
      const last = raw[raw.length - 1];
      if (last?.type === 'table') last.text += `\n${row}`; else raw.push({ type: 'table', text: row, heading_path: [] });
    } else {
      raw.push({ type: 'paragraph', text: line, heading_path: [] });
    }
  }
  const blocks = tidy(raw);
  for (const [kind, text] of [['footnotes', doc.getFootnotes()], ['endnotes', doc.getEndnotes()]]) {
    if (text && text.trim()) blocks.push({ type: 'note', text: `${kind}: ${text.trim()}`, heading_path: [] });
  }
  const html = blocks.map((b) => `<p>${escapeHtml(b.text)}</p>`).join('\n');
  return {
    title: titleFromFilename(filename),
    blocks,
    html,
    meta: { extractor: 'doc', extractor_version: EXTRACTOR_VERSION, warnings: ['legacy .doc: no heading structure; re-save as .docx for better citations'] }
  };
}
