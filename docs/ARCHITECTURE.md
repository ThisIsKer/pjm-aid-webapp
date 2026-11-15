# PJM aid — Architecture

Personal project-management aid for Sebastiano (DDM). Runs locally on the Windows laptop, never exposed to the network.
It answers four questions: **how are my projects doing, what is due, which mails do I owe a reply, which projects are missing documentation.**

## 1. Big picture

```
 ┌───────────────────────────── Claude (Cowork) ─────────────────────────────┐
 │  pjm-sync skill  (on demand / scheduled task every weekday morning)        │
 │   • Jira (Atlassian connector)       → epics, phases, due dates, estimates │
 │   • Outlook (Microsoft 365 connector)→ threads: needs reply / waiting / fyi│
 │   • SharePoint/Teams (M365)          → project documentation check         │
 │   • Confluence (Atlassian)           → product documentation check         │
 │   writes ──► data/inbox/snapshot.json                                      │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
 ┌──────────────── Local machine (127.0.0.1) ────────────────┐
 │ backend/  Node 24+ · TypeScript (native type stripping)    │
 │   Express 5 REST API  :4310                                │
 │   SQLite via built-in node:sqlite  → data/pjm.db           │
 │   imports snapshot on start + "Import snapshot" button     │
 │   (phase 4) MCP endpoint so Claude can read/write the DB   │
 │                                                            │
 │ frontend/ Angular 22 · standalone · signals · httpResource │
 │   dev: ng serve :4200 (proxy /api → :4310)                 │
 │   prod: built bundle served by the backend on :4310        │
 └────────────────────────────────────────────────────────────┘
```

**Why this split.** Claude already has authenticated access to Jira, Outlook, SharePoint and Confluence through the
Cowork connectors. Letting Claude do the collection and judgement work ("does this thread need *my* reply?",
"is this spec the current one?") avoids an Entra ID app registration for Microsoft Graph, avoids storing tokens
locally, and gives better triage than fixed rules. The app stays simple: a registry you own plus a viewer of
what Claude found.

## 2. Tech choices

| Area | Choice | Reason |
|---|---|---|
| Frontend | Angular 22, standalone components, signals, `httpResource`, lazy routes | Modern Angular defaults; no NgModules |
| UI | Plain SCSS design tokens (no component library yet) | Keep the skeleton light; PrimeNG can be added when we need Gantt/timeline |
| Backend | Node ≥ 24 running `.ts` directly (type stripping), Express 5 | No build step for the backend; same language as the frontend |
| DB | SQLite through built-in `node:sqlite` | Zero native dependencies → no Visual Studio Build Tools on Windows |
| Repo | npm workspaces (`backend`, `frontend`) + `concurrently` | One `npm install`, one `npm run dev` |
| Security | Listens on 127.0.0.1 only; real data in git-ignored `data/` | Client names, mails and links never reach GitHub |

## 3. Data ownership

Every field has exactly one owner, so a Claude sync never overwrites a decision you made.

| Entity | You own | Claude owns (via snapshot) |
|---|---|---|
| Project | name, client, phase, **status (RAG)**, PM note, Jira keys, SharePoint URL, Confluence space, mail keywords/domains, active | `suggestedStatus`, `suggestedReason` |
| Deadline | manual deadlines | Jira-sourced deadlines (title, dates, assignee, remaining h, state) |
| Mail thread | `userState` (open/done/snoozed), `snoozedUntil`, project re-assignment | subject, counterpart, category, urgency, summary, link, last message |
| Doc requirement | the checklist itself (title, phase, repository, location hint), `waived` | `checkStatus`, `foundUrl`, `checkedAt` |

Rules applied on import:

- A newer message on a thread you closed or snoozed **re-opens** it.
- With `"complete": true`, Jira deadlines and mail threads missing from the snapshot are closed.
- Unknown project / requirement ids are skipped and reported as warnings (visible in `sync_runs`).
- An identical snapshot (same SHA-256) is not imported twice.

## 4. Database schema (v1)

`projects` · `deadlines` · `mail_threads` · `doc_requirements` · `sync_runs` — see `backend/src/db.ts`.
Migrations are append-only and tracked with `PRAGMA user_version`.

Doc requirements come from `data/seed.json`: a shared `docTemplate` (default checklist applied to every project)
that a project can override with its own `docs` array. Requirement id = `<projectId>--<slug(title)>`,
which is the id Claude reports back in `docChecks`.

## 5. Snapshot contract v1 (`data/inbox/snapshot.json`)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-15T07:30:00+01:00",
  "complete": true,                       // full picture → absent items get closed
  "projects":    [{ "id", "suggestedStatus": "green|amber|red|grey", "suggestedReason" }],
  "deadlines":   [{ "id", "projectId", "title", "startDate?", "dueDate", "source": "jira",
                    "sourceRef": "DDMD-123", "assignee?", "remainingHours?", "state": "open|done" }],
  "mailThreads": [{ "id": "<Outlook conversationId>", "projectId|null", "subject", "counterpart",
                    "lastMessageAt", "lastFromMe", "category": "needs_reply|waiting|fyi",
                    "urgency": "high|normal|low", "summary", "webLink" }],
  "docChecks":   [{ "requirementId", "status": "missing|present|outdated|unknown", "foundUrl?", "checkedAt?" }]
}
```

Full example: `docs/examples/snapshot.example.json`.

## 6. REST API (`/api`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + last sync |
| GET | `/dashboard?days=14` | KPIs, project summaries, overdue + upcoming deadlines |
| GET/POST | `/projects` | list (`?all=true` includes inactive) / create |
| GET/PATCH | `/projects/:id` | detail with deadlines, mails, docs / update owned fields |
| POST | `/projects/:id/deadlines` | add a manual deadline |
| PATCH | `/deadlines/:id` | edit title / dueDate / state |
| GET | `/mail?category=needs_reply&state=all` | triage list (snoozed items return when due) |
| PATCH | `/mail/:id` | done / snooze / re-assign project |
| GET | `/docs?gaps=false` | documentation gaps (default) or full checklist |
| POST | `/projects/:id/docs` | add a requirement |
| PATCH | `/docs/:id` | waive ("not needed") / edit hint |
| POST | `/sync/import?force=true` | import the snapshot now |
| GET | `/sync/runs` | last 20 imports with counts and warnings |

## 7. Claude integration roadmap

1. **`pjm-sync` skill (Cowork)** — reads `data/seed.json` for the project registry (Jira keys, mail keywords/domains,
   doc locations), queries the connectors, writes `snapshot.json` through the linked computer. Triggered on demand
   ("sync my PJM board") and by a weekday-morning scheduled task.
2. **MCP server in the backend** — tools such as `list_projects`, `get_project`, `add_deadline`, `set_status`,
   `mark_mail_done`, registered in the Claude desktop app as a local MCP server. Lets Claude answer
   "what's late on IMA?" and update the board from any conversation.
3. **(Optional) in-app Claude actions** — "draft reply", "summarise thread" via the Anthropic API.
   Needs an API key and company approval for data use; deferred.

## 8. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture, data model, snapshot contract | ✅ |
| 1 | Skeleton: Angular + Node + SQLite, dashboard / projects / mail / docs pages | ✅ skeleton |
| 2 | `pjm-sync` skill: Jira deadlines + suggested RAG | next |
| 3 | Mail triage via Outlook; doc checks via SharePoint + Confluence | |
| 4 | MCP server; project detail page; manual editing UI | |
