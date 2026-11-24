# Recap (evening run, after ingest in the same session)

1. **Docwatch — mandatory, never skip it.** Docs window: `L status` (`docs window`). For each active registry project with a known folder:
   `sharepoint_search` with `query: "*"` and the project folder name, keep results under that folder modified after
   the docs window start. Confluence: `rules.json.confluenceWatch` and registry Confluence items via
   `searchConfluenceUsingCql` with `lastmodified >= "<YYYY-MM-DD>"`. Put only those in a small delta
   (`run.mode: "recap"`, `docChanges` with `projectId, repository, name, url, path, modifiedAt, modifiedBy, version`,
   `run.lastRun.docs` = now, `run.me` as in ingest); the tool ignores my own changes and anything already known.
   Read a changed document only if it is the target of a pending proposal — then mark that proposal `stale` via
   `proposalUpdates` if its `baseModifiedAt` is older.
2. **Jira:** pjm-sync Q1/Q2 (my open DDMD epics and their open phases): keep phases overdue or due within 5 working
   days. Failure → write the recap without it and say so in `notes`.
3. **Calendar:** `outlook_calendar_search` for the next working day (Friday → Monday), not cancelled.
4. `L recap-context <today>` — if it prints ATTENZIONE lines, deal with them first (docwatch, owners), then run it again → per project: news of the day, what waits on me, what I wait on, dates within 7 days,
   pending proposals, unassigned threads.
5. Write `data/ledger/recaps/<today>.json` in this shape (don't read `ledger.schema.json`): per project only non-empty
   lists, **one short line per entry that reads on its own: who does what, by when** ("Rispondere a Bogoni sulla
   naming convention del modulo DDM", "Chiedere a Dina il feedback sull'assessment A/R", not "Naming convention
   richiesta dal cliente"); state only what the ledger says (never "riga aggiunta" unless a proposal was applied), `urgency: "high"` only when it really is; reference `itemId` or `threadKey`
   instead of writing links. Language `rules.json.recapLanguage` (default `it`). Skip projects with nothing that
   matters to Sebastiano today. Set `pendingProposals`, `unassigned` (subjects), `tomorrow`.
   ```json
   {"schemaVersion":1,"date":"2026-11-23","generatedAt":"2026-11-23T18:00:00+01:00","language":"it",
    "projects":[{"projectId":"DDMD-7107","name":"Petronas DE",
      "changedToday":[{"text":"…","itemId":"DDMD-7107-DAT-014"}],
      "waitingOnMe":[{"text":"…","urgency":"high","itemId":"…"},{"text":"…","threadKey":"…"}],
      "waitingOnOthers":[], "documentation":[{"text":"…","link":"<doc url>"}], "jira":[{"text":"…"}]}],
    "tomorrow":[{"start":"…","end":"…","subject":"…","projectId":"…"}],
    "pendingProposals":2, "unassigned":["subject"], "notes":[]}
   ```
6. `L recap-render <today>` → Markdown in `PJM Management\Recap\<YYYY>\` (versioned automatically).
7. Apply a last delta with `run.lastRun.recap` = now (can be the docwatch delta if written after step 5).
8. Final message: the recap path and the "Aspetta me" lines.
