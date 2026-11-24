# Notes for Claude

- Monorepo with npm workspaces: `backend/` (Node ≥ 24 running .ts directly, Express 5, `node:sqlite`) and `frontend/` (Angular 22, standalone, signals, `httpResource`).
- Backend TS must stay *erasable* (no enums, no parameter properties, no namespaces) and use `.ts` import extensions — it runs without a build step. Check with `npm run typecheck`.
- DB schema lives in `backend/src/db.ts` as append-only migrations (`PRAGMA user_version`). Never edit a shipped migration.
- Field ownership (user vs Claude snapshot) is defined in `docs/ARCHITECTURE.md` §3 — imports must never overwrite user-owned fields.
- `data/` holds real client data and is git-ignored except README / seed.example.json. Never commit real names, mails or links.
- The user runs everything on Windows (PowerShell). Don't commit `node_modules` or anything built on Linux.
- `tools/build-snapshot.ts` (run by the pjm-sync skill in the Claude workspace with plain Node) imports `backend/src/flags.ts`: keep flags.ts dependency-free. Typecheck with `npm run typecheck` (covers backend + tools).
- The pjm-sync skill lives in `.claude/skills/pjm-sync/SKILL.md` (project skill, dual-mode: local Claude Code and Cowork); keep it in sync with the snapshot contract. Sync-now permissions: `.claude/settings.json`.
- `backend/src/mcp.ts` is a stdio MCP server that calls the REST API; never write to the DB from it directly.
- The pjm-secretary skill lives in `.claude/skills/pjm-secretary/`; its ledger `data/ledger/` is written only by `tools/secretary/ledger.mjs` (`apply` with a delta file). The backend (`backend/src/secretary.ts`) reads the ledger files and changes them only through `ledger.mjs apply` — never write ledger JSON directly. Keep `secretary.ts` in step with `references/ledger.schema.json` and `references/delta.md`.
