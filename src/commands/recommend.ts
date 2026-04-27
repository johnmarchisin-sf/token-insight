import { loadAllSessions } from '../core/jsonl-loader.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { inspectAllWorkspaces, inspectGlobal } from '../core/context-inspector.js';
import { aggregateFileReads } from '../core/file-reads.js';
import { buildRecommendations, Recommendation } from '../core/recommendations.js';
import { bold, dim, warn, danger } from './format.js';

export interface RecommendOpts {
  json?: boolean;
  days?: number;
  kind?: string;
}

export async function runRecommend(opts: RecommendOpts): Promise<void> {
  const since = opts.days ? new Date(Date.now() - opts.days * 24 * 60 * 60_000) : undefined;
  const sessions = await loadAllSessions(since ? { since } : {});
  const [contextReports, globalContext, fileReads] = await Promise.all([
    inspectAllWorkspaces(sessions),
    inspectGlobal(),
    aggregateFileReads(sessions),
  ]);
  const clusters = clusterPrompts(sessions, { topN: 25 });

  let recs = buildRecommendations({
    sessions,
    clusters,
    contextReports,
    globalContext,
    fileReads,
  });
  if (opts.kind) recs = recs.filter((r) => r.kind === opts.kind);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ count: recs.length, recommendations: recs }, null, 2) + '\n');
    return;
  }

  console.log(
    bold('Optimization recommendations') +
      (opts.days ? dim(` — last ${opts.days} days`) : dim(' — all time'))
  );
  console.log();
  if (recs.length === 0) {
    console.log(dim('No recommendations right now. Either you have very little usage history, or you have your house in order.'));
    return;
  }
  for (const r of recs) {
    console.log(`${severityBadge(r)} ${bold(r.title)}  ${dim(`[${r.kind}]`)}`);
    for (const line of r.body.split('\n')) console.log('   ' + line);
    if (r.action) console.log('   ' + dim('action: ') + r.action);
    console.log();
  }
}

function severityBadge(r: Recommendation): string {
  if (r.severity === 'high') return danger('●');
  if (r.severity === 'medium') return warn('●');
  return dim('●');
}
