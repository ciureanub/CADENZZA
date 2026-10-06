import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pages from '../src/pages.js';
import { parseQuery, levenshtein, strict, fuzzy, hybrid, search } from '../src/search/index.js';

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
pages.create({ space_key: 'release', type: 'template', title: 'Smoke Test Checklist', body_html: '<p>Run after deploy.</p>' });

test('strict uses FTS5 and honours filters', () => {
  assert.deepEqual(strict('rollback').map((r) => r.title), ['Cutover Plan']);
  assert.deepEqual(strict('rollback type:template'), []);
  for (const k of ['release', 'deployment', 'environment', 'stakeholder']) {
    assert.deepEqual(strict(`rollback space:${k}`).map((r) => r.title), ['Cutover Plan'], `space:${k}`);
  }
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

test('a filter-only query lists matching pages (e.g. type:template), an empty query lists nothing', () => {
  assert.deepEqual(search('type:template').map((r) => r.title), ['Smoke Test Checklist']);
  assert.equal(search('type:template')[0].mode, 'filter');
  assert.deepEqual(search('space:environment').map((r) => r.title).sort(), ['Cutover Plan', 'Smoke Test Checklist']);
  assert.deepEqual(search(''), []);
});
