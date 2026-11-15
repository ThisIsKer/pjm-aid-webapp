import fs from 'node:fs';
import { config } from './config.ts';

// Deletes the local SQLite database; the next start re-seeds from data/seed.json.
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbFile + suffix, { force: true });
console.log(`Removed ${config.dbFile}. Restart the backend to re-seed from ${config.seedFile}.`);
