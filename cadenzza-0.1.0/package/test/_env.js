/**
 * Import first in every test file. Points CADENZZA_HOME at a throwaway directory
 * so tests never open the live database or vault key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { close } from '../src/db/index.js'; // safe: paths resolve lazily, after the env is set below

export const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cadenzza-test-'));
process.env.CADENZZA_HOME = HOME;
delete process.env.CADENZZA_PASSPHRASE;

process.on('exit', () => {
  close(); // Windows will not delete a directory while SQLite holds the file
  fs.rmSync(HOME, { recursive: true, force: true });
});
