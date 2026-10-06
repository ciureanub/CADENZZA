import './_env.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpoints } from '../src/rag/health.js';

const KEYS = ['CADENZZA_MONGO_URI', 'CADENZZA_QDRANT_URL', 'CADENZZA_OLLAMA_URL'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

const byName = async () => Object.fromEntries((await checkEndpoints()).map((c) => [c.label.split(' ')[0], c]));

test('default endpoints are all loopback', async () => {
  for (const c of Object.values(await byName())) assert.equal(c.ok, true, c.label);
});

test('localhost and [::1] count as loopback', async () => {
  process.env.CADENZZA_QDRANT_URL = 'http://localhost:6333';
  process.env.CADENZZA_OLLAMA_URL = 'http://[::1]:11434';
  const r = await byName();
  assert.equal(r.qdrant.ok, true, r.qdrant.detail);
  assert.equal(r.ollama.ok, true, r.ollama.detail);
});

test('a LAN address or Atlas SRV URI fails the check', async () => {
  process.env.CADENZZA_QDRANT_URL = 'http://10.1.2.3:6333';
  process.env.CADENZZA_MONGO_URI = 'mongodb+srv://cluster0.example.mongodb.net/';
  process.env.CADENZZA_OLLAMA_URL = 'http://0.0.0.0:11434';
  const r = await byName();
  assert.equal(r.qdrant.ok, false);
  assert.equal(r.mongo.ok, false);
  assert.equal(r.ollama.ok, false);
});

/* UI port check (doctor / serve EADDRINUSE). */
import http from 'node:http';
import { checkServerPort } from '../src/rag/health.js';
import { buildServer } from '../src/server/index.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('UI port check: free port passes', async () => {
  const srv = http.createServer(); const port = await listen(srv); await new Promise((r) => srv.close(r));
  const c = await checkServerPort(port);
  assert.equal(c.ok, true); assert.match(c.label, /free/);
});

test('UI port check: another program on the port fails and names it', async () => {
  const srv = http.createServer((q, r) => r.end('not cadenzza')); const port = await listen(srv);
  try {
    const c = await checkServerPort(port);
    assert.equal(c.ok, false); assert.match(c.label, /another program/);
    if (process.platform === 'win32') assert.ok(c.detail.startsWith(`pid ${process.pid} `), c.detail);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('UI port check: a running CADENZZA is recognised (warn, not fail)', async () => {
  const app = await buildServer(); await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const c = await checkServerPort(app.server.address().port);
    assert.equal(c.ok, true); assert.equal(c.warn, true); assert.match(c.label, /already running/);
  } finally { await app.close(); }
});
