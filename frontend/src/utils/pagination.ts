/** Page size meaning "no paging": the whole list renders on a single page. */
export const ALL_PAGE_SIZE = 0;

export function pageCountOf(total: number, pageSize: number): number {
  if (pageSize <= ALL_PAGE_SIZE) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  if (pageSize <= ALL_PAGE_SIZE) return [...items];
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
