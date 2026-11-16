import { Injectable, Pipe, type PipeTransform, computed, inject, signal } from '@angular/core';

export type Lang = 'it' | 'en';

type Dict = Record<string, string>;

const IT: Dict = {
  'nav.dashboard': 'Dashboard', 'nav.projects': 'Progetti', 'nav.mail': 'Mail da gestire', 'nav.docs': 'Documentazione',
  'lang.label': 'Lingua',
  'nav.syncing': 'Sync in corso…', 'common.on': 'Attiva', 'common.off': 'Disattiva',
  'auto.title': 'Sincronizzazione del giorno', 'auto.help': 'Prima apertura di oggi: Claude sta aggiornando la web app. Puoi chiudere questa finestra, la sync continua in background.', 'common.closeCap': 'Chiudi',
  'auto.closeHelp': 'Chiudi: la sync continua in background', 'set.sync': 'Sincronizzazione',
  'set.auto': 'Sync alla prima apertura del giorno', 'set.autoHelp': 'Avvia "Sincronizza ora" la prima volta che apri la web app ogni giorno (se oggi non c\'è già stata una sync).',
  'set.autoDocsMonday': 'il lunedì includi la documentazione', 'set.importHelp': 'Importa a mano data/inbox/snapshot.json (di solito avviene da solo).',
  'docs.totMissing': '{n} mancanti', 'docs.totAttention': '{n} da confermare', 'docs.okOf': '{ok} di {n} ok',
  'docs.missing': 'mancanti', 'docs.attention': 'da confermare', 'docs.noFolderShort': 'cartella non trovata',
  'docs.noFolder': 'Cartella di progetto non trovata (Delivery › Progetti Clienti › cliente › anno)',
  'doc.okHelp': 'Il documento c\'è ed è ok', 'doc.okUndo': 'Togli la conferma', 'doc.modified': 'modificato {d}',
  'doc.notFoundIn': 'Non trovato nella', 'doc.expectedIn': 'Da cercare nella', 'doc.projectFolder': 'cartella di progetto',
  'doc.expected': 'atteso in: {h}', 'doc.notDueYet': 'non ancora dovuto',
  'doc.state.ok': 'Ok', 'doc.state.new': 'Nuovo', 'doc.state.updated': 'Aggiornato', 'doc.state.missing': 'Mancante',
  'doc.state.unchecked': 'Da verificare', 'doc.state.waived': 'Non necessario', 'kpi.attention': '{n} da confermare',
  'nav.settings': 'Impostazioni',
  'set.title': 'Impostazioni', 'set.appearance': 'Aspetto', 'set.language': 'Lingua',
  'set.languageHelp': "Lingua dell'interfaccia e dei report di Claude.",
  'set.theme': 'Tema', 'set.themeHelp': 'Il tema scuro è più riposante per gli occhi. "Sistema" segue Windows.',
  'set.theme.light': 'Chiaro', 'set.theme.dark': 'Scuro', 'set.theme.system': 'Sistema',
  'set.claude': 'Claude', 'set.claudeHelp': 'Claude Code usato da "Sync ora" su questo PC.',
  'set.lastSync': 'Ultima sync', 'set.lastSyncHelp': 'Ultimo snapshot importato nella web app.',
  'grp.title': 'Gruppi', 'grp.new': 'Nuovo gruppo', 'grp.edit': 'Modifica gruppo', 'grp.delete': 'Elimina gruppo',
  'grp.name': 'Nome', 'grp.namePh': 'es. Clienti retail', 'grp.color': 'Colore', 'grp.none': 'Senza gruppo',
  'grp.all': 'Tutti i gruppi', 'grp.nameRequired': 'Inserisci un nome.', 'grp.exists': 'Esiste già un gruppo con questo nome.',
  'grp.confirmDelete': 'Eliminare il gruppo "{name}"? I progetti restano, senza gruppo.',
  'col.group': 'Gruppo',
  'proj.mergeHelp': "Unisce le epiche di questo progetto a un altro progetto (diverso dai gruppi).",
  'rag.red': 'Critico', 'rag.amber': 'Attenzione', 'rag.green': 'Ok', 'rag.grey': 'n/d',
  'flag.overdue': 'scaduta', 'flag.at_risk': 'a rischio', 'flag.missing_due': 'senza scadenza',
  'flag.missing_start': 'senza data inizio', 'flag.missing_estimate': 'senza stima',
  'reason.overdue': '{n} fasi scadute', 'reason.atRisk': '{n} fasi a rischio', 'reason.ok': '{n} fasi aperte nei tempi',
  'reason.unplanned': 'fasi non ancora pianificate', 'reason.none': 'nessuna fase aperta',
  'common.save': 'Salva', 'common.add': 'Aggiungi', 'common.done': 'Fatto', 'common.reopen': 'Riapri', 'common.cancel': 'Annulla',
  'common.open': 'apri', 'common.close': 'chiudi', 'common.hide': 'Nascondi', 'common.show': 'Mostra', 'common.contributor': 'contributore',
  'common.from': 'dal {d}', 'common.urgent': 'urgente',
  'col.project': 'Progetto', 'col.phase': 'Fase', 'col.jira': 'Jira', 'col.nextDue': 'Prossima scad.', 'col.dataGaps': 'Dati mancanti',
  'col.mails': 'Mail', 'col.docs': 'Doc', 'col.myStatus': 'Mio stato', 'col.groupInto': 'Unisci epiche a', 'col.start': 'Inizio',
  'col.due': 'Scadenza', 'col.left': 'Residuo / stima', 'col.assignee': 'Assegnatario', 'col.subject': 'Oggetto',
  'col.fromTo': 'Da / a', 'col.last': 'Ultimo messaggio', 'col.document': 'Documento', 'col.where': 'Dove', 'col.status': 'Stato',
  'col.checked': 'Verificato',
  'dash.title': 'Dashboard', 'dash.lastSync': 'Ultima sync Claude: {d}', 'dash.noSync': 'Nessuna sync Claude',
  'dash.import': 'Importa snapshot', 'dash.imported': 'Importato', 'dash.importedWarn': 'Importato con {n} avvisi',
  'dash.nothing': 'Niente da importare', 'dash.backendDown': 'Backend non raggiungibile. "npm run dev" è attivo?',
  'kpi.projects': 'Progetti attivi', 'kpi.overdue': 'Fasi scadute', 'kpi.atRisk': 'A rischio (≤ 14 gg, residuo alto)',
  'kpi.mail': 'Mail da rispondere', 'kpi.docs': 'Documenti mancanti', 'kpi.unchecked': '{n} da verificare',
  'dash.projects': 'Progetti', 'dash.claudeSuggests': 'Claude suggerisce: {s}',
  'dash.noProjects': 'Nessun progetto. Vengono creati dalle epiche Jira alla prima sync di Claude.',
  'dash.dueBy': 'In scadenza entro il {d} (e scadute)', 'dash.onlyMine': 'solo mie', 'dash.hoursLeft': '{h}h residue',
  'dash.ofHours': 'su {h}h', 'dash.openSubtasks': 'Aperti: {n} sotto-task — {s}',
  'dash.nothingDue': 'Niente in scadenza. Le fasi arrivano da Jira con la sync di Claude.',
  'today.title': 'Attività di oggi', 'today.titleFor': 'Attività di {d}',
  'today.load': '{a}h di attività + {m}h di riunioni su {c}h', 'today.none': 'Nessuna attività pianificata in Jira per questa giornata.',
  'today.dueToday': 'scade oggi', 'today.hours': '{h}h oggi', 'today.noEstimate': 'senza stima', 'today.due': 'scad. {d}',
  'today.weekend': 'Oggi è weekend: pianificazione di {d}.',
  'today.showIdle': '+ {n} fasi aperte senza ore residue (da chiudere in Jira?)', 'today.hideIdle': 'nascondi le fasi senza ore residue',
  'meet.title': 'Riunioni di oggi', 'meet.titleFor': 'Riunioni di {d}', 'meet.none': 'Nessuna riunione in calendario.',
  'meet.noSync': 'Calendario non ancora sincronizzato: lancia la sync.', 'meet.join': 'Partecipa',
  'meet.organizer': 'organizzata da {n}', 'meet.you': 'organizzata da te', 'meet.tentative': 'provvisoria', 'meet.allDay': 'tutto il giorno',
  'proj.title': 'Progetti', 'proj.showHidden': 'mostra nascosti',
  'proj.help': 'Ogni epica Jira diventa un progetto. Per unire più epiche (es. epica cliente + epica "Tecnica") scegli la destinazione in "Unisci epiche a". Con "Gruppo" organizzi i progetti in gruppi tuoi. Nascondi i progetti che non vuoi in dashboard.',
  'proj.empty': 'Nessun progetto: lancia la sync di Claude.',
  'pd.notFound': 'Progetto non trovato o backend non raggiungibile.', 'pd.back': 'Torna ai progetti', 'pd.pm': 'PM',
  'pd.spFolder': 'Cartella SharePoint', 'pd.hide': 'Nascondi progetto', 'pd.show': 'Mostra progetto',
  'pd.phases': 'Fasi (Jira) · corrente: {p}', 'pd.open': 'Aperti:', 'pd.noPhases': 'Nessuna fase Jira aperta.',
  'pd.myView': 'La mia vista', 'pd.status': 'Stato', 'pd.phaseOverride': 'Fase (forzata)', 'pd.phasePh': 'vuoto = da Jira',
  'pd.note': 'Nota PM', 'pd.saved': 'Salvato alle {t}', 'pd.other': 'Altre scadenze', 'pd.newPh': 'es. SAL con il cliente',
  'pd.mail': 'Mail', 'pd.noMail': 'Nessun thread aperto per questo progetto.', 'pd.docs': 'Documentazione',
  'mail.title': 'Mail', 'mail.cat.needs_reply': 'da rispondere', 'mail.cat.waiting': 'in attesa', 'mail.cat.fyi': 'per info',
  'mail.tab.needs_reply': 'Devo rispondere', 'mail.tab.waiting': 'In attesa di altri', 'mail.tab.fyi': 'Per info',
  'mail.snooze': 'Posticipa 3 gg', 'mail.lastMe': 'ultimo: io',
  'mail.empty': 'Niente qui. I thread arrivano da Outlook a ogni sync di Claude.',
  'docs.title': 'Documentazione', 'docs.full': 'checklist completa',
  'docs.help': 'Una tessera per progetto: in rosso i documenti dovuti e non trovati, in giallo quelli trovati per la prima volta o aggiornati dopo il tuo Ok. Claude cerca in SharePoint › Delivery › Progetti Clienti › cliente › anno › progetto con la sync che include la documentazione. Apri una tessera per confermare (Ok) o segnare come non necessario.',
  'docs.empty': 'Nessun progetto con checklist documentale.', 'docs.phaseUnknown': 'fase sconosciuta',
  'doc.status.missing': 'mancante', 'doc.status.present': 'presente', 'doc.status.outdated': 'obsoleto', 'doc.status.unknown': 'da verificare',
  'doc.notNeeded': 'Non necessario', 'doc.restore': 'Ripristina', 'doc.waived': 'non necessario', 'doc.dueFrom': 'dovuto da: {p}',
  'doc.nextPhase': 'fase successiva', 'doc.add': 'Aggiungi documento',
  'dlg.title': 'Aggiungi documento', 'dlg.project': 'Progetto', 'dlg.docTitle': 'Titolo del documento', 'dlg.titlePh': 'es. Specifica tecnica',
  'dlg.phase': 'Fase che lo produce', 'dlg.requiredFrom': 'Richiesto dalla fase', 'dlg.defaultNext': '(fase successiva)',
  'dlg.repo': 'Dove si trova', 'dlg.location': 'Indicazione posizione', 'dlg.locationPh': 'es. 3. Analisi',
  'dlg.link': 'Link (se esiste già)', 'dlg.linkHelp': 'Con un link il documento risulta già presente.',
  'dlg.missing': 'Titolo e progetto sono obbligatori.', 'dlg.exists': 'Questo documento esiste già per il progetto.',
  'dlg.choose': '— scegli —',
  'sync.mode.daily': 'Jira + mail + calendario', 'sync.mode.docs': 'Jira + mail + calendario + documenti', 'sync.mode.jira': 'Solo Jira',
  'sync.now': 'Sincronizza ora', 'sync.running': 'Sincronizzazione…', 'sync.state.running': 'Sync in corso…',
  'sync.state.ok': 'Sync completata', 'sync.state.error': 'Sync fallita', 'sync.notImported': 'Nessun nuovo snapshot importato.',
  'sync.denied': 'Strumenti negati (aggiungili a .claude/settings.json se servono): {l}',
  'sync.deniedInfo': 'Claude ha provato comandi non pre-approvati e ha proseguito senza: {l}',
  'sync.unavailable': 'Claude Code non trovato su questo PC', 'sync.tooltip': 'Esegue la skill pjm-sync con Claude Code ({v})',
  'sync.startError': 'Impossibile avviare la sync',
  'sync.step.start': 'Avvio di Claude Code', 'sync.step.skill': 'Caricamento skill pjm-sync', 'sync.step.jiraUser': 'Jira: identificazione',
  'sync.step.jira': 'Jira: lettura epiche e fasi', 'sync.step.confluence': 'Confluence: documentazione di prodotto',
  'sync.step.calendar': 'Outlook: calendario', 'sync.step.mail': 'Outlook: lettura mail',
  'sync.step.sharepoint': 'SharePoint: documenti di progetto', 'sync.step.build': 'Costruzione dello snapshot',
  'sync.step.write': 'Scrittura file di lavoro', 'sync.step.read': "Lettura file dell'app",
};

