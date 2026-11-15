# Notes for Claude

- Monorepo with npm workspaces: `backend/` (Node ≥ 24 running .ts directly, Express 5, `node:sqlite`) and `frontend/` (Angular 22, standalone, signals, `httpResource`).
- Backend TS must stay *erasable* (no enums, no parameter properties, no namespaces) and use `.ts` import extensions — it runs without a build step. Check with `npm run typecheck`.
- DB schema lives in `backend/src/db.ts` as append-only migrations (`PRAGMA user_version`). Never edit a shipped migration.
- Field ownership (user vs Claude snapshot) is defined in `docs/ARCHITECTURE.md` §3 — imports must never overwrite user-owned fields.
- `data/` holds real client data and is git-ignored except README / seed.example.json. Never commit real names, mails or links.
- The user runs everything on Windows (PowerShell). Don't commit `node_modules` or anything built on Linux.
