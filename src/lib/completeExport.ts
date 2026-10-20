export const EXPORT_PAGE_SIZE = 250;
export const EXPORT_MAX_ROWS = 10_000;

export interface CursorPage<T, Cursor> {
  items: T[];
  nextCursor: Cursor | null;
}

export interface CollectedPages<T> {
  items: T[];
  truncated: boolean;
}

export async function collectCursorPages<T, Cursor>(
  fetchPage: (cursor: Cursor | null, pageSize: number) => Promise<CursorPage<T, Cursor>>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<CollectedPages<T>> {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  const maxRows = options.maxRows ?? EXPORT_MAX_ROWS;
  const items: T[] = [];
  let cursor: Cursor | null = null;

  while (items.length < maxRows) {
    const remaining = maxRows - items.length;
    const requestedSize = Math.min(pageSize, remaining);
    const page = await fetchPage(cursor, requestedSize);
    items.push(...page.items.slice(0, requestedSize));
    if (page.items.length < requestedSize || page.nextCursor === null) {
      return { items, truncated: false };
    }
    cursor = page.nextCursor;
  }

  return { items, truncated: true };
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function downloadCsvFile(filename: string, rows: unknown[][]): void {
  const content = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
