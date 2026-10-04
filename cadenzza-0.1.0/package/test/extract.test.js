import '../infra/offline-guard.mjs'; // any outbound attempt during extraction fails the run (exit 3)
import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, SUPPORTED } from '../src/rag/extract/index.js';
import { htmlToBlocks } from '../src/rag/extract/html.js';
import { decodeQP } from '../src/rag/extract/mhtml.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const run = (f) => extract(fs.readFileSync(path.join(FX, f)), f);
const byType = (r, type) => r.blocks.filter((b) => b.type === type);
const texts = (bs) => bs.map((b) => b.text);

/* ---------------- per format ---------------- */

test('docx: title, heading tree, nested list, table rows, diacritics', async () => {
  const r = await run('runbook.docx');
  assert.equal(r.title, 'Contoso Cutover Runbook');
  assert.equal(r.meta.extractor, 'docx');
  assert.deepEqual(byType(r, 'heading').map((b) => [b.level, b.text]),
    [[1, 'Contoso Cutover Runbook'], [1, 'Rollback procedure'], [2, 'Decision points'], [1, 'Communications']]);
  const [table] = byType(r, 'table');
  assert.deepEqual(table.heading_path, ['Rollback procedure', 'Decision points']);
  assert.equal(table.text.split('\n')[1], 'Go/No-Go | Release manager | T-2h');
  assert.equal(byType(r, 'list')[0].text, '- Freeze deployments\n  - Notify Northwind Traders integration team\n- Restore the snapshot');
  assert.match(r.blocks.at(-1).text, /Müller übernimmt.*Ștefan coordonează/);
});

test('doc (Word 97-2003): paragraphs, tabbed table rows, diacritics, structure warning', async () => {
  const r = await run('runbook.doc');
  assert.equal(r.meta.extractor, 'doc');
  assert.equal(byType(r, 'heading').length, 0);
  assert.match(r.meta.warnings[0], /no heading structure/);
  assert.equal(byType(r, 'table')[0].text, 'Gate | Owner | Deadline\nGo/No-Go | Release manager | T-2h\nRollback | Contoso CAB | T+1h');
  assert.ok(texts(r.blocks).includes('Herr Müller übernimmt die Kommunikation; Ștefan coordonează echipa.'));
});

test('pdf: metadata title, size-ranked headings, page numbers, de-hyphenation, bullets, chrome dropped', async () => {
  const r = await run('runbook.pdf');
  assert.equal(r.title, 'Contoso Cutover Runbook');
  assert.equal(r.meta.pages, 3);
  assert.ok(!r.meta.needs_ocr);
  assert.deepEqual(byType(r, 'heading').map((b) => [b.level, b.text, b.page]),
    [[1, 'Contoso Cutover Runbook', 1], [2, 'Rollback procedure', 1], [3, 'Decision points', 2], [2, 'Communications', 3]]);
  assert.ok(texts(r.blocks).includes('If the cutover fails, Contoso restores the org snapshot taken at T-0 and informs Northwind Traders.'));
  const [list] = byType(r, 'list');
  assert.equal(list.text, '- Go/No-Go at T-2h\n- Rollback deadline T+1h');
  assert.equal(list.page, 2);
  assert.deepEqual(list.heading_path, ['Contoso Cutover Runbook', 'Rollback procedure', 'Decision points']);
  const all = texts(r.blocks).join('\n');
  assert.doesNotMatch(all, /Contoso internal - cutover runbook/, 'running footer removed');
  assert.ok(!r.blocks.some((b) => /^\d+$/.test(b.text)), 'bare page numbers removed');
  assert.match(all, /Herr Müller/);
});

test('pdf: image-only file is flagged needs_ocr with no blocks', async () => {
  const r = await run('scanned.pdf');
  assert.equal(r.meta.needs_ocr, true);
  assert.deepEqual(r.blocks, []);
  assert.match(r.meta.warnings[0], /OCR is not supported/);
  assert.equal(r.title, 'scanned');
});

test('pptx: presentation order, hidden slide skipped, slide = page, bullets, table, notes', async () => {
  const r = await run('deck.pptx');
  assert.equal(r.title, 'Northwind Traders Release Train');
  assert.deepEqual(byType(r, 'heading').map((b) => [b.text, b.page]),
    [['Northwind Traders Release Train', 1], ['Rollback strategy', 2]]);
  assert.match(r.meta.warnings.join(), /hidden slide\(s\) skipped: 3/);
  assert.equal(byType(r, 'list')[0].text, '- Freeze deployments\n  - Restore snapshot\n- Notify the CAB');
  assert.equal(byType(r, 'table')[0].text, 'Step | Owner\nRestore | Contoso ops');
  assert.deepEqual(byType(r, 'note').map((b) => [b.text, b.page]), [['Speaker notes: Mention the T+1h deadline.', 2]]);
  assert.ok(!texts(r.blocks).some((t) => /^\d$/.test(t)), 'slide-number placeholder skipped');
});

