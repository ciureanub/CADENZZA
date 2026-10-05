#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, audit } from '../src/db/index.js';
import * as pages from '../src/pages.js';
import * as guard from '../src/entity/guard.js';
import * as vault from '../src/entity/vault.js';
import { search } from '../src/search/index.js';
import { seedTemplates } from '../src/seed/templates.js';
import { buildServer } from '../src/server/index.js';
import { paths } from '../src/config.js';
import { ragChecks } from '../src/rag/health.js';
import * as rag from '../src/rag/ingest.js';
import * as mongoStore from '../src/rag/store/mongo.js';

const program = new Command();
program.name('cadenzza')
  .description('Local-first release management knowledge base with entity pseudonymisation and local RAG')
  .version('0.2.0');

program.command('init')
  .description('Create the database, seed the four spaces and the deliverable templates')
  .option('--entities <file>', 'JSON file of protected entities to seed')
  .action((opts) => {
    db();
    const n = seedTemplates(pages);
    vault.key(); // materialise the vault key now so `doctor` is truthful
    console.log(`Data directory : ${paths.home}`);
    console.log(`Templates      : ${n} created`);
    console.log(`Vault          : ${process.env.CADENZZA_PASSPHRASE ? 'passphrase-derived' : paths.vaultKey}`);
    if (opts.entities) {
      const list = JSON.parse(fs.readFileSync(opts.entities, 'utf8'));
      for (const e of list) {
        const added = guard.addEntity({
          canonical: typeof e === 'string' ? e : e.canonical,
          type: e.type || 'org',
          aliases: e.aliases || [],
          origin: 'seed'
        });
        console.log(`  protected: ${added.canonical} -> ${added.pseudonym}`);
      }
    }
    console.log('\nNext: cadenzza serve');
  });

program.command('serve')
  .description('Start the local server and UI')
  .option('-p, --port <port>', 'port', '4173')
  .option('-h, --host <host>', 'host', '127.0.0.1')
  .action(async (opts) => {
    db();
    if (!db().prepare("SELECT COUNT(*) c FROM page WHERE type='template'").get().c) seedTemplates(pages);
    const app = await buildServer();
    await app.listen({ port: Number(opts.port), host: opts.host });
    console.log(`\n  CADENZZA  ->  http://${opts.host}:${opts.port}`);
    console.log(`  data      ->  ${paths.home}`);
    console.log(`  mode      ->  ${getSetting('storage_mode')} / offline=${getSetting('offline')}\n`);
  });

const ent = program.command('entities').description('Manage the protected entity registry');
ent.command('list').action(() => {
  const rows = guard.listEntities();
  if (!rows.length) return console.log('(none)');
  for (const e of rows) {
    console.log(`${String(e.id).padStart(3)}  ${e.pseudonym.padEnd(12)} ${e.type.padEnd(8)} ${e.canonical}` +
      (e.aliases.length ? `  aliases: ${e.aliases.join(', ')}` : ''));
  }
});
ent.command('add <canonical>')
  .option('-t, --type <type>', 'org|person|project|host|other', 'org')
  .option('-a, --alias <alias...>', 'additional surface forms')
  .action(async (canonical, o) => {
    const e = guard.addEntity({ canonical, type: o.type, aliases: o.alias || [] });
    console.log(`${e.canonical} -> ${e.pseudonym}`);
    const r = await rag.remaskAfterRegistryChange();
    if (r.error) console.log(`  RAG not re-masked now (${r.error}); run: cadenzza rag remask`);
    else if (r.stale) console.log(`  re-masked ${r.stale} ingested document(s)`);
    await mongoStore.close();
  });
ent.command('remove <id>').action((id) => { guard.removeEntity(Number(id)); console.log('removed'); });

program.command('mask [text]')
  .description('Mask text through the boundary (reads stdin if no argument)')
  .action(async (text) => {
    let input = text;
    if (!input) {
      input = '';
      for await (const chunk of process.stdin) input += chunk;
    }
    console.log(guard.mask(input));
  });

