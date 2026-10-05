import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, chunkId, uuidv5, estimateTokens, DEFAULTS } from '../src/rag/chunk.js';

const P = (text, heading_path = ['H1'], page) => ({ type: 'paragraph', text, heading_path, page });
const H = (level, text, heading_path) => ({ type: 'heading', level, text, heading_path });
const sentence = (i) => `Sentence number ${i} explains one release step in enough words to matter for retrieval.`;
const longPara = (n, from = 0) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ');

test('sections: one chunk per section, breadcrumb prefix, heading-only sections skipped', () => {
  const blocks = [
    H(1, 'Runbook', ['Runbook']),
    H(2, 'Empty', ['Runbook', 'Empty']),
    H(2, 'Rollback', ['Runbook', 'Rollback']),
    P('Restore the snapshot.', ['Runbook', 'Rollback'], 3),
    H(2, 'Comms', ['Runbook', 'Comms']),
    P('Tell the CAB.', ['Runbook', 'Comms'], 4)
  ];
  const cs = chunk(blocks, { title: 'CLIENT_A Runbook' });
  assert.deepEqual(cs.map((c) => c.embed_text), [
    'CLIENT_A Runbook › Runbook › Rollback\n\nRestore the snapshot.',
    'CLIENT_A Runbook › Runbook › Comms\n\nTell the CAB.'
  ]);
  assert.deepEqual(cs.map((c) => [c.chunk_index, c.text, c.page_start, c.page_end]), [[0, 'Restore the snapshot.', 3, 3], [1, 'Tell the CAB.', 4, 4]]);
});

test('breadcrumb does not repeat the title when the first heading equals it', () => {
  const [c] = chunk([H(1, 'Plan', ['Plan']), P('x', ['Plan'])], { title: 'Plan' });
  assert.equal(c.embed_text, 'Plan\n\nx');
});

test('long sections split under the target with ~15% sentence overlap', () => {
  const cs = chunk([P(longPara(120))], { title: 'Doc' });
  assert.ok(cs.length >= 4, `chunks=${cs.length}`);
  for (const c of cs) assert.ok(c.token_estimate <= DEFAULTS.targetTokens, `chunk ${c.chunk_index}: ${c.token_estimate}`);
  for (let i = 1; i < cs.length; i++) {
    const prevSentences = cs[i - 1].text.split(/(?<=\.)\s+/);
    const firstOfNext = cs[i].text.split(/(?<=\.)\s+/)[0];
    assert.ok(prevSentences.slice(-3).includes(firstOfNext), `chunk ${i} starts with overlap from chunk ${i - 1}`);
    assert.ok(cs[i].overlap_tokens > 0 && cs[i].overlap_tokens <= DEFAULTS.targetTokens * DEFAULTS.overlapRatio);
  }
  const all = new Set(cs.flatMap((c) => c.text.split(/(?<=\.)\s+/)));
  for (let i = 0; i < 120; i++) assert.ok(all.has(sentence(i)), `sentence ${i} lost`);
});

test('big tables: every piece repeats the header, rows are never split or overlapped', () => {
  const rows = Array.from({ length: 150 }, (_, i) => `REL-${1000 + i} | Owner ${i} | Deploy window ${i} | Approved`);
  const table = { type: 'table', text: ['Release | Owner | Window | Status', ...rows].join('\n'), heading_path: ['Inventory'] };
  const cs = chunk([table], { title: 'Matrix' });
  assert.ok(cs.length > 1);
  const seen = [];
  for (const c of cs) {
    const lines = c.text.split('\n');
    assert.equal(lines[0], 'Release | Owner | Window | Status');
    assert.equal(c.overlap_tokens, 0);
    assert.ok(c.token_estimate <= DEFAULTS.targetTokens);
    seen.push(...lines.slice(1));
  }
  assert.deepEqual(seen, rows, 'each row exactly once, whole, in order');
});

