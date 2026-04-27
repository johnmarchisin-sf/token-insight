import { loadAllSessions } from '../core/jsonl-loader.js';
import { byWorkspace, byDay, totalsAcross } from '../core/aggregator.js';
import { fmtTokens, table, bold, dim } from './format.js';

export interface WeekOpts {
  json?: boolean;
  days?: number;
}

export async function runWeek(opts: WeekOpts): Promise<void> {
  const days = opts.days ?? 7;
  const end = new Date();
  const since = new Date(end.getTime() - days * 24 * 60 * 60_000);
  const sessions = await loadAllSessions({ since });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          windowDays: days,
          totals: totalsAcross(sessions),
          byWorkspace: byWorkspace(sessions),
          byDay: byDay(sessions),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const totals = totalsAcross(sessions);
  const days_ = byDay(sessions);
  const ws = byWorkspace(sessions);

  console.log(bold(`Last ${days} days`));
  console.log(
    `${fmtTokens(totals.totalTokens)} tokens  ` +
      dim(`(${totals.sessionCount} sessions across ${ws.length} workspaces)`)
  );
  if (sessions.length === 0) {
    console.log(dim('No sessions found.'));
    return;
  }
  console.log();
  console.log(bold('By day'));
  console.log(
    table(
      days_.map((b) => ({
        day: b.label,
        tokens: fmtTokens(b.totalTokens),
        sessions: String(b.sessionCount),
        turns: String(b.turnCount),
      })),
      ['day', 'tokens', 'sessions', 'turns']
    )
  );
  console.log();
  console.log(bold('By workspace'));
  console.log(
    table(
      ws.slice(0, 15).map((b) => ({
        workspace: b.label,
        tokens: fmtTokens(b.totalTokens),
        sessions: String(b.sessionCount),
      })),
      ['workspace', 'tokens', 'sessions']
    )
  );
  if (ws.length > 15) {
    console.log(dim(`...and ${ws.length - 15} more workspaces`));
  }
}
