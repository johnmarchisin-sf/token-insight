// Tiny formatting helpers for terminal output. No color libs to keep deps minimal.

export function fmtCost(n: number): string {
  if (n < 0.005) return '$0.00';
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtInt(n: number): string {
  return n.toLocaleString();
}

export function table(rows: Array<Record<string, string>>, headers?: string[]): string {
  if (rows.length === 0) return '(no rows)';
  const cols = headers ?? Object.keys(rows[0]);
  const widths: Record<string, number> = {};
  for (const c of cols) widths[c] = c.length;
  for (const r of rows) {
    for (const c of cols) {
      const v = r[c] ?? '';
      if (v.length > widths[c]) widths[c] = v.length;
    }
  }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines: string[] = [];
  lines.push(cols.map((c) => pad(c, widths[c])).join('  '));
  lines.push(cols.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const r of rows) {
    lines.push(cols.map((c) => pad(r[c] ?? '', widths[c])).join('  '));
  }
  return lines.join('\n');
}

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

export function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

export function warn(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

export function danger(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtTokensPerMin(n: number): string {
  return `${fmtTokens(Math.round(n))}/min`;
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function progressBar(pct: number, width = 24): string {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
