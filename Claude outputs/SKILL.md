---
name: pjm-sync
description: Sync Sebastiano's PJM aid web app — Jira DDMD epics/phases, Outlook mail to answer, and (on request or weekly) SharePoint/Confluence documentation checks — into data/inbox/snapshot.json in the pjm-aid-webapp folder. Use for "sync PJM", "sync PJM docs", "aggiorna la PJM board", the app's "Sync now" button, or the scheduled PJM sync.
---

# PJM sync (Jira + Outlook + SharePoint/Confluence → PJM aid)

The PJM aid app (Angular + Node, in the `pjm-aid-webapp` folder on Sebastiano's computer) shows project status,
deadlines, mails to answer and documentation gaps. It does not talk to Jira, Outlook or SharePoint itself: this
skill collects the data with the connectors, makes the judgement calls (does this mail need *his* reply? is this
the analysis document?), and drops one snapshot file into the app's inbox. The backend watches
`data/inbox/snapshot.json` and imports it within a couple of seconds (or at next start).

## Modes

| Request | Jira | Mail | Docs |
|---|---|---|---|
| "sync PJM" / "Jira and mail" / daily scheduled run | ✓ | ✓ | – |
| "sync PJM docs" / "full sync" / Monday scheduled run | ✓ | ✓ | ✓ |
| "sync PJM jira only" | ✓ | – | – |

Jira always runs: the snapshot is the authoritative Jira picture (`complete: true`).

The Jira rules are the same as the `controllo-pm` skill (DDMD project, archivagroup.atlassian.net, field
`customfield_11738` = start date, overdue / at-risk / missing-data flags). Flags, RAG and which documents are
due are computed by the app from the raw fields — this skill collects data and makes the mail/doc judgement calls.

## 0. Where you are running

**A. Local — Claude Code in the repo folder** (the app's "Sync now" button runs `claude -p` there; also an
interactive `claude` session opened in the folder). You are here when `tools/build-snapshot.ts` exists in the
working directory.
- Files are local: read `data/registry.json` directly; no staging, no committing.
- Working files go in `data/work/<timestamp>/` (git-ignored); write only there and to the inbox (via the builder).
- When a connector result is too large and Claude Code saves it to a file, pass that file path straight to the
  builder — don't read or copy it.
- Builder: `node tools/build-snapshot.ts … --out data/inbox/snapshot.json` (it writes atomically).
- Headless runs (`-p`): nobody can answer questions or permission prompts — never ask; if a tool is denied, say
  which one in the final report. Your final message is shown in the app as the sync result.
- Allowed tools are pre-approved in `.claude/settings.json` (read-only connector tools, the builder, writes under
  `data/work/`). Don't try other tools.

**B. Cowork — cloud workspace with the computer linked.**
- The computer must be linked and the `pjm-aid-webapp` folder connected (normally
  `C:\Users\SebastianoFilippetto\Documents\pjm-aid-webapp`; confirm with the session's connected folders /
  `get_device_info`). If it is not reachable, say so and stop — don't produce a snapshot elsewhere.
- Stage from the folder (always re-stage, the repo may have changed): `tools/build-snapshot.ts`,
  `tools/package.json`, `backend/src/flags.ts`, `backend/package.json`, and `data/registry.json`.
  They land under `/mnt/user-data/uploads/pjm-aid-webapp/…`; the builder runs with the container's `node`
  (≥ 22.18, no install). Work in a fresh scratch dir, e.g. `/home/claude/pjm-sync-<timestamp>/`.
- When a result is too large the harness saves it and gives a path → `cp` it into the scratch dir.

In both: `data/registry.json` is written by the app — projects (id = epic key, name, client, current phase,
SharePoint folder, documentation checklist with `required` flags), open mail threads, and
`lastSync.generatedAt`. If it is missing (app never started), do Jira only and say so.

## 1. Jira (cloudId `archivagroup.atlassian.net`) — same scope as `controllo-pm`

Get "me" with `atlassianUserInfo` (`account_id`). Ask only for the listed fields; `maxResults: 100`; when
`pageInfo.hasNextPage`, fetch the next page with `nextPageToken` and keep each page as its own file.

| # | JQL | fields | file |
|---|---|---|---|
| Q1 | `project = DDMD AND issuetype = Epic AND assignee = currentUser() AND statusCategory != Done` | summary, status, duedate, customfield_11738, assignee | `epics*.json` |
| Q2 | `project = DDMD AND parent in (<Q1 keys>) AND statusCategory != Done` | summary, status, duedate, customfield_11738, timeoriginalestimate, timeestimate, parent, assignee | `phases*.json` |
| Q3 | `project = DDMD AND assignee = currentUser() AND statusCategory != Done AND issuetype in standardIssueTypes() AND issuetype != Epic AND parent not in (<Q1 keys>)` | same as Q2 | `foreign*.json` |
| Q4 | `project = DDMD AND parent in (<candidates>) AND statusCategory != Done` | summary, status, parent, assignee | `subtasks*.json` |

If Q1 returns nothing, Q2 is skipped (no epics is a valid, clean result).

Candidates for Q4: `node <builder> --candidates --phases <phases files> --foreign <foreign files>`
(prints keys of open phases overdue or due within 14 days; empty → skip Q4).

**Results that come back inline** (not saved to a file): write them as an array of compact rows
`{"key","summary","status","cat","due","start","origH","remH","parent","parentSummary","assignee","assigneeId"}`
(`cat` = status category key new/indeterminate/done; `due`/`start` = duedate/customfield_11738; `origH`/`remH`
= estimate seconds ÷ 3600; copy values exactly).

**If any Jira call fails, stop** — a partial `complete` snapshot would close phases in the app.

## 2. Mail (Microsoft 365 connector) → `mail.json`

Window: from `registry.lastSync.generatedAt` (minus 1 hour) to now; first run or no lastSync → the last
2 working days; never more than 7 days. My addresses: the `get_me` mail plus the same local part on
`ddmtechnology.it` / `ddmsolutions.it`.

1. `outlook_email_search` with `folderName: "Inbox"`, `afterDateTime: <window start>`, `limit: 25`, paging with
   `offset` until done (folder searches come newest first).
2. Same on `folderName: "Sent Items"` for the window — this tells which threads already got my reply.
3. Ignore noise: Jira/ScriptRunner notifications, Teams notifications, automatic/out-of-office replies, OTP or
   password notices, newsletters/marketing, mails only to distribution lists (delivery@, ams@) that don't name me.
4. Group by thread = subject without R:/RE:/I:/FW:/AW:… prefixes. For each relevant thread decide:
   - `needs_reply` — the last message is not mine and it asks me something, waits on my decision/input, or I am the
     DDM owner of the topic. If a colleague already answered on DDM's behalf, it is `fyi`.
   - `waiting` — my message is the last one and it asks others for something (from Sent Items, or registry
     open threads I have now answered).
   - `fyi` — project-relevant information worth seeing (decisions, go-live dates). Skip everything else.
   - `urgency`: high = deadline/meeting within ~2 working days or a blocked go-live/UAT; low = no action expected soon.
5. Re-check `registry.openMail` threads with category needs_reply: if Sent Items shows my reply in the window,
   re-emit them with `lastFromMe: true` and category `waiting` (or `fyi` if nothing is expected back).
6. Write `mail.json`: array of
   `{"subject","projectId","counterpart","lastMessageAt","lastFromMe","category","urgency","summary","webLink"}`.
   `subject` = the original subject (the builder derives a stable thread id from it — don't invent ids);
   `projectId` = the registry project the thread belongs to (match client name / domain / topic; null if unsure);
   `summary` = one sentence in the mail's language saying what is asked; `webLink` = the last inbound message's
   webLink, copied exactly; `lastMessageAt` = its receivedDateTime.

Mail is incremental: threads not in this run stay as they are in the app (the user closes them).

## 3. Documentation (docs mode only) → `docs.json`, `folders.json`

For each **active** registry project with docs where `required && !waived && checkStatus != "present"`:

1. Project folder: use `sharepointFolderUri` if known. Otherwise find it: DDM's standard layout is
   `Delivery/Progetti Clienti/<Client>/<Year>/<Project folder>` on the DDMSOLUTIONS site —
   `sharepoint_folder_search` with the client name, pick the folder whose name matches the epic topic
   (e.g. "Mevis - FE Slovacchia" for "Mevis - FEI Slovacchia"; "FEI DE" under Fedrigoni/2026). Path URIs work with
   `read_resource`: `file:///<driveId>/Delivery/Progetti Clienti/<Client>/<Year>/<Folder>`. Record new folders in
   `folders.json` as `{"projectId","folderUri","webUrl"}` (webUrl with spaces encoded as %20). Not found → leave the
   docs `unknown` and mention it.
2. List the project folder (`read_resource`). Standard subfolders: 0. Offerta · 1. Avvio · 2. Pianificazione ·
   3. Analisi · 4. Implementazione · 5. UAT · 6. Cutover - Live · 7. Post Golive - Chiusura · 8. CR Extra ·
   99. Project documents / File condivisi col cliente (shared with the customer; subfolders such as Analisi,
   Requirements Gathering, UAT, Kickoff). Listings show folder sizes: **skip 0-byte folders**, open only the
   subfolders relevant to the missing docs (use each doc's `locationHint`), at most ~4 listings per project.
3. Decide per required doc: `present` (a matching file exists — e.g. analysis ≈ "Analisi", "Requirements
   Gathering", "Raccolta requisiti"; Open Topics Log ≈ "Open Topics", "Open Point"; system test ≈ "Internal
   testing", "Test interni"; UAT testbook ≈ "Testbook"; UAT sign-off ≈ "Verbale collaudo/UAT"; cutover ≈
   "cutover"), `outdated` (exists but clearly a superseded/old version only), `missing` (folder checked, nothing
   matching). Confluence docs (`repository: confluence`): `searchConfluenceUsingCql` with the topic
   (e.g. `title ~ "FEI Slovacchia" AND type = page`) — present if a product page was updated in the project period.
4. Write `docs.json`: `[{"requirementId","status","foundUrl"}]` — `foundUrl` = browser URL of the file
   (folder webUrl + "/" + subfolder + "/" + file name, spaces as %20).

## 4. Build and deliver

Arguments (omit the optional ones you have no file for):
`--me <account_id> --site https://archivagroup.atlassian.net --epics … --phases … [--foreign …] [--subtasks …]
[--mail mail.json] [--docs docs.json] [--folders folders.json] --out <out>`

- **Local:** `node tools/build-snapshot.ts <arguments> --out data/inbox/snapshot.json` — done; the app imports it.
- **Cowork:** `OUT=/mnt/user-data/outputs/pjm-sync/snapshot-$(date -u +%Y%m%dT%H%M%S).json` (a new name every
  run: committing the same staged path twice can deliver the previous content), run
  `node /mnt/user-data/uploads/pjm-aid-webapp/tools/build-snapshot.ts <arguments> --out "$OUT"`, then
  `device_commit_files` stagedPath `$OUT` → devicePath `<pjm-aid-webapp folder>\data\inbox\snapshot.json`, and
  verify with `device_bash` (head of the file) that the new snapshot landed.

The builder validates categories/statuses and fails loudly — fix the input, don't skip the check.

## 5. Report

Brief, in the language of the request (Italian for scheduled runs and for the app's "Sync now"), neutral tone like
`controllo-pm`: relay the builder's stdout (overdue / at-risk phases with open sub-tasks, mails needing a reply with
urgency, doc gaps found), with natural names and links (`https://archivagroup.atlassian.net/browse/<KEY>`). In
Cowork add one line: the app imports the snapshot automatically if running, otherwise at next start (or **Import
snapshot**). Don't attach the snapshot file to the chat unless asked. Unattended or headless runs: no questions —
collect, build, deliver, report.

## Notes

- Never edit the app's database, `data/seed.json` or `data/registry.json` from this skill.
- Projects are created by the app from epics; Sebastiano groups/hides them in the Projects page.
- Snapshot format and field ownership: `docs/ARCHITECTURE.md` in the repo; skill source:
  `.claude/skills/pjm-sync/SKILL.md`.
