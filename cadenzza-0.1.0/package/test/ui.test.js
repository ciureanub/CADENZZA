/**
 * Static checks on the single-file UI: the script parses (v0.1 shipped with a syntax error that
 * killed the whole page), new code uses addEventListener, the RAG views are present, and
 * nothing references an external URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

test('the UI script compiles', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html#script' }));
});

test('no external resources: no http(s) URLs, no CDN, system fonts only', () => {
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import|fonts\.googleapis|cdn\./i);
});

test('RAG UI pieces are present and wired with addEventListener', () => {
  for (const id of ['askbtn', 'libbtn']) assert.match(html, new RegExp(`id="${id}"`));
  for (const fn of ['library', 'askView', 'runAsk', 'applyReveal', 'filesFromDrop', 'upload', 'loadDocs']) {
    assert.match(script, new RegExp(`(?:async )?function ${fn}\\(`), fn);
  }
  assert.match(script, /\$\('#askbtn'\)\.addEventListener\('click', askView\)/);
  assert.match(script, /\$\('#libbtn'\)\.addEventListener\('click', library\)/);
  const ragBlock = script.slice(script.indexOf('RAG (v0.2)'));
  assert.doesNotMatch(ragBlock, /\sonclick=/, 'new code adds no inline onclick handlers');
});

test('header badge shows PRIVATE · LOCAL when offline', () => {
  assert.match(script, /\(META\.settings\.offline === '1' \? ' (?:\\u00B7|·) LOCAL' : ''\)/);
});

test('copy says pseudonymisation, never anonymised', () => {
  assert.match(html, /pseudonymisation, not anonymisation/i);
  assert.doesNotMatch(html.replace(/not anonymisation/gi, ''), /\banonymi[sz]/i);
});

test('api() sends a JSON content-type only with a body (v0.1 retire/purge returned 400)', () => {
  assert.match(script, /headers: o\.body \? \{ 'content-type': 'application\/json' \} : \{\}/);
});

test('Review button keeps its label (v0.1 replaced it with the bare count, or nothing)', () => {
  assert.equal((script.match(/\$\('#revn'\)\.textContent = 'Review' \+/g) || []).length, 2);
});
