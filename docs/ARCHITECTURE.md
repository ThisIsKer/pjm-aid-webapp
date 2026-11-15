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
 │   watches data/inbox/ and imports each new snapshot        │
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

## 3. Projects come from Jira

Every DDMD epic assigned to Sebastiano becomes a project automatically at the first sync (id = epic key,
name = epic summary, client = text before the first " - "). Epics where he only owns phases (someone else's
epic) become **contributor** projects. In the Projects page he can:

- **group** epics into one project (e.g. "Mevis - FEI Slovacchia" + "Tecnica - FEI Slovacchia") — the emptied
  project is hidden;
- **hide** projects he doesn't want on the dashboard;
- set **his own RAG status**, which is shown next to the Jira-derived one.

A project created from Jira is hidden automatically when none of its epics is reported open anymore.
`data/seed.json` is now only needed for the documentation checklist template and for non-Jira projects.

### Jira rules (same as the `controllo-pm` skill) — `backend/src/flags.ts`

Phases = direct children of the epic (Story/Task), open = `statusCategory != Done`.

| Flag | Rule |
|---|---|
| overdue | due date in the past |
| at risk | due within 14 days and remaining estimate > 0.5 day × working days left (Mon–Fri, tomorrow → due date) |
| missing due / start / estimate | `duedate` / `customfield_11738` / `timeoriginalestimate` empty |

Project **Jira RAG**: red = ≥ 1 phase overdue · amber = ≥ 1 at risk · green = open phases on track ·
grey = no open phases or none has a due date. **Current phase**: the latest of
Analisi → Implementazione → Test interni → UAT → Live → Post GoLive that has started; otherwise the next one
with its start date. SAL/Allineamenti runs in parallel and is ignored for this. Phase names are normalised from
the Jira summary ("… - UAT e Rework - CB" → UAT, "… - Live VB" → Live).

Flags are computed when the API is called, so "overdue" moves with the calendar even between syncs.

## 4. Data ownership

Every field has exactly one owner, so a Claude sync never overwrites a decision you made.

| Entity | You own | Claude owns (via snapshot) |
|---|---|---|
| Project | name, client, phase override, **status (RAG)**, PM note, SharePoint URL, Confluence space, mail keywords/domains, active | creation from epic, `suggestedStatus`, `suggestedReason` |
| Jira epic | which project it belongs to | summary, status, dates, assignee, mine, active |
| Deadline | manual deadlines | Jira phases (dates, estimates, assignee, status, open sub-tasks) |
| Mail thread | `userState` (open/done/snoozed), `snoozedUntil`, project re-assignment | subject, counterpart, category, urgency, summary, link, last message |
| Doc requirement | the checklist (template + per project), `waived` | `checkStatus`, `foundUrl`, `checkedAt` |

Rules applied on import:

- A newer message on a thread you closed or snoozed **re-opens** it; a thread's project, once set, is never
  overwritten by Claude.
- With `"complete": true`, Jira phases and epics missing from the snapshot are closed (and Jira-created projects
  without open epics hidden). **Mail is incremental**: only threads seen in the run's window are upserted, nothing is
  closed by absence.
- `projectFolders` sets the SharePoint folder Claude found (and the project's SharePoint link if you haven't set one).
- Unknown project / requirement ids are skipped and reported as warnings (visible in `sync_runs`).
- An identical snapshot (same SHA-256) is not imported twice.

## 5. Mail triage and documentation checks (phase 3)

**Mail** — each sync reads Inbox and Sent Items for the window since the last sync (first run: 2 working days,
max 7), drops noise (Jira/Teams notifications, auto-replies, distribution lists), groups by subject and classifies
each relevant thread: *needs_reply* (last message not mine and it asks me something), *waiting* (my message is
last and expects an answer), *fyi* (project-relevant information). Thread id = `mail:` + slug of the subject
without R:/RE:/I:/FW: prefixes (`normalizeSubject` in `flags.ts`). Open threads from previous runs are re-checked
against Sent Items, so a thread you answered moves to *waiting*.

**Documentation** — the checklist template in `data/seed.json` (`docTemplate`) is re-read at every start and
aligned on every project (items added/removed; check results and waivers kept). Each item has the phase that
produces it and `requiredFrom` (default: the next phase), so a document only counts as a gap once the project —
by its Jira current phase — has reached that point. `clientMatch` limits items (e.g. product documentation in
Confluence only for "Tecnica" epics). Claude checks the DDM standard SharePoint layout
(`Delivery/Progetti Clienti/<Client>/<Year>/<Project>` with 0–8 phase folders and 99 "shared with customer"),
skipping empty folders, and Confluence for product pages. Doc checks are heavier, so they run on request
("sync PJM docs") or weekly; results are sticky until the next check.

Default checklist (edit freely): Documento di analisi · Open Topics Log · Verbale system test · Testbook UAT ·
Verbale di collaudo UAT · Piano di cutover / go-live · Documentazione di prodotto aggiornata (Confluence, Tecnica only).

**`data/registry.json`** — written by the backend after every import and every change made in the UI; the skill
stages it to know projects, current phases, SharePoint folders, the checklist with `required` flags, open mail
threads and the last sync time.

## 6. Database schema (v3)

