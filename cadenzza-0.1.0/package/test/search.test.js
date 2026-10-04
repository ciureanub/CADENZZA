import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pages from '../src/pages.js';
import { parseQuery, levenshtein, strict, fuzzy, hybrid } from '../src/search/index.js';

test('parseQuery splits field filters from free text', () => {
  assert.deepEqual(parseQuery('cutover space:release tag:"go live" type:deliverable'), {
    text: 'cutover',
    filters: { space: 'release', tag: 'go live', type: 'deliverable' }
  });
});

test('parseQuery keeps unknown prefixes and quoted phrases as text', () => {
  assert.deepEqual(parseQuery('"rollback plan" foo:bar'), { text: '"rollback plan" foo:bar', filters: {} });
});

test('levenshtein', () => {
  assert.equal(levenshtein('cutover', 'cutver'), 1);
  assert.equal(levenshtein('Plan', 'plna'), 2);
  assert.equal(levenshtein('', 'abc'), 3);
});

pages.create({ space_key: 'release', title: 'Cutover Plan', body_html: '<p>Rollback procedure for a failed cutover.</p>' });
pages.create({ space_key: 'deployment', title: 'Smoke Test Checklist', body_html: '<p>Run after deploy.</p>' });

test('strict uses FTS5 and honours filters', () => {
  assert.deepEqual(strict('rollback').map((r) => r.title), ['Cutover Plan']);
  assert.deepEqual(strict('rollback space:deployment'), []);
});

test('fuzzy tolerates typos', () => {
  assert.equal(fuzzy('cutver plna')[0].title, 'Cutover Plan');
});

test('hybrid fuses both lists with RRF (k=60)', () => {
  const [top] = hybrid('cutover');
  assert.equal(top.title, 'Cutover Plan');
  assert.deepEqual(top.modes.sort(), ['fuzzy', 'strict']);
  assert.ok(Math.abs(top.rrf - 2 / 61) < 1e-12, `rrf=${top.rrf}`);
});
