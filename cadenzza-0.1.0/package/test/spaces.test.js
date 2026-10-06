/** One space: Deployment, Environment and Stakeholder merged into Release (migrations v3, v4), aliases, tags, page moves. */
import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, close } from '../src/db/index.js';
import * as pages from '../src/pages.js';
import { seedTemplates } from '../src/seed/templates.js';
import { buildServer } from '../src/server/index.js';
import { strict } from '../src/search/index.js';

const keys = () => pages.spaces().map((s) => [s.key, s.position]);
const byTitle = (title) => pages.get(db().prepare('SELECT id FROM page WHERE title = ?').get(title).id);

test('fresh database has one space; templates keep their area as a tag and their sensitivity', () => {
  seedTemplates(pages);
  assert.deepEqual(keys(), [['release', 1]]);
  assert.deepEqual(byTitle('Release Plan — <release name>').tags, []);
  assert.deepEqual(byTitle('Deployment Runbook').tags, ['deployment']);
  assert.deepEqual(byTitle('Environment Inventory Matrix').tags, ['environment']);
  const reg = byTitle('Stakeholder Register');
  assert.deepEqual(reg.tags, ['stakeholder']);
  assert.equal(reg.sensitivity, 'Client-Confidential');
  assert.equal(seedTemplates(pages), 0, 'seeding twice creates nothing');
});

test('migrations v3 + v4 fold a 0.1 four-space database into Release without losing anything', () => {
  // Recreate the 0.1 layout: four spaces, pages (one with a sub-page and a revision) in each, v3/v4 not applied.
  const d = db();
  const ids = {};
  for (const [key, name, pos] of [['deployment', 'Deployment Management', 2], ['environment', 'Environment Management', 3], ['stakeholder', 'Stakeholder Management', 4]]) {
    ids[key] = d.prepare('INSERT INTO space (key, name, glyph, position) VALUES (?, ?, ?, ?)').run(key, name, 'XX', pos).lastInsertRowid;
  }
  const mk = (space, title, extra = {}) => {
    const p = pages.create({ space_key: 'release', title, body_html: `<p>${title} body</p>`, ...extra });
    d.prepare('UPDATE page SET space_id = ? WHERE id = ?').run(ids[space], p.id);
    return p;
  };
  const env = mk('environment', 'Quokka inventory', { sensitivity: 'Restricted' });
  const envSub = mk('environment', 'Quokka inventory detail', { parent_id: env.id });
  pages.update(env.id, { body_html: '<p>edited</p>' });
  const stk = mk('stakeholder', 'Sponsor map', { sensitivity: 'Client-Confidential' });
  const dep = mk('deployment', 'Hotfix notes');
  d.prepare('DELETE FROM schema_migration WHERE version IN (3, 4)').run();
  const before = d.prepare('SELECT COUNT(*) c FROM page').get().c;
  close();

  assert.deepEqual(keys(), [['release', 1]], 'reopen runs v3 and v4');
  assert.equal(db().prepare('SELECT COUNT(*) c FROM page').get().c, before, 'no page lost');
  for (const p of [env, envSub, stk, dep]) assert.equal(pages.get(p.id).space_key, 'release');
  assert.equal(pages.get(envSub.id).parent_id, env.id, 'hierarchy kept');
  assert.equal(pages.get(env.id).sensitivity, 'Restricted');
  assert.equal(pages.get(env.id).body_html, '<p>edited</p>');
  assert.equal(pages.revisions(env.id).length, 1, 'revision history kept');
  assert.deepEqual(pages.get(env.id).tags, ['environment']);
  assert.deepEqual(pages.get(envSub.id).tags, ['environment']);
  assert.deepEqual(pages.get(stk.id).tags, ['stakeholder']);
  assert.deepEqual(pages.get(dep.id).tags, ['deployment']);
  assert.deepEqual(strict('quokka tag:environment').map((r) => r.title).sort(), ['Quokka inventory', 'Quokka inventory detail']);
});

test('retired keys deployment / environment / stakeholder are aliases of release', () => {
  for (const k of ['deployment', 'environment', 'stakeholder']) {
    const p = pages.create({ space_key: k, title: `Created via ${k}` });
    assert.equal(pages.get(p.id).space_key, 'release');
    assert.ok(pages.tree(k).some((r) => r.id === p.id));
  }
});

test('PATCH space still moves a page and its sub-pages when another space exists; unknown space is a 400', async () => {
  db().prepare("INSERT INTO space (key, name, glyph, position) VALUES ('archive', 'Archive', 'AR', 2)").run();
  const app = await buildServer();
  try {
    const top = pages.create({ space_key: 'release', title: 'Move me' });
    const sub = pages.create({ space_key: 'release', title: 'Move me too', parent_id: top.id });
    let r = await app.inject({ method: 'PATCH', url: `/api/page/${top.id}`, payload: { space: 'archive', title: 'Moved' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().space_key, 'archive');
    assert.equal(pages.get(sub.id).space_key, 'archive');

    r = await app.inject({ method: 'PATCH', url: `/api/page/${top.id}`, payload: { space: 'nowhere', title: 'Should not save' } });
    assert.equal(r.statusCode, 400);
    assert.equal(pages.get(top.id).title, 'Moved');
  } finally { await app.close(); }
});
