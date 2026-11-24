#!/usr/bin/env node
// Usage: node tools/secretary/backup-file.mjs "<absolute path of the file about to be overwritten>"
// Copies the file to "<same folder>\old\<name>_<YYYY-MM-DD_HHmm>.<ext>" (seconds added on collision).
// Works only inside the personal PJM Management folder. Prints the backup path, or NEW if the file does not exist yet.
// Exit code 0 = safe to overwrite, anything else = do NOT overwrite.

import { copyFileSync, existsSync, mkdirSync, statSync, constants } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const PERSONAL_ROOT = resolve('C:/Users/SebastianoFilippetto/OneDrive - Archiva Group/Documents/PJM Management');

function fail(message) {
  console.error(`backup-file: ${message}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail('missing file path');

const target = resolve(arg);
const lower = (p) => p.toLowerCase();

if (!lower(target).startsWith(lower(PERSONAL_ROOT) + sep)) {
  fail(`refused: ${target} is outside ${PERSONAL_ROOT}`);
}
if (target.split(sep).some((part) => lower(part) === 'old')) {
  fail('refused: files inside an "old" folder are never overwritten or backed up');
}
if (!existsSync(target)) {
  console.log('NEW');
  process.exit(0);
}
if (!statSync(target).isFile()) fail(`not a file: ${target}`);

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;

const ext = extname(target);
const name = basename(target, ext);
const oldDir = join(dirname(target), 'old');
mkdirSync(oldDir, { recursive: true });

let dest = join(oldDir, `${name}_${day}_${time}${ext}`);
if (existsSync(dest)) dest = join(oldDir, `${name}_${day}_${time}${pad(now.getSeconds())}${ext}`);
if (existsSync(dest)) fail(`backup already exists: ${dest}`);

try {
  copyFileSync(target, dest, constants.COPYFILE_EXCL);
} catch (err) {
  fail(`copy failed: ${err.message}`);
}
console.log(dest);