const EN: Dict = {
  'nav.dashboard': 'Dashboard', 'nav.projects': 'Projects', 'nav.mail': 'Mail to answer', 'nav.docs': 'Documentation',
  'lang.label': 'Language',
  'nav.syncing': 'Sync running…', 'common.on': 'On', 'common.off': 'Off',
  'auto.title': "Today's sync", 'auto.help': 'First opening today: Claude is updating the web app. You can close this window; the sync keeps running in the background.', 'common.closeCap': 'Close',
  'auto.closeHelp': 'Close: the sync keeps running in the background', 'set.sync': 'Sync',
  'set.auto': 'Sync on the first opening of the day', 'set.autoHelp': 'Runs "Sync now" the first time you open the web app each day (unless a sync already ran today).',
  'set.autoDocsMonday': 'include documentation on Mondays', 'set.importHelp': 'Imports data/inbox/snapshot.json by hand (normally automatic).',
  'docs.totMissing': '{n} missing', 'docs.totAttention': '{n} to confirm', 'docs.okOf': '{ok} of {n} ok',
  'docs.missing': 'missing', 'docs.attention': 'to confirm', 'docs.noFolderShort': 'folder not found',
  'docs.noFolder': 'Project folder not found (Delivery › Progetti Clienti › client › year)',
  'doc.okHelp': 'The document is there and fine', 'doc.okUndo': 'Remove the confirmation', 'doc.modified': 'modified {d}',
  'doc.notFoundIn': 'Not found in the', 'doc.expectedIn': 'To be looked for in the', 'doc.projectFolder': 'project folder',
  'doc.expected': 'expected in: {h}', 'doc.notDueYet': 'not due yet',
  'doc.state.ok': 'Ok', 'doc.state.new': 'New', 'doc.state.updated': 'Updated', 'doc.state.missing': 'Missing',
  'doc.state.unchecked': 'Not checked', 'doc.state.waived': 'Not needed', 'kpi.attention': '{n} to confirm',
  'nav.settings': 'Settings',
  'set.title': 'Settings', 'set.appearance': 'Appearance', 'set.language': 'Language',
  'set.languageHelp': "Language of the interface and of Claude's reports.",
  'set.theme': 'Theme', 'set.themeHelp': 'The dark theme is easier on the eyes. "System" follows Windows.',
  'set.theme.light': 'Light', 'set.theme.dark': 'Dark', 'set.theme.system': 'System',
  'set.claude': 'Claude', 'set.claudeHelp': 'Claude Code used by "Sync now" on this PC.',
  'set.lastSync': 'Last sync', 'set.lastSyncHelp': 'Last snapshot imported into the web app.',
  'grp.title': 'Groups', 'grp.new': 'New group', 'grp.edit': 'Edit group', 'grp.delete': 'Delete group',
  'grp.name': 'Name', 'grp.namePh': 'e.g. Retail clients', 'grp.color': 'Colour', 'grp.none': 'No group',
  'grp.all': 'All groups', 'grp.nameRequired': 'Enter a name.', 'grp.exists': 'A group with this name already exists.',
  'grp.confirmDelete': 'Delete the group "{name}"? Its projects are kept, ungrouped.',
  'col.group': 'Group',
  'proj.mergeHelp': "Merges this project's epics into another project (not the same as groups).",
  'rag.red': 'Critical', 'rag.amber': 'Warning', 'rag.green': 'Ok', 'rag.grey': 'n/a',
  'flag.overdue': 'overdue', 'flag.at_risk': 'at risk', 'flag.missing_due': 'no due date',
  'flag.missing_start': 'no start date', 'flag.missing_estimate': 'no estimate',
  'reason.overdue': '{n} phase(s) overdue', 'reason.atRisk': '{n} phase(s) at risk', 'reason.ok': '{n} open phase(s) on track',
  'reason.unplanned': 'phases not planned yet', 'reason.none': 'no open phases',
  'common.save': 'Save', 'common.add': 'Add', 'common.done': 'Done', 'common.reopen': 'Reopen', 'common.cancel': 'Cancel',
  'common.open': 'open', 'common.close': 'close', 'common.hide': 'Hide', 'common.show': 'Show', 'common.contributor': 'contributor',
  'common.from': 'from {d}', 'common.urgent': 'urgent',
  'col.project': 'Project', 'col.phase': 'Phase', 'col.jira': 'Jira', 'col.nextDue': 'Next due', 'col.dataGaps': 'Data gaps',
  'col.mails': 'Mails', 'col.docs': 'Docs', 'col.myStatus': 'My status', 'col.groupInto': 'Merge epics into', 'col.start': 'Start',
  'col.due': 'Due', 'col.left': 'Left / est.', 'col.assignee': 'Assignee', 'col.subject': 'Subject',
  'col.fromTo': 'From / to', 'col.last': 'Last message', 'col.document': 'Document', 'col.where': 'Where', 'col.status': 'Status',
  'col.checked': 'Checked',
  'dash.title': 'Dashboard', 'dash.lastSync': 'Last Claude sync: {d}', 'dash.noSync': 'No Claude sync yet',
  'dash.import': 'Import snapshot', 'dash.imported': 'Imported', 'dash.importedWarn': 'Imported with {n} warning(s)',
  'dash.nothing': 'Nothing to import', 'dash.backendDown': 'Backend not reachable. Is "npm run dev" running?',
  'kpi.projects': 'Active projects', 'kpi.overdue': 'Overdue phases', 'kpi.atRisk': 'At risk (≤ 14 days, high remaining)',
  'kpi.mail': 'Mails to answer', 'kpi.docs': 'Missing documents', 'kpi.unchecked': '{n} not checked',
  'dash.projects': 'Projects', 'dash.claudeSuggests': 'Claude suggests: {s}',
  'dash.noProjects': 'No projects yet. They are created from your Jira epics at the first Claude sync.',
  'dash.dueBy': 'Due by {d} (and overdue)', 'dash.onlyMine': 'only mine', 'dash.hoursLeft': '{h}h left',
  'dash.ofHours': 'of {h}h', 'dash.openSubtasks': 'Open: {n} sub-task(s) — {s}',
  'dash.nothingDue': 'Nothing due. Phases arrive from Jira via the Claude sync.',
  'today.title': "Today's activities", 'today.titleFor': 'Activities for {d}',
  'today.load': '{a}h of activities + {m}h of meetings out of {c}h', 'today.none': 'No activities planned in Jira for this day.',
  'today.dueToday': 'due today', 'today.hours': '{h}h today', 'today.noEstimate': 'no estimate', 'today.due': 'due {d}',
  'today.weekend': "It's the weekend: planning for {d}.",
  'today.showIdle': '+ {n} open phase(s) with no hours left (close them in Jira?)', 'today.hideIdle': 'hide phases with no hours left',
  'meet.title': "Today's meetings", 'meet.titleFor': 'Meetings on {d}', 'meet.none': 'No meetings in the calendar.',
  'meet.noSync': 'Calendar not synced yet: run a sync.', 'meet.join': 'Join',
  'meet.organizer': 'organized by {n}', 'meet.you': 'organized by you', 'meet.tentative': 'tentative', 'meet.allDay': 'all day',
  'proj.title': 'Projects', 'proj.showHidden': 'show hidden',
  'proj.help': 'One project is created per Jira epic. To group several epics (e.g. a client epic and its "Tecnica" epic) pick the target in "Merge epics into". Use "Group" to organise projects into your own groups. Hide projects you don\'t want on the dashboard.',
  'proj.empty': 'No projects yet — run the Claude sync.',
  'pd.notFound': 'Project not found or backend not reachable.', 'pd.back': 'Back to projects', 'pd.pm': 'PM',
  'pd.spFolder': 'SharePoint folder', 'pd.hide': 'Hide project', 'pd.show': 'Show project',
  'pd.phases': 'Phases (Jira) · current: {p}', 'pd.open': 'Open:', 'pd.noPhases': 'No open Jira phases.',
  'pd.myView': 'My view', 'pd.status': 'Status', 'pd.phaseOverride': 'Phase override', 'pd.phasePh': 'empty = from Jira',
  'pd.note': 'PM note', 'pd.saved': 'Saved at {t}', 'pd.other': 'Other deadlines', 'pd.newPh': 'e.g. SAL with the client',
  'pd.mail': 'Mail', 'pd.noMail': 'No open threads for this project.', 'pd.docs': 'Documentation',
  'mail.title': 'Mail', 'mail.cat.needs_reply': 'needs reply', 'mail.cat.waiting': 'waiting', 'mail.cat.fyi': 'FYI',
  'mail.tab.needs_reply': 'Needs my reply', 'mail.tab.waiting': 'Waiting on others', 'mail.tab.fyi': 'FYI',
  'mail.snooze': 'Snooze 3d', 'mail.lastMe': 'last: me',
  'mail.empty': 'Nothing here. Threads arrive from Outlook with each Claude sync.',
  'docs.title': 'Documentation', 'docs.full': 'full checklist',
  'docs.help': 'One tile per project: red = documents due and not found, yellow = found for the first time or updated after your Ok. Claude looks in SharePoint › Delivery › Progetti Clienti › client › year › project with the sync that includes documentation. Open a tile to confirm (Ok) or mark as not needed.',
  'docs.empty': 'No project with a documentation checklist.', 'docs.phaseUnknown': 'phase unknown',
  'doc.status.missing': 'missing', 'doc.status.present': 'present', 'doc.status.outdated': 'outdated', 'doc.status.unknown': 'not checked',
  'doc.notNeeded': 'Not needed', 'doc.restore': 'Restore', 'doc.waived': 'not needed', 'doc.dueFrom': 'due from: {p}',
  'doc.nextPhase': 'next phase', 'doc.add': 'Add document',
  'dlg.title': 'Add a document', 'dlg.project': 'Project', 'dlg.docTitle': 'Document title', 'dlg.titlePh': 'e.g. Technical specification',
  'dlg.phase': 'Phase that produces it', 'dlg.requiredFrom': 'Required from phase', 'dlg.defaultNext': '(next phase)',
  'dlg.repo': 'Repository', 'dlg.location': 'Location hint', 'dlg.locationPh': 'e.g. 3. Analisi',
  'dlg.link': 'Link (if it already exists)', 'dlg.linkHelp': 'With a link the document is marked as present.',
  'dlg.missing': 'Title and project are required.', 'dlg.exists': 'This document already exists for the project.',
  'dlg.choose': '— choose —',
  'sync.mode.daily': 'Jira + mail + calendar', 'sync.mode.docs': 'Jira + mail + calendar + docs', 'sync.mode.jira': 'Jira only',
  'sync.now': 'Sync now', 'sync.running': 'Syncing…', 'sync.state.running': 'Sync running…',
  'sync.state.ok': 'Sync finished', 'sync.state.error': 'Sync failed', 'sync.notImported': 'No new snapshot was imported.',
  'sync.denied': 'Tools denied (add them to .claude/settings.json if needed): {l}',
  'sync.deniedInfo': 'Claude tried commands that are not pre-approved and carried on without them: {l}',
  'sync.unavailable': 'Claude Code not found on this machine', 'sync.tooltip': 'Runs the pjm-sync skill with Claude Code ({v})',
  'sync.startError': 'Could not start the sync',
  'sync.step.start': 'Starting Claude Code', 'sync.step.skill': 'Loading the pjm-sync skill', 'sync.step.jiraUser': 'Jira: identifying you',
  'sync.step.jira': 'Jira: reading epics and phases', 'sync.step.confluence': 'Confluence: product documentation',
  'sync.step.calendar': 'Outlook: calendar', 'sync.step.mail': 'Outlook: reading mail',
  'sync.step.sharepoint': 'SharePoint: project documents', 'sync.step.build': 'Building the snapshot',
  'sync.step.write': 'Writing working files', 'sync.step.read': 'Reading app files',
};

