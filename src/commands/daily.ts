import { loadAllSessions } from '../core/jsonl-loader.js';
import { byWorkspace, totalsAcross } from '../core/aggregator.js';
import { fmtTokens, fmtCost, table, bold, dim } from './format.js';

export interface DailyOpts {
  json?: boolean;
  date?: string; // YYYY-MM-DD; defaults to today (local)
}

export async function runDaily(opts: DailyOpts): Promise<void> {
  const target = opts.date ? parseDate(opts.date) : startOfToday();
  const end = new Date(target.getTime() + 24 * 60 * 60_000);
  const sessions = await loadAllSessions({ since: target, until: end });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          date: target.toISOString().slice(0, 10),
          totals: totalsAcross(sessions),
          byWorkspace: byWorkspace(sessions),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const totals = totalsAcross(sessions);
  const ws = byWorkspace(sessions);

  console.log(bold(`Token usage for ${target.toISOString().slice(0, 10)}`));
  console.log(
    `${fmtTokens(totals.totalTokens)} tokens · ${fmtCost(totals.cost)}  ` +
      dim(`(${totals.sessionCount} sessions, ${totals.turnCount} turns)`)
  );
  if (ws.length === 0) {
    console.log(dim('No sessions found.'));
    return;
  }
  console.log();
  console.log(
    table(
      ws.map((b) => ({
        workspace: b.label,
        tokens: fmtTokens(b.totalTokens),
        cost: fmtCost(b.cost),
        sessions: String(b.sessionCount),
        turns: String(b.turnCount),
      })),
      ['workspace', 'tokens', 'cost', 'sessions', 'turns']
    )
  );
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}
