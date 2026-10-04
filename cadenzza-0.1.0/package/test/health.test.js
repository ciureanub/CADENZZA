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
