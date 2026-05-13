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
import {
  loadConfig,
  addDenylistEntry,
  removeDenylistEntry,
} from '../core/config.js';
import { buildSkillScaffold } from '../core/skill-scaffold.js';
import { loadSkillCatalog } from '../core/skill-catalog.js';

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

  app.use(express.json());
  app.use(express.static(publicDir));

  // Lightweight in-memory cache so the dashboard feels snappy when you click
  // around. Active-window data is the only thing that changes minute-to-minute,
  // so we use a short TTL.
  let cache: { ts: number; data: any } | null = null;
  const TTL_MS = 10_000;

  function invalidateCache(): void {
    cache = null;
  }

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
    const workspacePaths = [...new Set(sessions.map((s) => s.workspacePath))];
    const [contextReports, globalContext, fileReads, config, skillCatalog] = await Promise.all([
      inspectAllWorkspaces(sessions),
      inspectGlobal(),
      aggregateFileReads(sessions),
      loadConfig(),
      loadSkillCatalog(workspacePaths),
    ]);
    const recommendations = buildRecommendations({
      sessions,
      clusters,
      contextReports,
      globalContext,
      fileReads,
      denylist: config.clusterDenylist,
      skillCatalog,
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
      denylist: config.clusterDenylist,
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

  app.post('/api/cluster/:id/deny', async (req, res) => {
    const { id } = req.params;
    const reason = req.body && (req.body as any).reason;
    if (reason !== 'denied' && reason !== 'created') {
      res.status(400).json({ error: 'reason must be "denied" or "created"' });
      return;
    }
    try {
      const data = await getReport();
      const cluster = (data.clusters as any[]).find((c) => c.id === id);
      if (!cluster) {
        res.status(404).json({ error: `cluster ${id} not found` });
        return;
      }
      await addDenylistEntry({
        id: cluster.id,
        reason,
        repExcerpt: String(cluster.representative).slice(0, 200),
        trigrams: cluster.trigrams,
        addedAt: new Date().toISOString(),
      });
      invalidateCache();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/cluster/:id/deny', async (req, res) => {
    try {
      const removed = await removeDenylistEntry(req.params.id);
      invalidateCache();
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/cluster/:id/scaffold', async (req, res) => {
    try {
      const data = await getReport();
      const cluster = (data.clusters as any[]).find((c) => c.id === req.params.id);
      if (!cluster) {
        res.status(404).json({ error: `cluster ${req.params.id} not found` });
        return;
      }
      const scaffold = buildSkillScaffold(cluster);
      res.json(scaffold);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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