test('md: front matter dropped, one nested list, GFM table, code fence', async () => {
  const r = await run('checklist.md');
  assert.equal(r.title, 'Contoso Go-Live Checklist');
  assert.doesNotMatch(texts(r.blocks).join(), /owner: release/);
  assert.equal(byType(r, 'list')[0].text, '- Backups verified\n  - Snapshot ID recorded\n- Smoke tests green');
  assert.equal(byType(r, 'table')[0].text, 'Check | Owner\nDNS cutover | Contoso ops\nMonitoring | SRE');
  assert.equal(byType(r, 'code')[0].text, 'sf project deploy start --dry-run');
  assert.equal((r.html.match(/<ul>/g) || []).length, 2, 'outer + nested, not one per item');
});

test('html: chrome/script stripped, entities decoded, table and nested list', async () => {
  const r = await run('environments.html');
  assert.equal(r.title, 'Contoso Environment Matrix');
  const all = texts(r.blocks).join('\n');
  assert.doesNotMatch(all, /alert|Home > Spaces/);
  assert.match(all, /refreshed monthly & masked/);
  assert.equal(byType(r, 'table')[0].text, 'Name | Type\nUAT | Full\nSIT | Partial');
  assert.equal(byType(r, 'list')[0].text, '- Refresh\n- Mask data\n  - Northwind Traders contacts');
  assert.doesNotMatch(r.html, /onclick|<script/);
});

test('mhtml: QP in UTF-8 and windows-1252 both decode (N3)', async () => {
  for (const f of ['confluence-utf8.mhtml', 'confluence-1252.mhtml']) {
    const r = await run(f);
    assert.equal(r.title, 'München Cutover', f);
    assert.equal(byType(r, 'paragraph')[0].text, 'Contoso cutover window: Saturday 22:00 - Sunday 06:00.', f);
  }
});

test('txt: windows-1252 without BOM is sniffed', async () => {
  const r = await run('notes-cp1252.txt');
  assert.deepEqual(texts(r.blocks), ['Herr Müller owns the Contoso rollback.', 'Second paragraph.']);
});

/* ---------------- sniffing and errors ---------------- */

test('.doc that is really MHTML, HTML or DOCX is routed by content', async () => {
  const mhtml = fs.readFileSync(path.join(FX, 'confluence-utf8.mhtml'));
  assert.equal((await extract(mhtml, 'export.doc')).meta.extractor, 'mhtml');
  assert.equal((await extract(Buffer.from('<html><body><h1>Web page</h1></body></html>'), 'saved.doc')).title, 'Web page');
  assert.equal((await extract(fs.readFileSync(path.join(FX, 'runbook.docx')), 'renamed.doc')).meta.extractor, 'docx');
});

test('errors are explicit', async () => {
  await assert.rejects(extract(Buffer.from('MZ'), 'tool.exe'), /Unsupported file type: \.exe/);
  await assert.rejects(extract(Buffer.alloc(0), 'empty.pdf'), /File is empty/);
  await assert.rejects(extract(Buffer.from('hello'), 'fake.pdf'), /Not a PDF/);
  await assert.rejects(extract(Buffer.from('not a zip'), 'bad.pptx'), /Could not open \.pptx/);
  await assert.rejects(extract(Buffer.from('plain words'), 'odd.doc'), /Unrecognised \.doc/);
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(16)]);
  await assert.rejects(extract(ole, 'corrupt.doc'), /Could not read legacy \.doc/);
});

test('every block carries a heading_path array; SUPPORTED lists all formats', async () => {
  for (const f of fs.readdirSync(FX).filter((f) => SUPPORTED.includes(path.extname(f)))) {
    for (const b of (await run(f)).blocks) assert.ok(Array.isArray(b.heading_path) && b.text, `${f}: ${JSON.stringify(b)}`);
  }
  for (const ext of ['.pdf', '.doc', '.docx', '.pptx', '.html', '.md', '.txt', '.mhtml']) assert.ok(SUPPORTED.includes(ext), ext);
});

/* ---------------- units ---------------- */

test('decodeQP returns bytes, soft breaks removed', () => {
  assert.deepEqual([...decodeQP('M=C3=BC=\r\nn')], [0x4d, 0xc3, 0xbc, 0x6e]);
});

test('htmlToBlocks: nested tables stay inside their cell; list paragraphs do not split items', () => {
  const b = htmlToBlocks('<table><tr><td>a<table><tr><td>x</td><td>y</td></tr></table></td><td>b</td></tr></table>' +
    '<ul><li><p>one</p><p>more</p></li><li>two</li></ul>');
  assert.deepEqual(b.map((x) => [x.type, x.text]), [['table', 'a x y | b'], ['list', '- one more\n- two']]);
});
