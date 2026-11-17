# Microsoft To Do ↔ PJM aid (Power Automate)

Claude's Microsoft 365 connector has no permission on tasks, and the new Outlook has no local API, so PJM aid talks
to Microsoft To Do through **two Power Automate flows** and a folder in your OneDrive:

```
OneDrive - Archiva Group\PJM aid\
  todo-export.json   ← flow 1 "PJM aid – export To Do" writes all your lists and to-dos (every 10 minutes)
  outbox\*.txt       → flow 2 "PJM aid – write To Do" creates / updates the to-do, then deletes the file
```

OneDrive syncs the folder with the PC; the app reads `todo-export.json` and writes the request files. The app
creates the folder, the `outbox` sub-folder and an empty `todo-export.json` at start (Settings → Microsoft To Do).

Both flows use only **standard** connectors (Microsoft To-Do (Business), OneDrive for Business), included in the
Microsoft 365 licence. Build them at <https://make.powerautomate.com> with your work account. In an Italian
interface the actions have Italian names: search by the connector name and pick the action with the same
meaning (V2 / V3 versions as below).

> Tip: rename each action as indicated (… menu → *Rename*): the expressions below use those names.

---

## Flow 1 — "PJM aid – export To Do" (To Do → app)

1. **Create → Scheduled cloud flow**, name `PJM aid – export To Do`, repeat every **10 minutes**.
2. **Initialize variable** — Name `lists`, Type **Array**, Value empty.
3. **Microsoft To-Do (Business) → List all to-do lists (V2)** — rename to `ListLists`.
4. **Apply to each** — rename to `ForEachList`; *Select an output*: the output of `ListLists`
   (dynamic content "value" / "Body").
   Inside the loop:
   1. **Microsoft To-Do (Business) → List to-do's by folder (V2)** — rename to `ListTodos`.
      - *To-do List*: expression `items('ForEachList')?['id']`
      - *Top Count* (advanced parameters): `999`
   2. **Append to array variable** — Name `lists`, Value (expression, all on one line):

      ```
      addProperty(addProperty(addProperty(addProperty(json('{}'), 'listId', items('ForEachList')?['id']), 'listName', items('ForEachList')?['displayName']), 'wellknown', coalesce(items('ForEachList')?['wellknownListName'], '')), 'todos', body('ListTodos'))
      ```
5. After the loop: **OneDrive for Business → Update file**
   - *File*: browse to `/PJM aid/todo-export.json` (the app created it; if it isn't there yet, open the app once)
   - *File Content*: expression `string(variables('lists'))`
6. **Save**, then **Test → Manually**. After a minute the app shows *Microsoft To Do connected* and your to-dos
   on the To-do page (or press *refresh* there).

## Flow 2 — "PJM aid – write To Do" (app → To Do)

The app writes one small JSON file per change, e.g.:

```json
{"requestId":"…","action":"create","listId":"AAMk…","todoId":"","title":"Send UAT minutes","notes":"",
 "dueDate":"2026-11-20T09:00:00","importance":"normal","status":"notStarted"}
```

1. **Create → Automated cloud flow**, name `PJM aid – write To Do`, trigger
   **OneDrive for Business → When a file is created (properties only)**, *Folder*: `/PJM aid/outbox`.
2. **OneDrive for Business → Get file content** — rename to `GetContent`; *File*: the trigger's **ID** (Identifier).
3. **Compose** — rename to `Req`; *Inputs*: expression `json(body('GetContent'))`
   (if the test fails here with a "$content" error, use `json(base64ToString(body('GetContent')?['$content']))`).
4. **Switch** — *On*: expression `outputs('Req')?['action']`
   - **Case `create`** → **Microsoft To-Do (Business) → Add a to-do (V3)**
     - *To-do List*: `outputs('Req')?['listId']`
     - *Title*: `outputs('Req')?['title']`
     - *Due Date*: `if(empty(outputs('Req')?['dueDate']), null, outputs('Req')?['dueDate'])`
     - *Importance*: `outputs('Req')?['importance']` · *Status*: `outputs('Req')?['status']`
     - *Body Content*: `outputs('Req')?['notes']`
   - **Case `update`** → **Microsoft To-Do (Business) → Update to-do (V2)**
     - *To-do List*: `outputs('Req')?['listId']` · *To-do Task*: `outputs('Req')?['todoId']`
     - *Title*, *Due Date*, *Importance*, *Status*, *Body Content*: same expressions as above
5. After the Switch: **OneDrive for Business → Delete file** — *File*: the trigger's **ID**.
6. **Save**. Test: add a task in the app's To-do page; within a few minutes it appears in To Do (and the app shows
   it as synced after the next export). Tasks the flow couldn't write stay "being sent to To Do": fix the flow and
   press *resend* on the task.

## Behaviour

- Lists and to-dos come from To Do; to-dos deleted in To Do disappear from the app. Completed ones are kept for 14
  days (*show completed*).
- In the app you can add tasks, complete / reopen them, change title, due date and importance (written back to To
  Do), and link a task to a project (kept only in the app). Tasks that exist only in the app can be deleted there;
  to delete a To Do task, delete it in To Do.
- Without the flows the To-do page still works: tasks stay in the app ("app only").
- Folder and default list for new tasks: Settings → Microsoft To Do.
