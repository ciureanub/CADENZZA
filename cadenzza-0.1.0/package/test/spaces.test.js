/** Deployment merged into Release (migration v3), the retired-key alias, and moving pages between spaces. */
import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, close } from '../src/db/index.js';
import * as pages from '../src/pages.js';
import { seedTemplates } from '../src/seed/templates.js';
import { buildServer } from '../src/server/index.js';

const keys = () => pages.spaces().map((s) => [s.key, s.position]);

test('fresh database has three spaces, Deployment templates seeded into Release', () => {
  seedTemplates(pages);
  assert.deepEqual(keys(), [['release', 1], ['environment', 2], ['stakeholder', 3]]);
  const titles = pages.tree('release').map((p) => p.title);
  for (const t of ['Release Plan — <release name>', 'Deployment Runbook', 'Delta Package Manifest']) assert.ok(titles.includes(t), t);
});

test('migration v3 moves a 0.1 Deployment space (with sub-pages) into Release and removes it', () => {
  // Recreate the 0.1 layout: four spaces, pages in Deployment, migration 3 not applied.
  const d = db();
  d.prepare('UPDATE space SET position = position + 1 WHERE position >= 2').run();
  const depId = d.prepare("INSERT INTO space (key, name, glyph, position) VALUES ('deployment', 'Deployment Management', 'DM', 2)").run().lastInsertRowid;
  const parent = pages.create({ space_key: 'environment', title: 'Old runbook' });
  const child = pages.create({ space_key: 'environment', title: 'Old runbook step', parent_id: parent.id });
  d.prepare('UPDATE page SET space_id = ? WHERE id IN (?, ?)').run(depId, parent.id, child.id);
  d.prepare('DELETE FROM schema_migration WHERE version = 3').run();
  const releaseBefore = pages.tree('release').length;
  close();

  assert.deepEqual(keys(), [['release', 1], ['environment', 2], ['stakeholder', 3]], 'reopen runs v3');
  assert.equal(pages.tree('release').length, releaseBefore + 2);
  assert.equal(pages.get(parent.id).space_key, 'release');
  assert.equal(pages.get(child.id).space_key, 'release');
  assert.equal(pages.get(child.id).parent_id, parent.id, 'hierarchy kept');
  assert.equal(db().prepare("SELECT COUNT(*) c FROM space WHERE key = 'deployment'").get().c, 0);
});

test('"deployment" is accepted as an alias of release on input', () => {
  const p = pages.create({ space_key: 'deployment', title: 'Created via old key' });
  assert.equal(pages.get(p.id).space_key, 'release');
  assert.ok(pages.tree('deployment').some((r) => r.id === p.id));
});

test('PATCH space moves a page and its sub-pages; unknown space is a 400 and changes nothing', async () => {
  const app = await buildServer();
  try {
    const top = pages.create({ space_key: 'release', title: 'Move me' });
    const sub = pages.create({ space_key: 'release', title: 'Move me too', parent_id: top.id });
    let r = await app.inject({ method: 'PATCH', url: `/api/page/${top.id}`, payload: { space: 'environment', title: 'Moved' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().space_key, 'environment');
    assert.equal(pages.get(sub.id).space_key, 'environment');

    r = await app.inject({ method: 'PATCH', url: `/api/page/${top.id}`, payload: { space: 'nowhere', title: 'Should not save' } });
    assert.equal(r.statusCode, 400);
    assert.equal(pages.get(top.id).title, 'Moved');
  } finally { await app.close(); }
});
