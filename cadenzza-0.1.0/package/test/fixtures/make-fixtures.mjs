#!/usr/bin/env node
/**
 * Regenerates the synthetic test fixtures (no real client names: Contoso, Northwind Traders).
 *   node test/fixtures/make-fixtures.mjs
 * runbook.doc is the one fixture not built here: it is runbook.docx saved as
 * "Word 97-2003 Document" by Word (see README.md in this folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATE = new Date('2026-01-01T00:00:00Z');
const write = (name, data) => { fs.writeFileSync(path.join(DIR, name), data); console.log(`  ${name.padEnd(22)} ${String(data.length).padStart(7)} bytes`); };

async function zip(files) {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content, { date: DATE });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' });
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const core = (title) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`;

/* ------------------------------------------------------------------ DOCX */

async function docx() {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const p = (style, text) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const body = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const li = (lvl, text) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const tc = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const tr = (...cells) => `<w:tr>${cells.map(tc).join('')}</w:tr>`;

  const document = `${XML}<w:document xmlns:w="${W}"><w:body>
${p('Title', 'Contoso Cutover Runbook')}
${p('Heading1', 'Rollback procedure')}
${body('If the cutover fails, Contoso restores the org snapshot taken at T-0. Escalate to jane.doe@contoso.com.')}
${li(0, 'Freeze deployments')}
${li(1, 'Notify Northwind Traders integration team')}
${li(0, 'Restore the snapshot')}
${p('Heading2', 'Decision points')}
<w:tbl>${tr('Gate', 'Owner', 'Deadline')}${tr('Go/No-Go', 'Release manager', 'T-2h')}${tr('Rollback', 'Contoso CAB', 'T+1h')}</w:tbl>
${p('Heading1', 'Communications')}
${body('Herr Müller übernimmt die Kommunikation; Ștefan coordonează echipa.')}
</w:body></w:document>`;

  const styles = `${XML}<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`;

  const lvl = (i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl>`;
  const numbering = `${XML}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">${lvl(0)}${lvl(1)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>
</Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    'docProps/core.xml': core('Contoso Cutover Runbook')
  });
}

/* ------------------------------------------------------------------ PPTX */

