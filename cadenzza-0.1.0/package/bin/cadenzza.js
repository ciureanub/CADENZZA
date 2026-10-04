#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting, audit } from '../src/db/index.js';
import * as pages from '../src/pages.js';
import * as guard from '../src/entity/guard.js';
import * as vault from '../src/entity/vault.js';
import { search } from '../src/search/index.js';
import { seedTemplates } from '../src/seed/templates.js';
import { buildServer } from '../src/server/index.js';
import { paths } from '../src/config.js';

const program = new Command();
program.name('cadenzza')
  .description('Local-first release management knowledge base with entity pseudonymisation')
  .version('0.1.0');

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
  .action((canonical, o) => {
    const e = guard.addEntity({ canonical, type: o.type, aliases: o.alias || [] });
    console.log(`${e.canonical} -> ${e.pseudonym}`);
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
  .action(() => {
    const d = db();
    const ok = (l, v) => console.log(`  ${v ? 'ok  ' : 'FAIL'}  ${l}`);
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
  });

program.parse();
