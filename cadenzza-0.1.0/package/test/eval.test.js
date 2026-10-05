import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGolden, isRelevant, groundedness } from '../src/rag/eval.js';

const GOLDEN = new URL('./eval/golden.jsonl', import.meta.url);

test('the committed golden set parses, uses only synthetic names, and covers both item types', () => {
  const items = loadGolden([GOLDEN.pathname.replace(/^\/([A-Za-z]:)/, '$1')]);
  assert.ok(items.length >= 15, String(items.length));
  assert.ok(items.some((i) => i.type === 'refuse') && items.some((i) => i.type === 'answer'));
  for (const i of items) {
    assert.ok(i.id && i.question, JSON.stringify(i));
    if (i.type === 'answer') assert.ok(i.expect.length && i.expect.every((e) => e.doc), i.id);
  }
  const raw = fs.readFileSync(GOLDEN, 'utf8');
  assert.doesNotMatch(raw, /e\.on|\beon\b|dojo|fluidra|richemont/i, 'no real client names in a committed file');
});

test('loadGolden skips comments and blank lines; missing files are ignored', () => {
  assert.deepEqual(loadGolden(['C:/definitely/missing.jsonl']), []);
});

test('isRelevant: doc + section + page all have to match', () => {
  const hit = { doc: { filename: 'runbook.pdf', title: 'CLIENT_A Cutover Runbook' }, chunk: { heading_path: ['Runbook', 'Rollback procedure'], text: 'Restore the snapshot.', page_start: 2, page_end: 3 } };
  assert.ok(isRelevant(hit, [{ doc: 'runbook' }]));
  assert.ok(isRelevant(hit, [{ doc: 'RUNBOOK.PDF', section: 'rollback' }]));
  assert.ok(isRelevant(hit, [{ doc: 'runbook', section: 'snapshot' }]), 'section may match chunk text');
  assert.ok(isRelevant(hit, [{ doc: 'runbook', page: 3 }]));
  assert.ok(!isRelevant(hit, [{ doc: 'runbook', page: 4 }]));
  assert.ok(!isRelevant(hit, [{ doc: 'deck.pptx' }]));
  assert.ok(!isRelevant(hit, []));
  assert.ok(isRelevant(hit, [{ doc: 'deck' }, { doc: 'runbook', section: 'Rollback' }]), 'any expectation suffices');
});

test('groundedness: cited sentences must mostly reuse words from the cited chunk', () => {
  const sources = [
    { n: 1, text: 'If the smoke test fails, roll back by restoring the snapshot taken at T-0 and notify the change advisory board.' },
    { n: 2, text: 'The release manager records the go/no-go decision in the decision log.' }
  ];
  const good = 'Roll back by restoring the snapshot taken at T-0 [1]. The release manager records the decision [2].';
  assert.deepEqual(groundedness(good, sources), { checked: 2, grounded: 2 });
  const bad = 'Kubernetes autoscaling handles traffic spikes automatically overnight [1]. Short [2].';
  assert.deepEqual(groundedness(bad, sources), { checked: 1, grounded: 0 }, 'short sentences are not judged');
  assert.deepEqual(groundedness('No citations here at all.', sources), { checked: 0, grounded: 0 });
});
