import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from '../config.js';
import { db, audit } from '../db/index.js';

/**
 * Vault key resolution:
 *   1. CADENZZA_PASSPHRASE  -> scrypt-derived key (nothing on disk)
 *   2. ~/.cadenzza/vault.key -> 32 random bytes, mode 0600, generated on first use
 * The key never enters the database and is excluded from the npm tarball.
 */
let _key = null;

export function key() {
  if (_key) return _key;
  const pass = process.env.CADENZZA_PASSPHRASE;
  if (pass) {
    _key = crypto.scryptSync(pass, 'cadenzza.vault.v1', 32);
    return _key;
  }
  if (fs.existsSync(paths.vaultKey)) {
    _key = Buffer.from(fs.readFileSync(paths.vaultKey, 'utf8').trim(), 'hex');
  } else {
    _key = crypto.randomBytes(32);
    fs.writeFileSync(paths.vaultKey, _key.toString('hex'), { mode: 0o600 });
    audit('vault.key.created', paths.vaultKey);
  }
  return _key;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ciphertext: ct.toString('hex') };
}

export function decrypt({ iv, tag, ciphertext }) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'hex')), d.final()]).toString('utf8');
}

export function store(entityId, canonical) {
  const { iv, tag, ciphertext } = encrypt(canonical);
  db().prepare(
    `INSERT INTO vault_entry (entity_id, iv, tag, ciphertext) VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, ciphertext=excluded.ciphertext`
  ).run(entityId, iv, tag, ciphertext);
}

export function reveal(entityId, reason = 'unspecified') {
  const row = db().prepare('SELECT iv, tag, ciphertext FROM vault_entry WHERE entity_id = ?').get(entityId);
  if (!row) return null;
  audit('vault.reveal', `entity=${entityId} reason=${reason}`);
  return decrypt(row);
}