program.command('scan [dir]')
  .description('Scan the corpus, and optionally a directory, for unprotected entity surfaces')
  .action((dir) => {
    let flagged = 0;
    for (const p of db().prepare('SELECT id, title, body_text FROM page').all()) {
      for (const h of guard.scanText(`${p.title}\n${p.body_text}`)) {
        if (h.layer === 'gazetteer') continue;
        console.log(`page ${p.id}  [${h.layer}/${h.rule || ''}]  ${h.surface}`);
        flagged++;
      }
    }
    if (dir) {
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, f.name);
          if (f.isDirectory()) { if (f.name !== 'node_modules' && f.name !== '.git') walk(full); continue; }
          if (!/\.(md|txt|html|json|csv|xml|yml|yaml|js|ts)$/i.test(f.name)) continue;
          const text = fs.readFileSync(full, 'utf8');
          for (const e of guard.listEntities()) {
            for (const v of guard.variants(e.canonical, e.aliases)) {
              if (new RegExp(`(?<![A-Za-z0-9_])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(text)) {
                console.log(`LEAK  ${full}  contains ${e.pseudonym}`);
                flagged++;
              }
            }
          }
        }
      };
      walk(dir);
    }
    console.log(flagged ? `\n${flagged} item(s) need attention` : '\nClean.');
    process.exit(flagged ? 1 : 0);
  });

program.command('search <query>')
  .option('-m, --mode <mode>', 'strict|fuzzy|hybrid', 'hybrid')
  .action((q, o) => {
    const rows = search(q, o.mode, 20);
    if (!rows.length) return console.log('(no results)');
    for (const r of rows) {
      console.log(`${String(r.id).padStart(4)}  [${r.space}] ${r.title}`);
      if (r.snippet) console.log(`      ${r.snippet.replace(/<\/?mark>/g, '*').replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  });

program.command('doctor')
  .description('Environment and integrity check')
  .option('--no-rag', 'skip the local RAG service checks (Mongo, Qdrant, Ollama)')
  .action(async (opts) => {
    const d = db();
    let failed = 0;
    const ok = (l, v, detail = '', warn = false) => {
      if (!v) failed++;
      console.log(`  ${!v ? 'FAIL' : warn ? 'warn' : 'ok  '}  ${l}${detail ? `  (${detail})` : ''}`);
    };
    console.log('CADENZZA doctor\n');
    ok(`node ${process.version} (>=20)`, Number(process.versions.node.split('.')[0]) >= 20);
    ok(`data dir ${paths.home}`, fs.existsSync(paths.home));
    ok(`database ${paths.db}`, fs.existsSync(paths.db));
    ok('FTS5 available', (() => { try { d.prepare('SELECT count(*) FROM page_fts').get(); return true; } catch { return false; } })());
    ok('vault key present or passphrase set', !!process.env.CADENZZA_PASSPHRASE || fs.existsSync(paths.vaultKey));
    console.log(`\n  pages       ${d.prepare('SELECT COUNT(*) c FROM page').get().c}`);
    console.log(`  templates   ${d.prepare("SELECT COUNT(*) c FROM page WHERE type='template'").get().c}`);
    console.log(`  entities    ${d.prepare('SELECT COUNT(*) c FROM protected_entity').get().c}`);
    console.log(`  candidates  ${d.prepare("SELECT COUNT(*) c FROM entity_occurrence WHERE status='candidate'").get().c}`);
    console.log(`  storage     ${getSetting('storage_mode')}`);
    console.log(`  offline     ${getSetting('offline')}`);

    if (opts.rag) {
      const models = [getSetting('rag_embed_model', 'bge-m3'), getSetting('rag_gen_model', 'gemma4:latest')];
      console.log('\nLocal RAG services\n');
      for (const c of await ragChecks({ models })) ok(c.label, c.ok, c.detail, c.warn);
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed.');
    process.exitCode = failed ? 1 : 0;
  });

/* ------------------------------------------------------------------ backup */

program.command('backup [dir]')
  .description('Back up everything: SQLite (online), vault key, RAG corpus (Mongo), source files, eval sets')
  .action(async (dir) => {
    const { backupAll } = await import('../src/rag/backup.js');
    try {
      const { dir: out, manifest } = await backupAll(dir ? path.resolve(dir) : undefined);
      console.log(`backup -> ${out}`);
      console.log(`  sqlite   ${manifest.sqlite.integrity}, ${manifest.sqlite.pages} pages`);
      console.log(`  vault    ${manifest.vault_key ? 'vault.key copied (store this backup as securely as the original)' : 'passphrase mode: nothing to copy'}`);
      console.log(`  mongo    ${manifest.mongo_error ? `NOT backed up: ${manifest.mongo_error}` : JSON.stringify(manifest.collections)}`);
      console.log('  qdrant   derived from Mongo: rebuilt on restore');
      if (manifest.mongo_error) process.exitCode = 1;
    } finally { await mongoStore.close(); }
  });

/* ------------------------------------------------------------------ ask */

program.command('ask <question>')
  .description('Ask the ingested material; the answer streams, then numbered sources')
  .option('-k, --k <n>', 'chunks to retrieve (default: setting rag_top_k)')
  .option('--mode <mode>', 'hybrid|dense|exact (default: setting rag_retrieval)')
  .option('-s, --space <key>', 'only this space')
  .option('--type <ext>', 'only this file type, e.g. pdf')
  .option('--json', 'print the full result as JSON')
  .option('--context', 'print the retrieved (masked) chunk text')
  .action(async (question, o) => {
    const { ask } = await import('../src/rag/ask.js');
    try {
      const r = await ask(question, {
        k: o.k ? Number(o.k) : undefined, mode: o.mode,
        filter: { space: o.space, file_type: o.type },
        onToken: o.json ? undefined : (d) => process.stdout.write(d),
        onReplace: o.json ? undefined : (t) => process.stdout.write(`\n[answer re-masked]\n${t}`)
      });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log('\n');
      for (const c of r.citations) {
        const where = [c.title, ...c.heading_path].filter((x, i, a) => x && x !== a[i - 1]).join(' › ');
        const page = c.page_start ? ` p.${c.page_start}${c.page_end !== c.page_start ? `-${c.page_end}` : ''}` : '';
        console.log(`  ${c.cited ? '*' : ' '}[${c.n}] ${where}${page}  (${c.file_type}, score ${c.score.toFixed(4)}${c.dense_rank ? `, dense #${c.dense_rank}` : ''}${c.lexical_rank ? `, lexical #${c.lexical_rank}` : ''})`);
        if (o.context) console.log(`      ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      const t = r.timings;
      console.log(`\n  ${r.refused ? 'REFUSED (not in corpus) | ' : ''}${r.gen_model} via ${r.retrieval_mode}${r.retrieval_fallback ? ' (Qdrant down: exact fallback)' : ''} | embed ${t.embed_ms}ms, search ${t.search_ms}ms, ` +
        `first token ${t.first_token_ms ?? '-'}ms, generate ${t.generate_ms}ms, total ${t.total_ms}ms | tokens in ${r.tokens.prompt ?? '-'} out ${r.tokens.output ?? '-'}`);
    } catch (err) {
      console.error(`error: ${guard.mask(err.message)}`);
      process.exitCode = 1;
    } finally {
      await mongoStore.close();
    }
  });

/* ------------------------------------------------------------------ rag */

const ragCmd = program.command('rag').description('Local RAG corpus: ingest, status, maintenance');

/** Run a rag action, always closing the Mongo connection; errors print masked and exit 1. */
const ragAction = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { console.error(`error: ${guard.mask(err.message)}`); process.exitCode = 1; }
  finally { await mongoStore.close(); }
};

ragCmd.command('ingest <path>')
  .description('Ingest a file or folder (pdf, docx, doc, pptx, html, md, txt, mhtml)')
  .option('-s, --space <key>', 'target space', 'release')
  .option('--sensitivity <level>', 'Public|Internal|Client-Confidential|Restricted (default: space default)')
  .option('--model <id>', 'embedding model (default: active)')
  .option('--force', 're-process even if unchanged')
  .option('--allow-empty-registry', 'ingest even with no protected entities registered')
  .action(ragAction(async (target, o) => {
    const t0 = performance.now();
    let chunks = 0, embedded = 0, embedMs = 0;
    const results = await rag.ingestPath(target, {
      space: o.space, sensitivity: o.sensitivity, model: o.model, force: !!o.force, allowEmptyRegistry: !!o.allowEmptyRegistry
    }, (r) => {
      chunks += r.chunks || 0; embedded += r.embedded || 0; embedMs += r.embed_ms || 0;
      const detail = r.status === 'failed' ? r.error
        : r.status === 'duplicate' ? `same content as ${r.duplicate_of}`
        : `${r.chunks ?? 0} chunks${r.embedded != null ? `, ${r.embedded} embedded, ${r.reused} reused` : ''}`;
      console.log(`  ${r.status.padEnd(10)} ${(r.title || r.filename || '').slice(0, 50).padEnd(50)} ${detail}${r.ms ? `  ${(r.ms / 1000).toFixed(1)}s` : ''}`);
    });
    const failed = results.filter((r) => r.status === 'failed').length;
    console.log(`\n${results.length} file(s), ${failed} failed, ${chunks} chunks, ${embedded} embedded in ${(embedMs / 1000).toFixed(1)}s` +
      (embedded ? ` (${(embedded / (embedMs / 1000)).toFixed(1)} chunks/s)` : '') + `, total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (failed) process.exitCode = 1;
  }));

ragCmd.command('status')
  .option('--json', 'machine-readable')
  .action(ragAction(async (o) => {
    const s = await rag.status();
    if (o.json) return console.log(JSON.stringify({ ...s, docs: undefined }, null, 2));
    console.log(`active model   ${s.active_model}`);
    console.log(`registry       ${s.registry.entities} entities (version ${s.registry.version})`);
    console.log(`mongo          ${s.mongo.documents} documents, ${s.mongo.chunks} chunks, ${s.mongo.embedded} embedded (active), ${s.mongo.staging} staged, ${s.mongo.jobs_failed} failed job(s)`);
    for (const c of s.collections) console.log(`qdrant         ${c.name}: ${c.points} points`);
    console.log(`by status      ${JSON.stringify(s.documents_by_status)}`);
    if (s.stale_documents) console.log(`WARNING        ${s.stale_documents} document(s) masked with an older registry: run cadenzza rag remask`);
    for (const d of s.docs) {
      console.log(`  ${d._id}  ${d.status.padEnd(10)} ${String(d.chunk_count ?? 0).padStart(4)}  ${d.file_type.padEnd(5)} ${d.title.slice(0, 60)}`);
    }
  }));

ragCmd.command('delete <docId>')
  .description('Remove a document from Mongo, Qdrant, its mirror page and the review queue')
  .action(ragAction(async (id) => console.log((await rag.deleteDocument(id)) ? 'deleted' : 'not found')));

ragCmd.command('reindex')
  .description('Rebuild the Qdrant collection entirely from Mongo')
  .option('--model <id>', 'model (default: active)')
  .action(ragAction(async (o) => {
    const r = await rag.reindex({ model: o.model || rag.activeModel() });
    console.log(`${r.collection}: ${r.points} points written, qdrant count ${r.qdrant_count}, mongo embedded ${r.mongo_embedded}` +
      (r.qdrant_count === r.mongo_embedded ? '  (match)' : '  MISMATCH'));
    if (r.qdrant_count !== r.mongo_embedded) process.exitCode = 1;
  }));

ragCmd.command('reembed')
  .description('Blue/green: embed all chunks with another model into its own collection (does not switch)')
  .requiredOption('--model <id>', 'new embedding model')
  .action(ragAction(async (o) => {
    const r = await rag.reembed({ model: o.model }, (n) => process.stdout.write(`\r  embedded ${n}`));
    console.log(`\n${r.collection}: ${r.qdrant_count} points. Evaluate, then: cadenzza rag activate --model ${o.model}`);
  }));

ragCmd.command('activate')
  .description('Blue/green: switch retrieval to a fully re-embedded model')
  .requiredOption('--model <id>', 'model to activate')
  .action(ragAction(async (o) => {
    const r = await rag.activate({ model: o.model });
    console.log(`active model ${r.previous} -> ${r.active} (${r.collection}). Old vectors kept until: cadenzza rag prune --yes`);
  }));

ragCmd.command('prune')
  .description('Blue/green: drop collections and vectors of inactive models')
  .option('--yes', 'confirm')
  .action(ragAction(async (o) => {
    if (!o.yes) { console.log('This deletes the vectors of every inactive model. Re-run with --yes to confirm.'); return; }
    const r = await rag.prune();
    console.log(r.length ? r.map((d) => `dropped ${d.collection} (${d.vectors_removed} vectors)`).join('\n') : 'nothing to prune');
  }));

ragCmd.command('restore <dir>')
  .description('Restore the RAG corpus (Mongo + source files) from a backup, then rebuild Qdrant')
  .option('--replace', 'overwrite a non-empty corpus')
  .action(ragAction(async (dir, o) => {
    const { restoreRag } = await import('../src/rag/backup.js');
    const r = await restoreRag(path.resolve(dir), { replace: !!o.replace });
    console.log(`restored ${JSON.stringify(r.counts)}` + (r.reindex ? `; ${r.reindex.collection}: ${r.reindex.qdrant_count} points (mongo ${r.reindex.mongo_embedded})` : ''));
  }));

ragCmd.command('wipe')
  .description('Delete the whole RAG corpus (Mongo, Qdrant, source copies, mirror pages); wiki, registry and vault stay')
  .option('--yes', 'confirm')
  .option('--keep-pages', 'keep the mirror pages in the wiki')
  .action(ragAction(async (o) => {
    if (!o.yes) { console.log('This deletes every ingested document, chunk and vector. Back up first (cadenzza backup), then re-run with --yes.'); return; }
    const { wipeRag } = await import('../src/rag/backup.js');
    console.log(JSON.stringify(await wipeRag({ keepPages: !!o.keepPages })));
  }));

ragCmd.command('eval')
  .description('Evaluate retrieval (and answers) against golden question sets')
  .option('--set <file...>', 'golden JSONL file(s); default: test/eval/golden.jsonl + CADENZZA_HOME/rag/eval/golden-local.jsonl')
  .option('--retrieval-only', 'skip generation (fast: recall@k and MRR only)')
  .option('--mode <mode>', 'hybrid|dense|exact (default: setting rag_retrieval)')
  .option('--label <name>', 'name for the results file', 'eval')
  .action(ragAction(async (o) => {
    const { runEval } = await import('../src/rag/eval.js');
    const files = o.set || [
      fileURLToPath(new URL('../test/eval/golden.jsonl', import.meta.url)),
      path.join(paths.rag, 'eval', 'golden-local.jsonl')
    ];
    const r = await runEval({
      files, retrievalOnly: !!o.retrievalOnly, mode: o.mode, label: o.label,
      onItem: (it) => console.log(`  ${it.type === 'refuse' ? 'R' : ' '} ${String(it.id).padEnd(10)} rank ${String(it.first_relevant_rank ?? '-').padStart(2)}` +
        (it.answer != null ? `  ${it.refusal_correct ? 'ok ' : 'BAD'} ${it.must_total ? `must ${it.must_found}/${it.must_total}` : '        '} cited ${it.cited_relevant}/${it.cited}  ${(it.total_ms / 1000).toFixed(1)}s` : ''))
    });
    console.log(`\n${JSON.stringify(r.config)}\n${JSON.stringify(r.summary, null, 2)}\nresults: ${r.file}`);
  }));

ragCmd.command('remask')
  .description('Re-apply masking to documents ingested before the latest registry change')
  .action(ragAction(async () => {
    const r = await rag.remask();
    console.log(r.length ? r.map((d) => `  ${d.doc_id}  ${d.changed}/${d.chunks} chunks changed, ${d.reembedded} re-embedded`).join('\n') : 'nothing stale');
  }));

program.parse();
