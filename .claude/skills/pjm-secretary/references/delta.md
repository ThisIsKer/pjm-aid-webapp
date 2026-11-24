# Delta format (one file per run, written by Claude, merged by `L apply`)

Only what is new or changed. The tool assigns item ids, proposal ids, timestamps and links, creates events for
threads and items, auto-closes past dates and archives old items — don't do any of that yourself.
Do not write `webLink`/`uri` for mail (derived from the message id). Dates `YYYY-MM-DD`, times ISO 8601 with offset.

```json
{
  "schemaVersion": 1,
  "run": {
    "mode": "ingest",
    "window": { "from": "2026-11-23T14:30:00+01:00", "to": "2026-11-23T16:30:00+01:00" },
    "sources": { "mail": { "seen": 14, "noise": 9 }, "teams": { "seen": 3, "noise": 1 } },
    "me": ["sebastiano.filippetto", "Sebastiano Filippetto"],
    "lastRun": { "mail": "2026-11-23T16:30:00+01:00", "teams": "2026-11-23T16:30:00+01:00" },
    "denied": [], "notes": []
  },
  "projects": { "DDMD-7107": { "name": "Petronas DE - FEI Germania", "client": "Petronas" } },
  "threads": [
    { "threadKey": "petronas-de-technical-kick-off-20261123", "source": "mail", "projectId": "DDMD-7107",
      "subject": "R: Technical Kick-Off - Follow up",
      "assignment": { "method": "rule", "confidence": "high", "rule": "domain petronas.com" },
      "participants": [ { "name": "Fabio Zodo", "email": "fabio.zodo@archivagroup.it", "org": "archiva" } ],
      "newMessages": [ { "id": "<message id>", "at": "2026-11-23T16:05:00+01:00", "from": "x@petronas.com", "fromMe": false } ],
      "summary": "≤3 frasi", "replyState": "fyi", "urgency": "normal", "counterpart": "Rafie Sanusi (Petronas)" }
  ],
  "items": [
    { "op": "open", "ref": "n1", "projectId": "DDMD-7107", "type": "date", "eventDate": "2026-12-04",
      "text": "Primo meeting UAT confermato: 4/12 ore 11:00", "source": { "threadKey": "petronas-de-technical-kick-off-20261123" } },
    { "op": "supersede", "id": "DDMD-7107-DAT-012", "by": "n1", "source": { "threadKey": "petronas-de-technical-kick-off-20261123" } },
    { "op": "update", "id": "DDMD-4249-ACT-004", "text": "testo aggiornato", "due": "2026-11-27", "source": { "threadKey": "…", "at": "…" } },
    { "op": "close", "id": "DDMD-3604-QST-002", "reason": "risposto", "source": { "threadKey": "…" } }
  ],
  "docChanges": [], "proposals": [], "proposalUpdates": [],
  "events": [ { "kind": "note_updated", "projectId": "DDMD-4249", "text": "Nota tecnica aggiornata: …", "ref": "<file name>" } ]
}
```

- `threads`: only threads with new messages or a changed reply state; Teams: `threadKey` =
  `teams-<counterpart-or-topic-slug>-<last 8 chars of chatId>`, `source: "teams"`, include `chatId` and each
  message's `webLink` if the search returned one. New mail thread key = subject without R:/RE:/I:/FW:/AW:/TR:
  prefixes, slug `a-z0-9-` max 60 + `-YYYYMMDD` of the first message. `org`: ddm | archiva | client | other.
- `assignment.method`: `rule` (matched rules.json: domain, keyword, person), `registry` (matched registry client/topic),
  `judgement` (your own reading), `manual` (Sebastiano said so); `confidence`: high | medium | low.
- `source` of an item: `{ "threadKey" }` = newest message of that thread; add `"at"` to point at a specific
  message. Non-mail sources: `{ "kind": "confluence|sharepoint|jira|meeting|manual", "ref", "at", "from" }`.
- `ref` (any short string) lets later ops in the same delta point at an item you open in it.
- Item fields: `type`, `text` (≤500, source language), optional `owner`, `counterpart`, `due`, `eventDate`,
  `language`, `details` `{system, objects[], values[]}`. `update` may also set `"reopen": true`.
- `projects`: only for projects new to the ledger (name, client) or to refresh `summary` (≤5 sentences).
- `run.lastRun`: set `mail`/`teams` to the window end; `docs`/`recap` only in the recap run.
