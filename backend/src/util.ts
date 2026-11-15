const JSON_COLUMNS = new Set(['jira_keys', 'mail_keywords', 'mail_domains', 'counts', 'warnings', 'open_subtasks', 'flags']);
const BOOL_COLUMNS = new Set(['active', 'last_from_me', 'waived', 'mine', 'assigned_to_me', 'from_template']);

/** Converts a snake_case DB row into the camelCase JSON the frontend expects. */
export function toApi<T = Record<string, unknown>>(row: unknown): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    let v = value;
    if (JSON_COLUMNS.has(key) && typeof v === 'string') v = JSON.parse(v);
    else if (BOOL_COLUMNS.has(key)) v = Boolean(v);
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as T;
}

export const toApiList = <T = Record<string, unknown>>(rows: unknown[]): T[] => rows.map((r) => toApi<T>(r));

export const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
