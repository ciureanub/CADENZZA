import { HOME } from './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as guard from '../src/entity/guard.js';
import { db } from '../src/db/index.js';
import { paths } from '../src/config.js';

test('runs against a throwaway CADENZZA_HOME', () => {
  assert.equal(paths.home, HOME);
  assert.equal(path.dirname(paths.db), HOME);
});

/* ---------------- normalise / variants (pure) ---------------- */

test('normalise collapses punctuation, spacing, case and diacritics', () => {
  for (const s of ['E.ON', 'E-ON', 'e on', 'EON', 'e.on', 'E_ON']) assert.equal(guard.normalise(s), 'eon');
  assert.equal(guard.normalise('Müller-Lüdenscheidt'), 'mullerludenscheidt');
  assert.equal(guard.normalise('Ștefănescu'), 'stefanescu');
});

test('variants cover the E.ON family and strip legal suffixes', () => {
  const v = guard.variants('E.ON SE', ['eon.com']);
  for (const want of ['E.ON SE', 'E.ON', 'EON', 'E ON', 'E-ON', 'eon.com', 'eoncom', 'eon com', 'eon-com']) {
    assert.ok(v.includes(want), `missing variant ${want}: ${JSON.stringify(v)}`);
  }
});

test('variants drop forms that normalise to fewer than 2 chars', () => {
  assert.deepEqual(guard.variants('A.'), []);
});

/* ---------------- registry + mask (DB-backed, synthetic names) ---------------- */

const contoso   = guard.addEntity({ canonical: 'Contoso SE', type: 'org', aliases: ['contoso.com'] });
const northwind = guard.addEntity({ canonical: 'Northwind Traders', type: 'org' });

test('pseudonyms are allocated per type in order', () => {
  assert.equal(contoso.pseudonym, 'CLIENT_A');
  assert.equal(northwind.pseudonym, 'CLIENT_B');
  assert.equal(guard.addEntity({ canonical: 'contoso se' }).id, contoso.id, 'same norm returns existing');
});

test('mask replaces every surface form with the pseudonym', () => {
  assert.equal(
    guard.mask('Contoso, CONTOSO, Contoso SE and Northwind Traders met at contoso.com'),
    'CLIENT_A, CLIENT_A, CLIENT_A and CLIENT_B met at CLIENT_A'
  );
});

test('mask respects word boundaries', () => {
  assert.equal(guard.mask('Contosoville is not a client'), 'Contosoville is not a client');
});

test('mask handles emails before the gazetteer so the local part does not leak', () => {
  const out = guard.mask('Ask jane.doe@contoso.com about Contoso');
  assert.equal(out, 'Ask [PERSON_EMAIL] about CLIENT_A');
  assert.ok(!/jane/i.test(out));
});

test('mask auto-masks hosts and IPs', () => {
  assert.equal(guard.mask('ssh build01.corp at 10.20.30.40'), 'ssh [HOST_INTERNAL_HOST] at [HOST_IPV4]');
});

test('maskDeep masks nested strings and leaves other types alone', () => {
  assert.deepEqual(
    guard.maskDeep({ a: 'Contoso', b: ['Northwind Traders', 3], c: null, d: true }),
    { a: 'CLIENT_A', b: ['CLIENT_B', 3], c: null, d: true }
  );
});

test('assertClean throws on any surviving variant and audits it', () => {
  assert.throws(() => guard.assertClean('summary for CONTOSO', 'test'), /CLIENT_A/);
  assert.throws(() => guard.assertClean({ nested: ['see contoso.com'] }, 'test'), /leaked at test/);
  const row = db().prepare("SELECT detail FROM audit_event WHERE action='egress.blocked' ORDER BY id DESC").get();
  assert.match(row.detail, /^test: CLIENT_A$/);
});

test('assertClean passes masked text', () => {
  assert.equal(guard.assertClean(guard.mask('Contoso and Northwind Traders')), true);
});

test('unmask round-trips through the vault and audits each reveal', () => {
  const before = db().prepare("SELECT COUNT(*) c FROM audit_event WHERE action='vault.reveal'").get().c;
  assert.equal(guard.unmask('CLIENT_A and CLIENT_B', 'test'), 'Contoso SE and Northwind Traders');
  const after = db().prepare("SELECT COUNT(*) c FROM audit_event WHERE action='vault.reveal'").get().c;
  assert.equal(after - before, 2);
});

test('scanText reports gazetteer hits and pattern candidates', () => {
  const hits = guard.scanText('Contoso raised OPS-123 with Fabrikam AG');
  assert.deepEqual(hits.map((h) => [h.layer, h.rule || h.pseudonym, h.surface]), [
    ['gazetteer', 'CLIENT_A', 'Contoso'],
    ['pattern', 'jira-key', 'OPS-123'],
    ['pattern', 'legal-entity', 'Fabrikam AG']
  ]);
});

/* ---------------- known defects (see docs/ASSESSMENT.md) ---------------- */

test('N1: ordinary 15-letter words are not masked as Salesforce IDs', () => {
  assert.equal(guard.mask('Track accomplishments and administrations'), 'Track accomplishments and administrations');
});

test('N1b: 15- and 18-char Salesforce IDs are masked, incl. digits in the checksum', () => {
  assert.equal(
    guard.mask('Account 001AB000003DtGXYA0, 0035g00000XyZ12 and /lightning/r/a0B5g00000AbCdEFGH/view'),
    'Account [REF_SALESFORCE_ID], [REF_SALESFORCE_ID] and /lightning/r/[REF_SALESFORCE_ID]/view'
  );
});

test('N2: encoding/standard tokens are not raised as Jira keys', () => {
  const rules = guard.scanText('Use UTF-8 and SHA-256 per ISO-27001').map((h) => h.rule);
  assert.ok(!rules.includes('jira-key'), JSON.stringify(rules));
});
