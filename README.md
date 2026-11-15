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

- Projects are created from your **Jira epics** by Claude's `pjm-sync` skill — ask Claude "sync PJM" (Jira + mail) or "sync PJM docs" (+ SharePoint/Confluence checks). Group or hide projects on the Projects page.
- `data/seed.json` — documentation checklist template (re-read at every start) and any non-Jira projects (git-ignored).
- `data/registry.json` — written by the app for Claude (projects, checklist, open mails, last sync).
- `data/inbox/snapshot.json` — written by `pjm-sync`; the backend imports it automatically within a few seconds.
- `data/pjm.db` — local SQLite database.

To try the UI with demo data, use `data/seed.example.json` as `data/seed.json` and copy
`docs/examples/snapshot.example.json` to `data/inbox/snapshot.json`.

## Claude integration

- `claude/skills/pjm-sync/SKILL.md` — the sync skill (source of truth; saved to Claude as a personal skill).
- `tools/build-snapshot.ts` — turns raw Jira results into the snapshot; run by Claude, not by you.
