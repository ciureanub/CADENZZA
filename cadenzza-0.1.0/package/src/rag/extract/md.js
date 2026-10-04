/** Markdown via marked (GFM: tables, fenced code, nested lists) -> shared HTML back end. */
import { marked } from 'marked';
import { decodeBytes } from './common.js';
import { fromHtmlString } from './html.js';

export function extractMd(buffer, filename) {
  const md = decodeBytes(buffer).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // drop YAML front matter
  const html = marked.parse(md, { gfm: true, async: false });
  return fromHtmlString(html, filename, 'md');
}
