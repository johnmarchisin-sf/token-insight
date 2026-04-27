import { loadAllSessions } from '../core/jsonl-loader.js';
import { detectWaste } from '../core/waste-detector.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { byWorkspace, totalsAcross } from '../core/aggregator.js';
import { fmtTokens, table, bold, dim } from './format.js';

export interface AnalyzeOpts {
  json?: boolean;
  days?: number;
  workspace?: string;
  topClusters?: number;
}

export async function runAnalyze(opts: AnalyzeOpts): Promise<void> {
  const days = opts.days;
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60_000) : undefined;
  let sessions = await loadAllSessions(since ? { since } : {});
  if (opts.workspace) {
    sessions = sessions.filter((s) => s.workspaceName === opts.workspace);
  }

  const waste = detectWaste(sessions);
  const clusters = clusterPrompts(sessions, { topN: opts.topClusters ?? 15 });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          windowDays: days ?? 'all',
          workspace: opts.workspace ?? 'all',
          totals: totalsAcross(sessions),
          waste,
          clusters,
          byWorkspace: byWorkspace(sessions),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const totals = totalsAcross(sessions);
  console.log(
    bold(`Analysis` + (days ? ` — last ${days} days` : ' — all time') + (opts.workspace ? ` — ${opts.workspace}` : ''))
  );
  console.log(
    `${fmtTokens(totals.totalTokens)} tokens  ` +
      dim(`(${totals.sessionCount} sessions)`)
  );
  console.log();

  console.log(bold('High-usage sessions'));
  if (waste.length === 0) {
    console.log(dim('No flagged sessions.'));
  } else {
    console.log(
      table(
        waste.slice(0, 10).map((w) => ({
          workspace: w.workspaceName,
          when: w.startedAt.toISOString().slice(0, 16).replace('T', ' '),
          tokens: fmtTokens(w.totalTokens),
          why: w.reasons.join(', '),
        })),
        ['workspace', 'when', 'tokens', 'why']
      )
    );
    if (waste.length > 10) console.log(dim(`...and ${waste.length - 10} more flagged sessions`));
  }
  console.log();

  console.log(bold('Skill candidates (recurring prompt patterns)'));
  if (clusters.length === 0) {
    console.log(dim('No recurring patterns found yet — try a longer window.'));
  } else {
    console.log(
      table(
        clusters.map((c, i) => ({
          '#': String(i + 1),
          count: String(c.size),
          tokens: fmtTokens(c.totalTokens),
          example: truncate(c.representative, 80),
        })),
        ['#', 'count', 'tokens', 'example']
      )
    );
    console.log();
    console.log(dim('Use --json for the full prompt list per cluster.'));
  }
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}
