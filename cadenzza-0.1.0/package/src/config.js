import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Resolve the data directory. CADENZZA_HOME wins, else ~/.cadenzza */
export function home() {
  const dir = process.env.CADENZZA_HOME || path.join(os.homedir(), '.cadenzza');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  get home() { return home(); },
  get db() { return path.join(home(), 'cadenzza.db'); },
  get vaultKey() { return path.join(home(), 'vault.key'); },
  get assets() {
    const d = path.join(home(), 'assets');
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  get exports() {
    const d = path.join(home(), 'exports');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
};

export const SENSITIVITY = ['Public', 'Internal', 'Client-Confidential', 'Restricted'];

export const SPACES = [
  { key: 'release',     name: 'Release Management',     glyph: 'RM', position: 1 },
  { key: 'deployment',  name: 'Deployment Management',  glyph: 'DM', position: 2 },
  { key: 'environment', name: 'Environment Management', glyph: 'EM', position: 3 },
  { key: 'stakeholder', name: 'Stakeholder Management', glyph: 'SM', position: 4 }
];

/** Storage mode. store-and-mask is the default; see README. */
export const DEFAULT_SETTINGS = {
  storage_mode: 'store-and-mask',
  pseudonym_style: 'coded',
  chat_mode: 'private',
  offline: '1'
};
