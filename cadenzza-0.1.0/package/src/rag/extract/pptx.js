/**
 * PPTX via jszip + OOXML. Slides in presentation order (p:sldIdLst), hidden slides skipped.
 * Per slide: title -> heading (level 1), text boxes -> paragraph/list (bullet levels kept),
 * tables -> table rows, speaker notes -> note. page = slide number, for citations.
 */
import JSZip from 'jszip';
import path from 'node:path';
import { decodeEntities, squash, titleFromFilename, blocksToHtml, HeadingTracker, tidy, EXTRACTOR_VERSION } from './common.js';
import { coreTitle } from './docx.js';

const SKIP_PH = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PH = new Set(['title', 'ctrTitle']);

const attr = (xml, name) => (xml.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

/** Text of one <a:p>: runs + fields, <a:br/> as space. */
function paraText(p) {
  return squash(decodeEntities([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)].map((m) => m[1] ?? ' ').join('')));
}

function paragraphs(xml) {
  return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => {
    const p = m[1] ?? m[2];
    const pPr = (p.match(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/) || [''])[0];
    return {
      text: paraText(p),
      lvl: Number(attr(pPr, 'lvl') || 0),
      bullet: /<a:bu(?:Char|AutoNum)\b/.test(pPr) ? true : /<a:buNone\b/.test(pPr) ? false : null
    };
  }).filter((p) => p.text);
}

/** Shapes and table frames of a slide, in document order. */
function shapes(xml) {
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)].map((m) => {
    const s = m[0];
    const ph = s.match(/<p:ph\b[^>]*\/?>/);
    return { xml: s, table: s.startsWith('<p:graphicFrame') && /<a:tbl>/.test(s), ph: ph ? (attr(ph[0], 'type') || 'body') : null };
  });
}

function tableRows(xml) {
  return [...xml.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((tr) =>
    [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => paragraphs(tc[0]).map((p) => p.text).join(' ')))
    .filter((r) => r.some(Boolean)).map((r) => r.join(' | '));
}

async function rels(zip, partPath) {
  const relPath = path.posix.join(path.posix.dirname(partPath), '_rels', `${path.posix.basename(partPath)}.rels`);
  const xml = await zip.file(relPath)?.async('string');
  const out = {};
  for (const m of (xml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    out[attr(m[0], 'Id')] = { type: attr(m[0], 'Type') || '', target: path.posix.normalize(path.posix.join(path.posix.dirname(partPath), attr(m[0], 'Target') || '')) };
  }
  return out;
}

export async function extractPptx(buffer, filename) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (err) { throw new Error(`Could not open .pptx: ${err.message}`); }
  const pres = await zip.file('ppt/presentation.xml')?.async('string');
  if (!pres) throw new Error('Not a PowerPoint file: ppt/presentation.xml missing');

  const presRels = await rels(zip, 'ppt/presentation.xml');
  const order = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => presRels[attr(m[0], 'r:id')]?.target).filter(Boolean);

  const blocks = [];
  const meta = { extractor: 'pptx', extractor_version: EXTRACTOR_VERSION, pages: order.length, warnings: [] };
  const hidden = [];
  let smartArt = 0, charts = 0;

  for (let i = 0; i < order.length; i++) {
    const slideNo = i + 1;
    const xml = await zip.file(order[i])?.async('string');
    if (!xml) continue;
    if (/<p:sld\b[^>]*\bshow="0"/.test(xml)) { hidden.push(slideNo); continue; }
    smartArt += (xml.match(/<dgm:relIds\b/g) || []).length;
    charts += (xml.match(/<c:chart\b/g) || []).length;

    const hp = new HeadingTracker();
    const all = shapes(xml).filter((s) => !SKIP_PH.has(s.ph));
    const titleShape = all.find((s) => TITLE_PH.has(s.ph));
    const title = titleShape ? paragraphs(titleShape.xml).map((p) => p.text).join(' ') : '';
    const heading = title || `Slide ${slideNo}`;
    blocks.push({ type: 'heading', level: 1, text: heading, heading_path: hp.push(1, heading), page: slideNo });

    for (const s of all) {
      if (s === titleShape) continue;
      if (s.table) {
        const rows = tableRows(s.xml);
        if (rows.length) blocks.push({ type: 'table', text: rows.join('\n'), heading_path: hp.path(), page: slideNo });
        continue;
      }
      const paras = paragraphs(s.xml);
      if (!paras.length) continue;
      const bulleted = paras.some((p) => p.bullet) || (s.ph === 'body' || s.ph === 'obj') && paras.length > 1 && !paras.every((p) => p.bullet === false);
      blocks.push(bulleted
        ? { type: 'list', text: paras.map((p) => `${'  '.repeat(p.lvl)}- ${p.text}`).join('\n'), heading_path: hp.path(), page: slideNo }
        : { type: 'paragraph', text: paras.map((p) => p.text).join('\n'), heading_path: hp.path(), page: slideNo });
    }

    const notes = Object.values(await rels(zip, order[i])).find((r) => r.type.endsWith('/notesSlide'));
    const notesXml = notes && await zip.file(notes.target)?.async('string');
    if (notesXml) {
      const text = shapes(notesXml).filter((s) => !SKIP_PH.has(s.ph)).flatMap((s) => paragraphs(s.xml).map((p) => p.text)).join(' ');
      if (text) blocks.push({ type: 'note', text: `Speaker notes: ${text}`, heading_path: hp.path(), page: slideNo });
    }
  }

  if (hidden.length) meta.warnings.push(`hidden slide(s) skipped: ${hidden.join(', ')}`);
  if (smartArt) meta.warnings.push(`${smartArt} SmartArt diagram(s) not extracted`);
  if (charts) meta.warnings.push(`${charts} chart(s) not extracted`);

  const clean = tidy(blocks);
  const first = clean.find((b) => b.type === 'heading' && !/^Slide \d+$/.test(b.text));
  const title = (await coreTitle(zip)) || first?.text || titleFromFilename(filename);
  return { title, blocks: clean, html: blocksToHtml(clean), meta };
}
