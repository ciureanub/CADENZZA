#!/usr/bin/env node
/**
 * Model / chunking comparison on isolated namespaces (never touches the live corpus).
 *
 *   node test/eval/compare.mjs setup  <cfg>          fresh home + registry copied from the live one
 *   node test/eval/compare.mjs ingest <cfg> <dir...>  ingest a corpus with that config
 *   node test/eval/compare.mjs eval   <cfg> [--full] [--mode m] [--gen model] [--cpu]
 *   node test/eval/compare.mjs drop   <cfg>          drop its Mongo db + Qdrant collections
 *   node test/eval/compare.mjs report                table of every results file
 *
 * Run from the package dir with CADENZZA_HOME pointing at the live home (registry source).
 * Each config gets CADENZZA_HOME/rag/eval/runs/<cfg>/home, Mongo db cadenzza_rag_eval_<cfg>,
 * Qdrant prefix eval_<cfg>. Results land in that home's rag/eval/*.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

export const CONFIGS = {
  'bge-450':      { rag_embed_model: 'bge-m3',               rag_chunk_tokens: '450', rag_chunk_merge_min: '0' },
  'qwen3e-450':   { rag_embed_model: 'qwen3-embedding:0.6b', rag_chunk_tokens: '450', rag_chunk_merge_min: '0' },
  'bge-250':      { rag_embed_model: 'bge-m3',               rag_chunk_tokens: '250', rag_chunk_merge_min: '0' },
  'bge-450-m120': { rag_embed_model: 'bge-m3',               rag_chunk_tokens: '450', rag_chunk_merge_min: '120' }
};
// Fixture names used by test/eval/golden.jsonl (synthetic).
const FIXTURE_ENTITIES = [{ canonical: 'Contoso SE', aliases: ['contoso.com'] }, { canonical: 'Northwind Traders', aliases: [] }];

const LIVE = process.env.CADENZZA_HOME;
const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const CLI = path.join(PKG, 'bin', 'cadenzza.js');
const runsDir = path.join(LIVE, 'rag', 'eval', 'runs');
const envFor = (cfg) => ({
  ...process.env,
  CADENZZA_HOME: path.join(runsDir, cfg, 'home'),
  CADENZZA_MONGO_DB: `cadenzza_rag_eval_${cfg.replace(/[^\w]/g, '_')}`,
  CADENZZA_QDRANT_PREFIX: `eval_${cfg.replace(/[^\w]/g, '_')}`
});
const cli = (cfg, args) => {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(PKG, 'infra', 'offline-guard.mjs')).href, CLI, ...args], { env: envFor(cfg), stdio: 'inherit', cwd: PKG });
  if (r.status !== 0) process.exitCode = r.status || 1;
};
const node = (cfg, code) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: envFor(cfg), stdio: 'inherit', cwd: PKG });
  if (r.status !== 0) throw new Error(`setup step failed (${r.status})`);
};

const [cmd, cfg, ...rest] = process.argv.slice(2);
if (!LIVE) throw new Error('set CADENZZA_HOME to the live home');
if (cmd !== 'report' && !CONFIGS[cfg]) throw new Error(`unknown config ${cfg}; one of ${Object.keys(CONFIGS).join(', ')}`);

if (cmd === 'setup') {
  // Same entities, same order => same pseudonyms as the live corpus; then the fixture names.
  const live = new Database(path.join(LIVE, 'cadenzza.db'), { readonly: true });
  const entities = live.prepare('SELECT canonical, type, aliases FROM protected_entity WHERE active = 1 ORDER BY id').all()
    .map((e) => ({ canonical: e.canonical, type: e.type, aliases: JSON.parse(e.aliases) }));
  live.close();
  fs.mkdirSync(envFor(cfg).CADENZZA_HOME, { recursive: true });
  const settings = { ...CONFIGS[cfg], rag_create_page: '0' };
  node(cfg, `
    const guard = await import('file:///${PKG.replace(/\\/g, '/')}/src/entity/guard.js');
    const { setSetting } = await import('file:///${PKG.replace(/\\/g, '/')}/src/db/index.js');
    for (const e of ${JSON.stringify([...entities, ...FIXTURE_ENTITIES])}) guard.addEntity(e);
    for (const [k, v] of Object.entries(${JSON.stringify(settings)})) setSetting(k, v);
    console.log('${cfg}: registry', guard.listEntities().length, 'entities; settings', ${JSON.stringify(JSON.stringify(settings))});`);
} else if (cmd === 'ingest') {
  for (const dir of rest) cli(cfg, ['rag', 'ingest', dir]);
} else if (cmd === 'eval') {
  const full = rest.includes('--full');
  const mode = rest.includes('--mode') ? rest[rest.indexOf('--mode') + 1] : null;
  const gen = rest.includes('--gen') ? rest[rest.indexOf('--gen') + 1] : null;
  const cpu = rest.includes('--cpu');
  if (gen || full) {
    node(cfg, `const { setSetting } = await import('file:///${PKG.replace(/\\/g, '/')}/src/db/index.js');
      ${gen ? `setSetting('rag_gen_model', ${JSON.stringify(gen)});` : ''} setSetting('rag_gen_num_gpu', ${JSON.stringify(cpu ? '0' : 'auto')});`);
  }
  const label = [cfg, mode || 'hybrid', full ? (gen || 'gen').replace(/[^\w.-]/g, '_') + (cpu ? '-cpu' : '') : 'retrieval'].join('__');
  const files = [path.join(PKG, 'test', 'eval', 'golden.jsonl'), path.join(LIVE, 'rag', 'eval', 'golden-local.jsonl')];
  cli(cfg, ['rag', 'eval', '--set', ...files, '--label', label, ...(full ? [] : ['--retrieval-only']), ...(mode ? ['--mode', mode] : [])]);
} else if (cmd === 'drop') {
  node(cfg, `
    const mongo = await import('file:///${PKG.replace(/\\/g, '/')}/src/rag/store/mongo.js');
    const q = await import('file:///${PKG.replace(/\\/g, '/')}/src/rag/store/qdrant.js');
    const { RAG } = await import('file:///${PKG.replace(/\\/g, '/')}/src/config.js');
    for (const c of await q.listCollections()) if (c.startsWith(RAG.qdrantPrefix + '_')) await q.dropCollection(c);
    await (await mongo.mongo()).dropDatabase(); await mongo.close(); console.log('dropped', RAG.mongoDb);`);
} else if (cmd === 'report') {
  const rows = [];
  for (const c of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    const dir = path.join(runsDir, c, 'home', 'rag', 'eval');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      rows.push({ label: r.config.label, chunks: r.config.corpus.chunks, ...r.summary });
    }
  }
  const cols = ['label', 'chunks', 'recall_at_5', 'recall_at_10', 'mrr_at_10', 'retrieval_ms_p50', 'refusal_accuracy_on_refuse_items', 'false_refusal_rate',
    'must_contain_all', 'citation_accuracy', 'groundedness', 'uncited_rate', 'total_ms_p50', 'total_ms_p95'];
  console.log(cols.join('\t'));
  for (const r of rows.sort((a, b) => a.label.localeCompare(b.label))) console.log(cols.map((k) => r[k] ?? '').join('\t'));
}
