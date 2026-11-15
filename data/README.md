# data/

Local, machine-only data. Everything here except this README and `seed.example.json` is git-ignored.

| File | Owner | Purpose |
|---|---|---|
| `seed.json` | You | Project registry + documentation checklist. Loaded only into an empty DB (`npm run db:reset` to reload). |
| `pjm.db` | Backend | SQLite database (created automatically). |
| `inbox/snapshot.json` | Claude | Output of the `pjm-sync` skill. Imported at backend start and via **Import snapshot** on the dashboard. |

Snapshot format: see `docs/ARCHITECTURE.md` and `docs/examples/snapshot.example.json`.