async function pptx() {
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const run = (t) => `<a:r><a:t>${t}</a:t></a:r>`;
  const sp = (ph, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.join('')}</p:txBody></p:sp>`;
  const para = (t, lvl = 0) => `<a:p><a:pPr lvl="${lvl}"/>${run(t)}</a:p>`;
  const slide = (inner, show = '') => `${XML}<p:sld ${NS}${show}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
  const table = (rows) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="t"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${
    rows.map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody><a:p>${run(c)}</a:p></a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const rels = (items) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    'docProps/core.xml': core(''),
    // Presentation order deliberately differs from file numbering: slide2, slide1, slide3 (hidden).
    'ppt/presentation.xml': `${XML}<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml'], ['rId4', 'slide', 'slides/slide3.xml']]),
    'ppt/slides/slide2.xml': slide(
      sp('ctrTitle', [para('Northwind Traders Release Train')]) +
      sp('subTitle', [para('Quarterly deck for Contoso')]) +
      sp('sldNum', [para('1')])),
    'ppt/slides/slide1.xml': slide(
      sp('title', [para('Rollback strategy')]) +
      sp('body', [para('Freeze deployments'), para('Restore snapshot', 1), para('Notify the CAB')]) +
      table([['Step', 'Owner'], ['Restore', 'Contoso ops']])),
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': slide(sp('sldImg', []) + sp('body', [para('Mention the T+1h deadline.')]) + sp('sldNum', [para('2')])),
    'ppt/slides/slide3.xml': slide(sp('title', [para('Hidden backup slide')]), ' show="0"')
  });
}

/* ------------------------------------------------------------------ PDF */

function pdfFile(pageStreams, { title, extraObjects = [], resources = '/Font << /F1 3 0 R >>' } = {}) {
  // 1 catalog, 2 pages, 3 font, 4 info, then per page: page + content, then extras
  const objs = [];
  const n0 = 5;
  const kids = pageStreams.map((_, i) => `${n0 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageStreams.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push(title ? `<< /Title (${title}) /Producer (cadenzza fixtures) >>` : '<< /Producer (cadenzza fixtures) >>');
  for (const [i, s] of pageStreams.entries()) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${n0 + i * 2 + 1} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`);
  }
  objs.push(...extraObjects);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  for (const [i, o] of objs.entries()) { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const line = (size, y, text, x = 72) => `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
const footer = (n) => `${line(8, 40, 'Contoso internal - cutover runbook')}\n${line(8, 28, String(n), 300)}`;

function pdfText() {
  const p1 = [
    line(20, 720, 'Contoso Cutover Runbook'),
    line(15, 680, 'Rollback procedure'),
    line(11, 655, 'If the cutover fails, Contoso restores the org snap-'),
    line(11, 641, 'shot taken at T-0 and informs Northwind Traders.'),
    line(11, 610, 'The release manager owns the decision.'),
    footer(1)
  ].join('\n');
  const p2 = [
    line(13, 720, 'Decision points'),
    line(11, 695, '\x95 Go/No-Go at T-2h'),
    line(11, 681, '\x95 Rollback deadline T+1h'),
    line(11, 650, 'Escalation goes through the Contoso CAB.'),
    footer(2)
  ].join('\n');
  const p3 = [
    line(15, 720, 'Communications'),
    line(11, 695, 'Herr M\xFCller sends the go-live note.'),
    footer(3)
  ].join('\n');
  return pdfFile([p1, p2, p3], { title: 'Contoso Cutover Runbook' });
}

function pdfScanned() {
  // One page that only paints an 8x8 grey image: no text layer.
  const img = Buffer.alloc(64, 0x80).toString('latin1');
  const extra = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 64 >>\nstream\n${img}\nendstream`;
  // page objects are 5 and 6, so the image is object 7
  return pdfFile(['q 400 0 0 400 100 200 cm /Im1 Do Q'], { extraObjects: [extra], resources: '/XObject << /Im1 7 0 R >>' });
}

/* ------------------------------------------------------------------ text formats */

const md = `---
owner: release
---
# Contoso Go-Live Checklist

Intro paragraph for **Northwind Traders**.

## Pre-checks

- Backups verified
  - Snapshot ID recorded
- Smoke tests green

| Check | Owner |
|---|---|
| DNS cutover | Contoso ops |
| Monitoring | SRE |

\`\`\`powershell
sf project deploy start --dry-run
\`\`\`
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Environment Matrix</title>
<script>alert('x')</script><style>p{}</style></head><body>
<nav>Home &gt; Spaces</nav>
<h1>Contoso Environment Matrix</h1>
<p onclick="x()">Sandboxes refreshed monthly &amp; masked.</p>
<h2>Sandboxes</h2>
<table><tr><th>Name</th><th>Type</th></tr><tr><td>UAT</td><td>Full</td></tr><tr><td>SIT</td><td>Partial</td></tr></table>
<ol><li>Refresh</li><li>Mask data<ul><li>Northwind Traders contacts</li></ul></li></ol>
</body></html>`;

const mhtml = (charset, qpTitle) => [
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="----=_NextPart_01"',
  '',
  '------=_NextPart_01',
  `Content-Type: text/html; charset="${charset}"`,
  'Content-Transfer-Encoding: quoted-printable',
  '',
  `<html><body><h1>${qpTitle}</h1><p>Contoso cutover window: Saturday 22:00 =`,
  '- Sunday 06:00.</p></body></html>',
  '------=_NextPart_01--',
  ''
].join('\r\n');

/* ------------------------------------------------------------------ write */

console.log('fixtures:');
write('runbook.docx', await docx());
write('deck.pptx', await pptx());
write('runbook.pdf', pdfText());
write('scanned.pdf', pdfScanned());
write('checklist.md', Buffer.from(md, 'utf8'));
write('environments.html', Buffer.from(html, 'utf8'));
write('confluence-utf8.mhtml', Buffer.from(mhtml('utf-8', 'M=C3=BCnchen Cutover'), 'latin1'));
write('confluence-1252.mhtml', Buffer.from(mhtml('windows-1252', 'M=FCnchen Cutover'), 'latin1'));
write('notes-cp1252.txt', Buffer.from('Herr M\xFCller owns the Contoso rollback.\r\n\r\nSecond paragraph.', 'latin1'));
