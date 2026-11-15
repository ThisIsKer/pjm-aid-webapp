# PJM aid

Local project-management aid: project status (RAG), deadlines, mails to answer and documentation gaps — fed by Claude.
Architecture and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

Node.js ≥ 24 (developed on 26), npm ≥ 10. Nothing else — SQLite is built into Node.

## Run

```powershell
npm install          # once, and after pulling dependency changes
npm run dev          # backend on :4310 + Angular on :4200 (opens the browser)
```

Production-style (single port):

```powershell
npm run build
npm start            # http://localhost:4310
```

## Your data

- `data/seed.json` — your project registry and documentation checklist (git-ignored). Edit it, then `npm run db:reset` and restart.
- `data/inbox/snapshot.json` — written by Claude's `pjm-sync`; imported at start-up or with **Import snapshot** on the dashboard.
- `data/pjm.db` — local SQLite database.

To try the UI with demo data: copy `docs/examples/snapshot.example.json` to `data/inbox/snapshot.json`
and use `data/seed.example.json` as `data/seed.json` (ids must match).