test('lists split by line; an unsplittable run-on text is hard-split under the target', () => {
  const list = { type: 'list', text: Array.from({ length: 200 }, (_, i) => `- item ${i} with a short description`).join('\n'), heading_path: [] };
  const runOn = P('word '.repeat(3000).trim(), []);
  for (const c of chunk([list, runOn])) assert.ok(c.token_estimate <= DEFAULTS.targetTokens, `${c.block_types} ${c.token_estimate}`);
});

test('deterministic: same input -> identical chunks, hashes and ids', () => {
  const blocks = [H(1, 'A', ['A']), P(longPara(40), ['A']), H(1, 'B', ['B']), P(longPara(10, 40), ['B'])];
  const a = chunk(blocks, { title: 'T' });
  const b = chunk(structuredClone(blocks), { title: 'T' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((c) => chunkId('doc-1', c)), b.map((c) => chunkId('doc-1', c)));
  assert.match(chunkId('doc-1', a[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(chunkId('doc-1', a[0]), chunkId('doc-2', a[0]));
});

test('editing one section leaves earlier chunk hashes unchanged', () => {
  const base = [H(1, 'A', ['A']), P(longPara(30), ['A']), H(1, 'B', ['B']), P('old text', ['B'])];
  const edited = [...base.slice(0, 3), P('new text', ['B'])];
  const a = chunk(base, { title: 'T' }), b = chunk(edited, { title: 'T' });
  assert.deepEqual(a.slice(0, -1).map((c) => c.chunk_sha256), b.slice(0, -1).map((c) => c.chunk_sha256));
  assert.notEqual(a.at(-1).chunk_sha256, b.at(-1).chunk_sha256);
});

test('uuidv5 matches the RFC 4122 layout and is stable', () => {
  assert.equal(uuidv5('x'), uuidv5('x'));
  assert.notEqual(uuidv5('x'), uuidv5('y'));
});

test('estimateTokens is conservative per type', () => {
  assert.ok(estimateTokens('a'.repeat(300), 'table') > estimateTokens('a'.repeat(300), 'paragraph'));
});

test('mergeMinTokens merges tiny sibling sections under their parent, keeping child headings inline', () => {
  const blocks = [H(1, 'Plan', ['Plan'])];
  for (let i = 1; i <= 6; i++) blocks.push(H(2, `Step ${i}`, ['Plan', `Step ${i}`]), P(`Do thing ${i}.`, ['Plan', `Step ${i}`], i));
  blocks.push(H(1, 'Other', ['Other']), P('Separate top-level section.', ['Other']));
  const plain = chunk(blocks, { title: 'T' });
  const merged = chunk(blocks, { title: 'T', mergeMinTokens: 120 });
  assert.equal(plain.length, 7);
  assert.equal(merged.length, 2, 'six steps -> one chunk; the other top-level section stays separate');
  assert.deepEqual(merged[0].heading_path, ['Plan']);
  assert.match(merged[0].text, /^Step 1\nDo thing 1\.\n\nStep 2\nDo thing 2\./);
  assert.deepEqual([merged[0].page_start, merged[0].page_end], [1, 6]);
  assert.deepEqual(merged[1].heading_path, ['Other']);
  assert.equal(merged[0].chunker_config, '1.0.0/t450/o15/m120');
  assert.equal(plain[0].chunker_config, '1.0.0/t450/o15/m0');
  assert.deepEqual(merged.map((c) => c.chunk_index), [0, 1]);
});

test('merging never exceeds the target', () => {
  const blocks = [H(1, 'Plan', ['Plan'])];
  for (let i = 1; i <= 40; i++) blocks.push(H(2, `S${i}`, ['Plan', `S${i}`]), P(longPara(2, i * 2), ['Plan', `S${i}`]));
  for (const c of chunk(blocks, { title: 'T', mergeMinTokens: 300 })) assert.ok(c.token_estimate <= DEFAULTS.targetTokens, String(c.token_estimate));
});
