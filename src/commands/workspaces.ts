import { loadAllSessions } from '../core/jsonl-loader.js';
import { byWorkspace, byWorkspaceGroup, totalsAcross } from '../core/aggregator.js';
import { fmtTokens, table, bold, dim } from './format.js';

export interface WorkspacesOpts {
  json?: boolean;
  days?: number;
  group?: boolean;
}

export async function runWorkspaces(opts: WorkspacesOpts): Promise<void> {
  const days = opts.days;
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60_000) : undefined;
  const sessions = await loadAllSessions(since ? { since } : {});

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          windowDays: days ?? 'all',
          totals: totalsAcross(sessions),
          byWorkspace: byWorkspace(sessions),
          byGroup: byWorkspaceGroup(sessions),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const totals = totalsAcross(sessions);
  console.log(
    bold(`Workspace breakdown` + (days ? ` (last ${days} days)` : ' (all time)'))
  );
  console.log(
    `${fmtTokens(totals.totalTokens)} tokens  ` +
      dim(`(${totals.sessionCount} sessions)`)
  );
  console.log();

  if (opts.group) {
    const groups = byWorkspaceGroup(sessions);
    console.log(
      table(
        groups.map((b) => ({
          group: b.label,
          tokens: fmtTokens(b.totalTokens),
          sessions: String(b.sessionCount),
        })),
        ['group', 'tokens', 'sessions']
      )
    );
    console.log();
  }

  const ws = byWorkspace(sessions);
  console.log(
    table(
      ws.map((b) => ({
        workspace: b.label,
        tokens: fmtTokens(b.totalTokens),
        sessions: String(b.sessionCount),
        turns: String(b.turnCount),
      })),
      ['workspace', 'tokens', 'sessions', 'turns']
    )
  );
}
