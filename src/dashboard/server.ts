import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import openBrowser from 'open';
import { loadAllSessions } from '../core/jsonl-loader.js';
import {
  byWorkspace,
  byWorkspaceGroup,
  byDay,
  byModel,
  totalsAcross,
} from '../core/aggregator.js';
import { detectWaste } from '../core/waste-detector.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import {
  computeBlocks,
  activeBlock,
  projectActive,
  peakInLookback,
} from '../core/blocks.js';
import { byHourOfDay, byDayHour } from '../core/time-of-day.js';
import { inspectAllWorkspaces, inspectGlobal } from '../core/context-inspector.js';
import { aggregateFileReads } from '../core/file-reads.js';
import { buildRecommendations } from '../core/recommendations.js';

export interface ServerOptions {
  port: number;
  open: boolean;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = express();
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Resolve the static asset directory across dev (tsx running src/) and
  // production (node running dist/). Try the colocated `public/` first, then
  // fall back to src/.
  const candidates = [
    path.join(here, 'public'),
    path.join(here, '..', '..', 'src', 'dashboard', 'public'),
  ];
  const publicDir = candidates.find((p) => existsSync(p));
  if (!publicDir) {
    throw new Error(
      `Dashboard assets not found. Tried:\n  ${candidates.join('\n  ')}`
    );
  }

  app.use(express.static(publicDir));

  // Lightweight in-memory cache so the dashboard feels snappy when you click
  // around. Active-window data is the only thing that changes minute-to-minute,
  // so we use a short TTL.
  let cache: { ts: number; data: any } | null = null;
  const TTL_MS = 10_000;

  async function getReport() {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.data;
    const sessions = await loadAllSessions();
    const blocks = computeBlocks(sessions);
    const active = activeBlock(blocks);
    const projection = projectActive(active, blocks, 30);
    const peakRecent = peakInLookback(blocks, 30);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = sessions.filter((s) => s.endedAt >= startOfToday);

    const clusters = clusterPrompts(sessions, { topN: 25 });
    const [contextReports, globalContext, fileReads] = await Promise.all([
      inspectAllWorkspaces(sessions),
      inspectGlobal(),
      aggregateFileReads(sessions),
    ]);
    const recommendations = buildRecommendations({
      sessions,
      clusters,
      contextReports,
      globalContext,
      fileReads,
    });

    const data = {
      generatedAt: new Date().toISOString(),
      totals: totalsAcross(sessions),
      todayTotals: totalsAcross(today),
      byDay: byDay(sessions),
      byWorkspace: byWorkspace(sessions),
      byGroup: byWorkspaceGroup(sessions),
      byModel: byModel(sessions),
      waste: detectWaste(sessions),
      clusters,
      sessionCount: sessions.length,
      activeBlock: active,
      activeProjection: projection,
      peakRecent,
      recentBlocks: blocks.slice(-14).reverse(),
      hourOfDay: byHourOfDay(sessions),
      dayHour: byDayHour(sessions),
      recommendations,
      contextReports,
      globalContext,
      fileReads,
    };
    cache = { ts: Date.now(), data };
    return data;
  }

  app.get('/api/report', async (_req, res) => {
    try {
      const data = await getReport();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.listen(opts.port, () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`token-insight dashboard listening at ${url}`);
    if (opts.open) {
      openBrowser(url).catch(() => {
        // Browser launch is best-effort; URL is logged above either way.
      });
    }
  });
}
