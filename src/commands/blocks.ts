import { loadAllSessions } from '../core/jsonl-loader.js';
import { computeBlocks, activeBlock, projectActive, peakInLookback } from '../core/blocks.js';
import {
  fmtTokens,
  fmtDuration,
  fmtTokensPerMin,
  fmtPct,
  progressBar,
  bold,
  dim,
  warn,
  danger,
  table,
} from './format.js';

export interface BlocksOpts {
  json?: boolean;
  recent?: number;
  lookbackDays?: number;
}

export async function runBlocks(opts: BlocksOpts): Promise<void> {
  const sessions = await loadAllSessions();
  const blocks = computeBlocks(sessions);
  const active = activeBlock(blocks);
  const projection = projectActive(active, blocks, opts.lookbackDays ?? 30);
  const peak = peakInLookback(blocks, opts.lookbackDays ?? 30);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          active,
          projection,
          peakRecent: peak,
          recentBlocks: blocks.slice(-(opts.recent ?? 14)).reverse(),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  console.log(bold('5-hour usage windows'));
  console.log(
    dim(`Self-derived ceiling: ${fmtTokens(peak)} (max in any window over last ${opts.lookbackDays ?? 30} days)`)
  );
  console.log();

  if (active && projection) {
    const elapsed = fmtDuration(projection.elapsedMs);
    const remaining = fmtDuration(projection.remainingMs);
    const elapsedPct = projection.elapsedMs / (projection.elapsedMs + projection.remainingMs);

    console.log(bold('Active window'));
    console.log(`  started ${active.startedAt.toLocaleTimeString()}  ${dim(`(${elapsed} elapsed, ${remaining} left)`)}`);
    console.log(`  time:    ${progressBar(elapsedPct)} ${fmtPct(elapsedPct)}`);

    const usePct = projection.pctOfPeak;
    const projPct = projection.pctOfPeakProjected;
    const useColor = usePct > 0.9 ? danger : usePct > 0.7 ? warn : (s: string) => s;
    const projColor = projPct > 1.1 ? danger : projPct > 0.9 ? warn : (s: string) => s;

    console.log(
      `  used:    ${progressBar(usePct)} ${useColor(fmtTokens(active.totalTokens))} ${dim(`(${fmtPct(usePct)} of peak)`)}`
    );
    console.log(
      `  velocity: ${fmtTokensPerMin(projection.velocityTokensPerMin)}  ` +
        `projected total: ${projColor(fmtTokens(projection.projectedTotal))} ${dim(`(${fmtPct(projPct)} of peak)`)}`
    );
    console.log(
      dim(`  workspaces this window: ${active.workspaces.join(', ') || '(none)'}`)
    );
    if (projPct > 1.0) {
      console.log();
      console.log(warn(`At current pace you'll exceed your recent peak before this window closes.`));
    }
    console.log();
  } else {
    console.log(dim('No active window — your last 5h window has closed.'));
    console.log();
  }

  const recent = blocks.slice(-(opts.recent ?? 14)).reverse();
  if (recent.length === 0) {
    console.log(dim('No usage windows recorded yet.'));
    return;
  }
  console.log(bold('Recent windows'));
  console.log(
    table(
      recent.map((b) => ({
        started: b.startedAt.toLocaleString(),
        duration: fmtDuration(b.lastActivityAt.getTime() - b.startedAt.getTime()),
        tokens: fmtTokens(b.totalTokens),
        'vs peak': peak > 0 ? fmtPct(b.totalTokens / peak) : '—',
        turns: String(b.turnCount),
        workspaces: b.workspaces.slice(0, 3).join(', ') + (b.workspaces.length > 3 ? `, +${b.workspaces.length - 3}` : ''),
        live: b.isActive ? 'yes' : '',
      })),
      ['started', 'duration', 'tokens', 'vs peak', 'turns', 'workspaces', 'live']
    )
  );
}
