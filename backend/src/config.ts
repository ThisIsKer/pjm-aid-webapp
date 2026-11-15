import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const dataDir = process.env['PJM_DATA_DIR'] ?? path.join(root, 'data');

export const config = {
  // Bound to localhost only: the app is never reachable from the network.
  host: '127.0.0.1',
  port: Number(process.env['PJM_PORT'] ?? 4310),
  root,
  dataDir,
  dbFile: path.join(dataDir, 'pjm.db'),
  seedFile: path.join(dataDir, 'seed.json'),
  snapshotFile: path.join(dataDir, 'inbox', 'snapshot.json'),
  /** Read by the Claude pjm-sync skill: projects, doc checklist and open mail threads. */
  registryFile: path.join(dataDir, 'registry.json'),
  frontendDist: path.join(root, 'frontend', 'dist', 'frontend', 'browser'),
};
