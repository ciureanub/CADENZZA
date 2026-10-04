#!/usr/bin/env node
/**
 * Admin helper for the local mongod, used by the infra/*.ps1 scripts.
 *   node infra/mongo-admin.mjs ping       version + replica-set state
 *   node infra/mongo-admin.mjs init-rs    initiate the single-node replica set (idempotent)
 *   node infra/mongo-admin.mjs shutdown   clean shutdown
 * Connects directly (no replica-set discovery) so it works before the set exists.
 */
import { MongoClient } from 'mongodb';

const URI = 'mongodb://127.0.0.1:27017/?directConnection=true';
const RS = { _id: 'cadenzza', members: [{ _id: 0, host: '127.0.0.1:27017' }] };

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 3000 });
const admin = () => client.db('admin');

async function rsState() {
  try {
    const s = await admin().command({ replSetGetStatus: 1 });
    return s.members.find((m) => m.self)?.stateStr || 'UNKNOWN';
  } catch (err) {
    if (err.codeName === 'NotYetInitialized') return 'NOT_INITIALIZED';
    throw err;
  }
}

const commands = {
  async ping() {
    await admin().command({ ping: 1 });
    const { version } = await admin().command({ buildInfo: 1 });
    console.log(`ok mongod ${version} replset=${await rsState()}`);
  },

  async 'init-rs'() {
    if ((await rsState()) === 'NOT_INITIALIZED') {
      await admin().command({ replSetInitiate: RS });
      console.log('replica set "cadenzza" initiated');
    }
    for (let i = 0; i < 30; i++) {
      const state = await rsState();
      if (state === 'PRIMARY') return console.log('replset=PRIMARY');
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('replica set did not reach PRIMARY within 15 s');
  },

  async shutdown() {
    try {
      await admin().command({ shutdown: 1 });
    } catch (err) {
      // The server closes the socket while acknowledging; that is success.
      if (!/closed|ECONNRESET|interrupted/i.test(`${err.name} ${err.message}`)) throw err;
    }
    console.log('mongod shutdown requested');
  }
};

const cmd = commands[process.argv[2]];
if (!cmd) {
  console.error('usage: mongo-admin.mjs ping|init-rs|shutdown');
  process.exit(2);
}
try {
  await cmd();
} catch (err) {
  console.error(`FAIL ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
