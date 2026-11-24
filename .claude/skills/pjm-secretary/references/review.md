# Review and apply proposals (interactive only; headless runs never do this)

1. `L proposals`, then show the pending ones grouped by project, numbered, with target file, the changes in plain
   words and the source links (`L context --projects <id>` if you need the items). Wait for decisions:
   `approva`, `scarta`, `modifica <n>: …`.
   Proposals already `approved` (Sebastiano approved them in the PJM aid app's Secretary page — that is his
   decision): list them first as "approvate nell'app" and, on "applica le proposte approvate" (or after the pending
   ones are decided), go straight to step 2 for them without asking again. Proposals he rejected in the app are
   already `rejected`: don't show them.
2. For each approved proposal:
   - **Freshness:** if the target file is newer than `baseModifiedAt` (someone edited it), don't apply: regenerate
     the changes against the current file and show them again. A OneDrive conflict copy or a locked file → stop
     and report.
   - **Apply** in the document's own format with Python (openpyxl for Excel, python-docx for Word); Claude Code
     asks permission for the command and the edit — that is the second confirmation. Keep formatting, formulas and
     existing rows; closing an issue = updating its status column, never deleting rows.
   - Shared folder: no backups (SharePoint keeps versions). Personal folder: backup script first.
3. Delta with `run.mode: "apply"` and `proposalUpdates`: `{ "id", "status": "applied", "resultModifiedAt" }`,
   `{ "id", "status": "rejected", "note": "<reason>" }`, or a modified proposal (`changes`, `target`) kept
   `pending`. Then `L apply`.
