// Plain-text helpers for `reflex report`: counting, percentiles and aligned tables. Pure.

export function countBy<T>(items: readonly T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Nearest-rank percentile (p in 0..100) of an unsorted list; null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);
export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
export const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : sum(values) / values.length);

export const pct = (part: number, whole: number): string => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`);
export const int = (n: number | null): string => (n === null ? "-" : Math.round(n).toLocaleString("en-US"));
export const ms = (n: number | null): string => (n === null ? "-" : `${Math.round(n).toLocaleString("en-US")} ms`);
export const usd = (n: number): string => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/** Aligned columns: the first column left-aligned, the rest right-aligned, two spaces between columns, each line indented. */
export function table(rows: readonly (readonly string[])[], indent = "  "): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => indent + r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  ").trimEnd());
}
