import { HOME } from './_env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildServer } from '../src/server/index.js';

const app = await buildServer();
after(() => app.close());

const IMPORT_ROOT = path.join(HOME, 'import');
const OUTSIDE = path.join(HOME, 'outside.txt');
fs.mkdirSync(IMPORT_ROOT, { recursive: true });
fs.writeFileSync(path.join(IMPORT_ROOT, 'inside.txt'), 'inside the import root');
fs.writeFileSync(OUTSIDE, 'secret outside the import root');

const importJson = (filePath) => app.inject({ method: 'POST', url: '/api/import', payload: { filePath } });

/* ---------------- /api/import JSON branch: allow-listed root only ---------------- */

test('JSON import reads a file inside CADENZZA_HOME/import (relative or absolute)', async () => {
  for (const fp of ['inside.txt', path.join(IMPORT_ROOT, 'inside.txt')]) {
    const r = await importJson(fp);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().imported[0].title, 'inside');
  }
});

test('JSON import refuses absolute paths outside the import root', async () => {
  const r = await importJson(OUTSIDE);
  assert.equal(r.statusCode, 403, r.body);
  assert.doesNotMatch(r.body, /secret/);
});

test('JSON import refuses traversal out of the import root', async () => {
  for (const fp of ['../outside.txt', '..\\outside.txt', 'sub/../../outside.txt']) {
    assert.equal((await importJson(fp)).statusCode, 403, fp);
  }
});

test('JSON import does not reveal whether an outside path exists', async () => {
  const a = await importJson(path.join(HOME, 'nope.txt'));
  const b = await importJson(OUTSIDE);
  assert.equal(a.statusCode, 403);
  assert.equal(b.statusCode, 403);
  assert.equal(a.body, b.body);
});

test('JSON import of a missing file inside the root is a 404', async () => {
  assert.equal((await importJson('missing.txt')).statusCode, 404);
});

test('JSON import of an unsupported type is a 400, not a 500', async () => {
  fs.writeFileSync(path.join(IMPORT_ROOT, 'x.exe'), 'MZ');
  assert.equal((await importJson('x.exe')).statusCode, 400);
});

/* ---------------- /api/import multipart: every file, per-file errors ---------------- */

function multipart(files) {
  const boundary = '----cadenzzaTest';
  const chunks = [];
  for (const [name, content] of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

test('multipart import processes every file, not just the first', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/import', ...multipart([['one.txt', 'a'], ['two.md', '# Two']]) });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().imported.map((x) => x.title), ['one', 'Two']);
});

test('multipart import reports per-file failures as 400s without losing the good files', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/import', ...multipart([['ok.txt', 'a'], ['bad.exe', 'MZ']]) });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.deepEqual(body.imported.map((x) => x.title), ['ok']);
  assert.equal(body.failed[0].filename, 'bad.exe');
  assert.match(body.failed[0].error, /Unsupported file type/);

  const allBad = await app.inject({ method: 'POST', url: '/api/import', ...multipart([['bad.exe', 'MZ']]) });
  assert.equal(allBad.statusCode, 400);
});

/* ---------------- static: stray fragments no longer shipped ---------------- */

test('stray web fragments are gone', async () => {
  for (const f of ['/index-new.html', '/index-fix.html']) {
    assert.equal((await app.inject({ url: f })).statusCode, 404, f);
  }
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
});
