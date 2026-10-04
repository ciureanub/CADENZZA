/**
 * Health checks for the local RAG services. Each check returns { label, ok, detail, warn? }.
 * Used by `cadenzza doctor`; makes no calls beyond the configured loopback endpoints.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { RAG, paths } from '../config.js';
import { registryVersion } from '../entity/guard.js';

const TIMEOUT_MS = 3000;
const GB = 1024 ** 3;

const isLoopback = (addr) => /^127\./.test(addr) || addr === '::1';

/** host of an http(s):// or mongodb:// URL. mongodb+srv is never local. */
function hostOf(url) {
  if (/^mongodb\+srv:/i.test(url)) return null;
  return new URL(url.replace(/^mongodb:/i, 'http:')).hostname.replace(/^\[|\]$/g, '');
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Every configured endpoint must resolve only to loopback addresses. */
export async function checkEndpoints() {
  const out = [];
  for (const [name, url] of [['mongo', RAG.mongoUri], ['qdrant', RAG.qdrantUrl], ['ollama', RAG.ollamaUrl]]) {
    const host = hostOf(url);
    let addrs = [];
    try { addrs = host ? (await dns.lookup(host, { all: true })).map((a) => a.address) : []; } catch { /* unresolvable */ }
    out.push({ label: `${name} endpoint ${host || url} resolves to loopback`, ok: addrs.length > 0 && addrs.every(isLoopback), detail: addrs.join(', ') });
  }
  return out;
}

/** Windows: nothing on the service ports may listen on a non-loopback address. */
export function checkListeners(ports = [27017, 6333, 6334, 11434]) {
  if (process.platform !== 'win32') return [{ label: 'listener bind check', ok: true, detail: 'skipped (non-Windows)' }];
  const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
  const out = [];
  for (const port of ports) {
    const binds = lines
      .map((l) => l.match(new RegExp(`^\\s*TCP\\s+(\\S+):${port}\\s+\\S+\\s+LISTENING\\s+\\d+`)))
      .filter(Boolean).map((m) => m[1].replace(/^\[|\]$/g, ''));
    out.push({ label: `port ${port} bound to loopback only`, ok: binds.length > 0 && binds.every(isLoopback), detail: binds.join(', ') || 'not listening' });
  }
  return out;
}

/** Ollama reachable, and each required model present; reports digests for lineage. */
export async function checkOllama(models) {
  try {
    const { version } = await getJson(`${RAG.ollamaUrl}/api/version`);
    const { models: have } = await getJson(`${RAG.ollamaUrl}/api/tags`);
    const out = [{ label: `ollama ${version} reachable`, ok: true }];
    for (const want of models) {
      const tag = want.includes(':') ? want : `${want}:latest`;
      const m = have.find((x) => x.name === tag);
      out.push({ label: `model ${tag}`, ok: !!m, detail: m ? `digest ${m.digest.slice(0, 12)} ${m.details?.parameter_size || ''}` : 'not pulled' });
    }
    return out;
  } catch (err) {
    return [{ label: 'ollama reachable', ok: false, detail: err.message }];
  }
}

/** Qdrant reachable and healthy; telemetry confirmed off from its own startup log. */
export async function checkQdrant() {
  try {
    const { version } = await getJson(`${RAG.qdrantUrl}/`);
    const { result } = await getJson(`${RAG.qdrantUrl}/collections`);
    const names = result.collections.map((c) => c.name);
    const out = [{ label: `qdrant ${version} reachable`, ok: true, detail: `${names.length} collection(s)${names.length ? ': ' + names.join(', ') : ''}` }];
    const logs = ['qdrant.out.log', 'qdrant.err.log'].map((f) => path.join(paths.rag, 'logs', f)).filter((f) => fs.existsSync(f));
    const off = logs.some((f) => /Telemetry reporting disabled/.test(fs.readFileSync(f, 'utf8')));
    out.push({ label: 'qdrant telemetry disabled', ok: off, detail: off ? 'confirmed in startup log' : 'not confirmed - start via infra/start-rag.ps1' });
    return out;
  } catch (err) {
    return [{ label: 'qdrant reachable', ok: false, detail: err.message }];
  }
}

/** Mongo ping, replica-set primary (needed for transactions), RAG collections and indexes. */
export async function checkMongo() {
  const client = new MongoClient(RAG.mongoUri, { serverSelectionTimeoutMS: TIMEOUT_MS });
  try {
    await client.connect();
    const admin = client.db('admin');
    const { version } = await admin.command({ buildInfo: 1 });
    const hello = await admin.command({ hello: 1 });
    const db = client.db(RAG.mongoDb);
    const colls = await db.listCollections({}, { nameOnly: true }).toArray();
    let indexes = 0;
    for (const c of colls) indexes += (await db.collection(c.name).indexes()).length;
    const regVersion = registryVersion();
    const stale = await db.collection('documents').countDocuments({ $or: [{ registry_version: { $lt: regVersion } }, { registry_version: { $exists: false } }] });
    const failed = await db.collection('ingest_jobs').countDocuments({ status: 'failed' });
    return [
      { label: `mongod ${version} reachable`, ok: true },
      { label: `replica set ${hello.setName || '-'} primary`, ok: !!hello.isWritablePrimary && !!hello.setName },
      { label: `database ${RAG.mongoDb}`, ok: true, detail: `${colls.length} collection(s), ${indexes} index(es)${colls.length ? '' : ' - created at first ingest'}` },
      { label: 'mongo vector search', ok: true, detail: 'n/a (record-only store; Qdrant serves ANN)' },
      { label: 'documents masked with the current registry', ok: true, warn: stale > 0, detail: stale ? `${stale} stale - run: cadenzza rag remask` : 'all current' },
      { label: 'ingest jobs', ok: true, warn: failed > 0, detail: failed ? `${failed} failed - re-run the ingest to resume` : 'none failed' }
    ];
  } catch (err) {
    return [{ label: 'mongod reachable', ok: false, detail: err.message }];
  } finally {
    await client.close().catch(() => {});
  }
}

/** Free space on the CADENZZA_HOME volume. Warns below 5 GB, fails below 1 GB. */
export function checkDisk() {
  const s = fs.statfsSync(paths.home);
  const free = (s.bavail * s.bsize) / GB;
  return [{ label: `disk free under ${paths.home}`, ok: free >= 1, warn: free < 5, detail: `${free.toFixed(1)} GB` }];
}

export async function ragChecks({ models }) {
  return [
    ...(await checkEndpoints()),
    ...checkListeners(),
    ...(await checkOllama(models)),
    ...(await checkQdrant()),
    ...(await checkMongo()),
    ...checkDisk()
  ];
}
