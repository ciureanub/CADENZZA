/** DOCX via mammoth -> HTML (headings, lists, tables kept) -> shared HTML back end. */
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { decodeEntities, squash } from './common.js';
import { fromHtmlString } from './html.js';

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh"
];

/** dc:title from docProps/core.xml, if set. Shared with pptx. */
export async function coreTitle(zip) {
  const core = await zip.file('docProps/core.xml')?.async('string');
  const t = core && core.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
  return t ? squash(decodeEntities(t[1])) : '';
}

export async function extractDocx(buffer, filename) {
  const { value: html, messages } = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP, ignoreEmptyParagraphs: true });
  const out = fromHtmlString(`<body>${html}</body>`, filename, 'docx');
  const title = await coreTitle(await JSZip.loadAsync(buffer)).catch(() => '');
  if (title) out.title = title;
  out.meta.warnings = messages.filter((m) => m.type === 'warning').map((m) => m.message).slice(0, 20);
  return out;
}
