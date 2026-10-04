import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocument } from '../src/server/importer.js';
import * as pages from '../src/pages.js';

const imp = async (filename, content) => {
  const r = await importDocument({ filename, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') });
  return pages.get(r.id);
};

test('html: title from <h1>, scripts/handlers/external src stripped', async () => {
  const p = await imp('raw_name.html',
    '<html><head><title>x</title></head><body><nav>menu</nav><h1>Runbook</h1>' +
    '<p onclick="evil()">Step <b>one</b></p><script>alert(1)</script><img src="http://x/y.png"></body></html>');
  assert.equal(p.title, 'Runbook');
  assert.doesNotMatch(p.body_html, /onclick|<script|<nav|http:\/\/x/);
  assert.match(p.body_text, /Step one/);
});

test('filename becomes the title when there is no heading', async () => {
  const p = await imp('release_notes-v2.txt', 'hello');
  assert.equal(p.title, 'release notes v2');
});

test('txt: escaped and split into paragraphs', async () => {
  const p = await imp('a.txt', 'line <1>\nline 2\n\npara 2');
  assert.equal(p.body_html, '<p>line &lt;1&gt;<br>line 2</p><p>para 2</p>');
});

test('md: title from first # heading, headings and emphasis converted', async () => {
  const p = await imp('x.md', '# Go-Live Plan\n\n## Scope\n\nSome **bold** and `code`.');
  assert.equal(p.title, 'Go-Live Plan');
  assert.match(p.body_html, /<h2>Scope<\/h2>/);
  assert.match(p.body_html, /<strong>bold<\/strong>/);
  assert.match(p.body_html, /<code>code<\/code>/);
});

const mhtml = (qpBody) => [
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="----=_Part_1"',
  '',
  '------=_Part_1',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  qpBody,
  '------=_Part_1--',
  ''
].join('\r\n');

test('mhtml: QP soft breaks joined, html part extracted', async () => {
  const p = await imp('page.mhtml', mhtml('<html><body><h1>Env Matrix</h1><p>long =\r\nline =3D ok</p></body></html>'));
  assert.equal(p.title, 'Env Matrix');
  assert.match(p.body_text, /long line = ok/);
});

test('.doc that is really MHTML (Confluence export) is accepted', async () => {
  const p = await imp('export.doc', mhtml('<html><body><h1>From Confluence</h1></body></html>'));
  assert.equal(p.title, 'From Confluence');
});

test('binary OLE .doc is rejected with a clear message', async () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await assert.rejects(importDocument({ filename: 'old.doc', buffer: ole }), /OLE Compound/);
});

test('unsupported extensions are rejected', async () => {
  await assert.rejects(importDocument({ filename: 'deck.pptx', buffer: Buffer.from('PK') }), /Unsupported file type: \.pptx/);
});

/* ---------------- known defects, fixed in Phase 2 ---------------- */

test('N3: QP-encoded UTF-8 decodes to real characters', { todo: 'N3 (Phase 2)' }, async () => {
  const p = await imp('de.mhtml', mhtml('<html><body><h1>M=C3=BCnchen Cutover</h1></body></html>'));
  assert.equal(p.title, 'München Cutover');
});

test('md: consecutive list items share one <ul>', { todo: 'Phase 2 (marked)' }, async () => {
  const p = await imp('l.md', '- a\n- b\n- c');
  assert.equal((p.body_html.match(/<ul>/g) || []).length, 1);
});
