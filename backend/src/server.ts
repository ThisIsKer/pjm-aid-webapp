import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { importSnapshotIfPresent } from './snapshot.ts';
import { apiRouter } from './routes.ts';

const db = openDb(config.dbFile);
seedIfEmpty(db, config.seedFile);

try {
  const result = importSnapshotIfPresent(db, config.snapshotFile);
  if (result.imported) console.log('[sync] Imported snapshot', result.counts, result.warnings?.length ? result.warnings : '');
} catch (err) {
  console.error('[sync] Snapshot import failed:', (err as Error).message);
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api', apiRouter(db));

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
