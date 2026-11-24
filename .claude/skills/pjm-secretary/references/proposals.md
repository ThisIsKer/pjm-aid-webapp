# Documentation proposals (added to the delta, never applied during ingest)

- Targets: `rules.json.docTypes` (`match` = filename patterns, `folder`, `structure`). Find the current file in the
  project folder (registry `sharepointFolderUri` or the local OneDrive copy); several candidates → the most recently
  modified. `target`: `location` shared|personal, `docType`, `path` (absolute local path), `webUrl`,
  `baseModifiedAt` = the file's modified date now (omit for `create`).
- When: new or closed `open_point` → open issue list; new `date`/`action` in the cutover phase → cutover plan;
  technical items that complete a draft note → technical sheet (publish the note: `create` or `update` into the
  doc type's folder).
- `changes`: operations in the document's own structure — `add_row`, `update_row`, `close_row` (row key = ID
  column value in `locator`, `content` = column → value), `add_section`, `replace_section` (heading in `locator`,
  Markdown `content`), `new_document`. Optional `itemIds` (ids or delta refs). Group all changes to one document
  from this run into one proposal. No `structure` for the doc type → describe the content, `"needsTemplate": true`.
- `rationale`: one sentence. `sources`: same form as item sources.
- Before proposing, `L proposals`: don't repeat what a pending, stale or rejected proposal already covers.
