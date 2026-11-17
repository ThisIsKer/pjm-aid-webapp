import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { markInterruptedJobs } from './agent.ts';
import { exportRegistry } from './registry.ts';
import { seedIfEmpty, syncDocTemplate } from './seed.ts';
import { importSnapshotIfPresent } from './snapshot.ts';
import { apiRouter } from './routes.ts';
import { watchLocalSharePoint } from './localsp.ts';
import { watchTodo } from './todo.ts';

const db = openDb(config.dbFile);
seedIfEmpty(db, config.seedFile);
syncDocTemplate(db, config.seedFile);
markInterruptedJobs(db);

function tryImport() {
  try {
    const result = importSnapshotIfPresent(db, config.snapshotFile);
    if (result.imported) console.log('[sync] Imported snapshot', result.counts, result.warnings?.length ? result.warnings : '');
  } catch (err) {
    console.error('[sync] Snapshot import failed:', (err as Error).message);
  }
  exportRegistry(db);
}
tryImport();

// Auto-import whenever Claude writes a new data/inbox/snapshot.json (debounced: the file may be written in chunks).
let importTimer: NodeJS.Timeout | undefined;
fs.mkdirSync(path.dirname(config.snapshotFile), { recursive: true });
fs.watch(path.dirname(config.snapshotFile), (_event, filename) => {
  if (filename && filename !== path.basename(config.snapshotFile)) return;
  clearTimeout(importTimer);
  importTimer = setTimeout(tryImport, 1500);
});

// SharePoint "Progetti Clienti" synced by OneDrive on this PC: read file names/dates, follow changes.
const sharepoint = watchLocalSharePoint(db, () => exportRegistry(db));
// Microsoft To Do, through the Power Automate flows and the OneDrive folder "PJM aid".
const todo = watchTodo(db, () => undefined);

const app = express();
app.use(express.json({ limit: '5mb' }));
// Keep data/registry.json (read by Claude) in step with every change made through the API.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => res.statusCode < 400 && exportRegistry(db));
  next();
});
app.use('/api', apiRouter(db, sharepoint, todo));

// Production mode: serve the built Angular app from the same port.
if (fs.existsSync(config.frontendDist)) {
  app.use(express.static(config.frontendDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) res.sendFile(path.join(config.frontendDist, 'index.html'));
    else next();
  });
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(err.message.includes('UNIQUE constraint') ? 409 : 500).json({ error: err.message });
});

app.listen(config.port, config.host, () => {
  console.log(`PJM aid API listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
});
