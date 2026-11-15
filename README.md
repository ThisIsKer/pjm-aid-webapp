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

- Projects are created from your **Jira epics** by Claude's `pjm-sync` skill — ask Claude "sync PJM" (Jira + mail) or "sync PJM docs" (+ SharePoint/Confluence checks). On the Projects page you can merge epics, put projects into your own groups, or hide them. Language and light/dark theme are in Settings (gear icon).
- `data/seed.json` — documentation checklist template (re-read at every start) and any non-Jira projects (git-ignored).
- `data/registry.json` — written by the app for Claude (projects, checklist, open mails, last sync).
- `data/inbox/snapshot.json` — written by `pjm-sync`; the backend imports it automatically within a few seconds.
- `data/pjm.db` — local SQLite database.

To try the UI with demo data, use `data/seed.example.json` as `data/seed.json` and copy
`docs/examples/snapshot.example.json` to `data/inbox/snapshot.json`.

## Claude integration

- **Sync now** (dashboard): runs the `pjm-sync` skill through Claude Code in this folder (needs Claude Code installed
  and signed in with your claude.ai account). Choose *Jira + mail*, *Jira + mail + docs* or *Jira only*; progress and
  Claude's summary appear under the button. Allowed tools: `.claude/settings.json`.
- **From any Claude chat**: "sync PJM" / "sync PJM docs" in Cowork, or `claude` in this folder.
- **MCP server** — lets Claude read and update the board ("what's late on IMA?", "mark the Dorigo mail as done").
  The backend must be running.
  - Claude Code: `claude mcp add pjm-aid --scope user -- node C:\Users\SebastianoFilippetto\Documents\pjm-aid-webapp\backend\src\mcp.ts`
  - Claude desktop app (also used by Cowork sessions linked to this PC): Settings → Developer → Edit config, add
    ```json
    "mcpServers": { "pjm-aid": { "command": "node", "args": ["C:\\Users\\SebastianoFilippetto\\Documents\\pjm-aid-webapp\\backend\\src\\mcp.ts"] } }
    ```
    and restart the app.
- Sources: `.claude/skills/pjm-sync/SKILL.md` (skill), `tools/build-snapshot.ts` (snapshot builder), `backend/src/agent.ts` (Sync now), `backend/src/mcp.ts` (MCP).
