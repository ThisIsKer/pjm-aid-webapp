# Organize project folders and file the buffer (interactive only)

Folders: the project folders of the registry projects (the ones the PJM aid app shows) under the shared root
`shared:` = `…\DDM SOLUTIONS - Documenti\Delivery\Progetti Clienti` (Client / Year / Project), and the buffer
`buffer:` = `PJM Management\00 Da archiviare` (Sebastiano drops files there to be filed). Paths in plans always
start with `shared:`, `buffer:` or `personal:`. The shared folder is shared with colleagues: **nothing moves without
Sebastiano's approval of the plan**, and the tool's execution asks permission again.

## Rules for a plan

- Standard structure = `rules.json.folderTemplate` (keys = subfolder names, values = what belongs there).
- **Loose files** in the project root or in a non-standard subfolder → the standard subfolder that fits (decide
  from the file name; open a file only if the name is ambiguous, and read only its first page).
- **Versions/duplicates** (the tool groups them): keep the newest in place; `archive` the older ones (the tool
  moves them to `old\<name>_<date>.<ext>` next to them). Only when the names clearly show they are versions of
  the same document — if unsure, list it as a doubt, don't archive.
- **Missing standard subfolder** → `mkdir` only if a file in this plan needs it.
- **Never**: rename, delete, touch anything inside `old`, move files the tool marks as open (`~$` lock) or modified
  today, move whole folders, merge non-standard subfolders by yourself. Same project under two year folders (e.g.
  `2025` and `2026`) → flag it, never merge.
- One plan per project; buffer files may go to any project (`projectId` on each op).

## Procedure

1. Pick the projects: the ones Sebastiano names, or all active registry projects with a folder. From the registry
   folder URL keep the part after `Progetti Clienti/` → `L tree shared "Client/Year/Project"`, one project at a
   time. Buffer: `L tree buffer`; for each file, the project from the file name (client, project, Jira key) via the
   registry and `rules.json.projectRules`, then the subfolder. Not sure → leave it in the buffer and say why.
2. Show the plan per project as a numbered list: `n. <file> → <subfolder>` / `archivia <file> (versione del …)` /
   `crea <subfolder>`, each with a short reason, then the doubts. Wait: "approva tutto", "approva 1-4, 7",
   "escludi 3", corrections.
3. Write only the approved operations to `data/ledger/organize/plan-<YYYYMMDD-HHmmss>.json`:
   ```json
   {"schemaVersion":1,"ops":[
     {"op":"move","from":"shared:GD Dorigo/2026/GD Dorigo - Passaggio a S4/Testbook S4 v2.xlsx","to":"shared:GD Dorigo/2026/GD Dorigo - Passaggio a S4/5. UAT/","reason":"test book","projectId":"DDMD-4249"},
     {"op":"archive","path":"shared:…/3. Analisi/Specifica DDM.docx","reason":"versione precedente di Specifica DDM (1)","projectId":"DDMD-4249"},
     {"op":"mkdir","path":"shared:…/6. Cutover - Live","reason":"cartella standard mancante"},
     {"op":"move","from":"buffer:Verbale UAT Dorigo 20-11.pdf","to":"shared:…/5. UAT/","reason":"verbale UAT","projectId":"DDMD-4249"}]}
   ```
   A `to` ending in `/` (or an existing folder) keeps the file name.
4. `L organize-apply <plan>`. Errors → nothing was moved: fix the plan and retry. Report what moved.
5. Undo: "annulla l'ultima riorganizzazione" → `L organize-undo` (latest run) or `L organize-undo <log>`.

Note for Sebastiano when relevant: moving a file inside the shared library keeps its version history and sharing
links, but links copied from the address bar or bookmarked paths to the old location stop working.
