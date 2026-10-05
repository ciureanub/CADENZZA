/**
 * Backup / restore / wipe for the whole local data set.
 *
 *   backupAll(dir)   SQLite (online backup API: consistent while in use), vault key, every Mongo
 *                    collection as canonical EJSON lines (Float32 vectors preserved), stored source
 *                    files, eval sets, manifest.json. Qdrant is derived data: restore rebuilds it.
 *   restoreRag(dir)  Mongo collections + source files from a backup, then reindex Qdrant.
 *                    (SQLite and the vault key are restored by copying the files back while the
 *                    server is stopped - see README.)
 *   wipeRag()        Drop the RAG corpus: Mongo db, Qdrant collections, source copies, doc review rows,
 *                    and (unless keepPages) the mirror pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BSON } from 'mongodb';
import { paths, RAG } from '../config.js';

const { EJSON } = BSON;
import { db, audit, setSetting } from '../db/index.js';
import * as pages from '../pages.js';
import * as mongo from './store/mongo.js';
import * as qdrant from './store/qdrant.js';
import { reindex, activeModel } from './ingest.js';

const copyDir = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

export async function backupAll(dir = path.join(paths.home, 'backup', new Date().toISOString().replace(/[:.]/g, '-'))) {
  fs.mkdirSync(path.join(dir, 'mongo'), { recursive: true });
  const manifest = { created_at: new Date().toISOString(), home: paths.home, mongo_db: RAG.mongoDb, active_model: activeModel(), collections: {} };

  // SQLite: online backup is consistent with concurrent writers (a file copy of a WAL db is not).
  await db().backup(path.join(dir, 'cadenzza.db'));
  const check = new Database(path.join(dir, 'cadenzza.db'), { readonly: true });
  manifest.sqlite = { integrity: check.pragma('integrity_check', { simple: true }), pages: check.prepare('SELECT COUNT(*) c FROM page').get().c };
  check.close();
  if (fs.existsSync(paths.vaultKey)) { fs.copyFileSync(paths.vaultKey, path.join(dir, 'vault.key')); manifest.vault_key = true; }

  try {
    const m = await mongo.mongo();
    for (const { name } of await m.listCollections().toArray()) {
      const out = fs.createWriteStream(path.join(dir, 'mongo', `${name}.ejson.jsonl`));
      let n = 0;
      for await (const doc of m.collection(name).find()) { out.write(EJSON.stringify(doc, { relaxed: false }) + '\n'); n++; }
      await new Promise((r) => out.end(r));
      manifest.collections[name] = n;
    }
  } catch (err) {
    manifest.mongo_error = err.message; // RAG services down: SQLite + key are still backed up
  }
  fs.mkdirSync(path.join(dir, 'rag'), { recursive: true });
  copyDir(path.join(paths.rag, 'sources'), path.join(dir, 'rag', 'sources'));
  for (const f of ['ollama-igpu.on']) if (fs.existsSync(path.join(paths.rag, f))) fs.copyFileSync(path.join(paths.rag, f), path.join(dir, 'rag', f));
  const evalDir = path.join(paths.rag, 'eval');
  if (fs.existsSync(evalDir)) {
    fs.mkdirSync(path.join(dir, 'rag', 'eval'), { recursive: true });
    for (const f of fs.readdirSync(evalDir).filter((x) => x.endsWith('.jsonl'))) fs.copyFileSync(path.join(evalDir, f), path.join(dir, 'rag', 'eval', f));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  audit('backup', `dir=${dir} mongo=${JSON.stringify(manifest.collections)}`);
  return { dir, manifest };
}

/** Load Mongo collections + source files from a backup dir, then rebuild Qdrant from Mongo. */
export async function restoreRag(dir, { replace = false } = {}) {
  const m = await mongo.mongo();
  const existing = (await m.collection('documents').countDocuments()) + (await m.collection('chunks').countDocuments());
  if (existing && !replace) throw new Error(`target ${RAG.mongoDb} is not empty (${existing} records); pass --replace to overwrite`);
  const files = fs.readdirSync(path.join(dir, 'mongo')).filter((f) => f.endsWith('.ejson.jsonl'));
  const counts = {};
  for (const f of files) {
    const name = f.replace(/\.ejson\.jsonl$/, '');
    await m.collection(name).deleteMany({});
    const docs = fs.readFileSync(path.join(dir, 'mongo', f), 'utf8').split('\n').filter(Boolean).map((l) => EJSON.parse(l, { relaxed: false }));
    for (let i = 0; i < docs.length; i += 500) await m.collection(name).insertMany(docs.slice(i, i + 500), { ordered: false });
    counts[name] = docs.length;
  }
  copyDir(path.join(dir, 'rag', 'sources'), path.join(paths.rag, 'sources'));
  const idx = counts.chunks ? await reindex() : null;
  audit('rag.restore', `dir=${dir} ${JSON.stringify(counts)}`);
  return { counts, reindex: idx };
}

/** Remove the RAG corpus everywhere. The wiki, the registry and the vault are untouched. */
export async function wipeRag({ keepPages = false } = {}) {
  const docs = await mongo.listDocuments().catch(() => []);
  let pagesRemoved = 0;
  if (!keepPages) for (const d of docs) if (d.page_id && pages.get(d.page_id)) { pages.remove(d.page_id); pagesRemoved++; }
  const collections = [];
  for (const c of await qdrant.listCollections()) if (c.startsWith(`${RAG.qdrantPrefix}_`)) { await qdrant.dropCollection(c); collections.push(c); }
  await (await mongo.mongo()).dropDatabase();
  fs.rmSync(path.join(paths.rag, 'sources'), { recursive: true, force: true });
  const occ = db().prepare('DELETE FROM entity_occurrence WHERE doc_id IS NOT NULL').run().changes;
  setSetting('rag_ingested', '0');
  audit('rag.wipe', `documents=${docs.length} pages=${pagesRemoved} collections=${collections.join(',')} occurrences=${occ}`);
  return { documents: docs.length, pages_removed: pagesRemoved, collections, occurrences_removed: occ };
}