`projects` · `jira_epics` · `deadlines` (+ view `v_deadlines` resolving each phase's project through its epic) ·
`mail_threads` · `doc_requirements` · `doc_template` · `sync_runs` — see `backend/src/db.ts`.
Migrations are append-only and tracked with `PRAGMA user_version` (v3 adds `projects.sharepoint_folder_uri`,
`required_from` / `client_match` / `from_template`). Requirement id = `<projectId>--<slug(title)>`, which is the id
Claude reports back in `docChecks`.

## 7. Snapshot contract v2 (`data/inbox/snapshot.json`)

Written by the `pjm-sync` skill through `tools/build-snapshot.ts`; the backend watches the file and imports it.

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-11-15T07:30:00+01:00",
  "complete": true,                       // full picture → absent items get closed
  "jira": {
    "epics":  [{ "key", "summary", "status", "statusCategory", "startDate", "dueDate", "assignee", "mine", "url" }],
    "phases": [{ "key", "epicKey", "summary", "phaseName", "status", "statusCategory", "startDate", "dueDate",
                 "assignee", "assignedToMe", "originalHours", "remainingHours", "url",
                 "openSubtasks": [{ "key", "summary", "assignee" }] }]
  },
  "projects":    [{ "id", "suggestedStatus": "green|amber|red|grey", "suggestedReason" }],
  "projectFolders": [{ "projectId", "folderUri": "file:///<driveId>/…", "webUrl" }],
  "mailThreads": [{ "id": "mail:<subject slug>", "projectId|null", "subject", "counterpart",
                    "lastMessageAt", "lastFromMe", "category": "needs_reply|waiting|fyi",
                    "urgency": "high|normal|low", "summary", "webLink" }],
  "docChecks":   [{ "requirementId", "status": "missing|present|outdated|unknown", "foundUrl?", "checkedAt?" }]
}
```

Full example: `docs/examples/snapshot.example.json`.

## 8. REST API (`/api`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + last sync |
| GET | `/dashboard?days=14` | KPIs, project summaries (Jira RAG, current phase), overdue + upcoming phases with flags |
| GET/POST | `/projects` | list (`?all=true` includes hidden) / create |
| GET/PATCH | `/projects/:id` | detail with epics, phases, mails, docs / update owned fields |
| GET | `/jira/epics` | open epics and the project each belongs to |
| PATCH | `/jira/epics/:key` | `{ projectId }` — group the epic into another project |
| POST | `/projects/:id/deadlines` | add a manual deadline |
| PATCH | `/deadlines/:id` | edit a manual deadline (Jira phases are edited in Jira) |
| GET | `/mail?category=needs_reply&state=all` | triage list (snoozed items return when due) |
| PATCH | `/mail/:id` | done / snooze / re-assign project |
| GET | `/docs?all=true` | documentation gaps due now (default) or the full checklist with `required` flags |
| POST | `/projects/:id/docs` | add a requirement |
| PATCH | `/docs/:id` | waive ("not needed") / edit hint |
| POST | `/sync/import?force=true` | import the snapshot now |
| GET | `/sync/runs` | last 20 imports with counts and warnings |

## 9. Claude integration roadmap

1. **`pjm-sync` skill (Cowork)** — source in `claude/skills/pjm-sync/SKILL.md`. Jira (same scope as
   `controllo-pm`), Outlook mail triage, and on request SharePoint/Confluence doc checks; runs
   `tools/build-snapshot.ts` in the Claude workspace and commits `snapshot.json` into the folder. Triggered on
   demand ("sync PJM", "sync PJM docs") and by a weekday-morning scheduled task (to set up at the end).
2. **MCP server in the backend** — tools such as `list_projects`, `get_project`, `add_deadline`, `set_status`,
   `mark_mail_done`, registered in the Claude desktop app as a local MCP server. Lets Claude answer
   "what's late on IMA?" and update the board from any conversation.
3. **"Sync now" button in the app (candidate)** — the backend would launch Claude Code headless
   (`claude -p "sync PJM"`) in the repo folder, with the skill as a project skill under `.claude/skills/` and a
   local variant of the steps (no staging: files are local). Prerequisites to verify first: Claude Code installed and
   signed in on the laptop, Atlassian and Microsoft 365 connectors usable from Claude Code, company OK. Usage counts
   against the Claude plan. Until then: ask Claude in Cowork, or rely on the scheduled task.
4. **(Optional) in-app Claude actions** — "draft reply", "summarise thread" via the Anthropic API.
   Needs an API key and company approval for data use; deferred.

## 10. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture, data model, snapshot contract | ✅ |
| 1 | Skeleton: Angular + Node + SQLite, dashboard / projects / mail / docs pages | ✅ |
| 2 | `pjm-sync` skill: Jira epics → projects, phases, controllo-pm flags, Jira RAG, auto-import | ✅ |
| 3 | Mail triage via Outlook; phase-aware doc checks via SharePoint + Confluence; registry.json | ✅ |
| 4 | MCP server; project detail page; manual editing UI; "Sync now" via Claude Code (if prerequisites hold) | next |
| 5 | Weekday-morning scheduled sync (daily Jira + mail, Monday + docs) | at the end |