const DICTS: Record<Lang, Dict> = { it: IT, en: EN };
const STORAGE_KEY = 'pjm.lang';

/** Runtime translations (Italian by default). The choice is remembered in this browser. */
@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<Lang>(I18n.stored());
  /** Locale id for Angular pipes (DatePipe etc.). */
  readonly locale = computed(() => (this.lang() === 'en' ? 'en-GB' : 'it'));

  private static stored(): Lang {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'it';
    } catch {
      return 'it';
    }
  }

  setLang(lang: Lang) {
    this.lang.set(lang);
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* storage unavailable: keep the choice for this session only */
    }
  }

  t(key: string, params?: Record<string, unknown>): string {
    const text = DICTS[this.lang()][key] ?? DICTS.en[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? '')) : text;
  }
}

/** {{ 'key' | t }} or {{ 'key' | t: { n: 3 } }} — impure so it follows language changes. */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(key: string, params?: Record<string, unknown>): string {
    return this.i18n.t(key, params);
  }
}

/** Human reason for a project's Jira status, from its counters. */
export function jiraReason(i18n: I18n, p: { jiraRag: string; overdue: number; atRisk: number; openPhases: number }): string {
  if (p.overdue) return i18n.t('reason.overdue', { n: p.overdue }) + (p.atRisk ? `, ${i18n.t('reason.atRisk', { n: p.atRisk })}` : '');
  if (p.atRisk) return i18n.t('reason.atRisk', { n: p.atRisk });
  if (p.jiraRag === 'grey') return i18n.t(p.openPhases ? 'reason.unplanned' : 'reason.none');
  return i18n.t('reason.ok', { n: p.openPhases });
}
