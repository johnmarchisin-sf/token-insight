// Aggregate file-level Read tool calls across sessions.
//
// The angle: when Claude reads the same file 15 times in a session, that file
// is a strong candidate for inclusion in CLAUDE.md (so it's cached and loaded
// once) or for a hook that pre-fetches it. Files repeatedly read across many
// sessions are workspace-level context that's currently being paid for at
// retail every time.

import { promises as fs } from 'node:fs';
import { Session } from './types.js';

export interface FileReadStat {
  filePath: string;
  workspaces: string[];
  totalReads: number;
  sessionCount: number;
  readsPerSessionAvg: number;
  maxReadsInOneSession: number;
  fileSize?: number;        // bytes, if currently exists
  fileExists?: boolean;
}

/** READ-like tools we treat as "looked at this file". */
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

export async function aggregateFileReads(
  sessions: Session[],
  opts: { topN?: number; minReads?: number } = {}
): Promise<FileReadStat[]> {
  const topN = opts.topN ?? 30;
  const minReads = opts.minReads ?? 5;

  // path -> { sessionId -> count }
  const byPath = new Map<string, Map<string, { count: number; workspace: string }>>();

  for (const s of sessions) {
    for (const turn of s.turns) {
      if (!turn.toolCalls) continue;
      for (const call of turn.toolCalls) {
        if (!READ_TOOLS.has(call.name)) continue;
        const fp = String(call.input?.file_path ?? '').trim();
        if (!fp) continue;
        if (!byPath.has(fp)) byPath.set(fp, new Map());
        const inner = byPath.get(fp)!;
        const existing = inner.get(s.sessionId);
        if (existing) {
          existing.count += 1;
        } else {
          inner.set(s.sessionId, { count: 1, workspace: s.workspaceName });
        }
      }
    }
  }

  const stats: FileReadStat[] = [];
  for (const [filePath, inner] of byPath) {
    let total = 0;
    let max = 0;
    const workspaces = new Set<string>();
    for (const { count, workspace } of inner.values()) {
      total += count;
      if (count > max) max = count;
      workspaces.add(workspace);
    }
    if (total < minReads) continue;
    stats.push({
      filePath,
      workspaces: [...workspaces].sort(),
      totalReads: total,
      sessionCount: inner.size,
      readsPerSessionAvg: total / inner.size,
      maxReadsInOneSession: max,
    });
  }

  stats.sort((a, b) => b.totalReads - a.totalReads);
  const top = stats.slice(0, topN);

  // Stat the files on disk to get current size + existence.
  await Promise.all(
    top.map(async (s) => {
      try {
        const st = await fs.stat(s.filePath);
        s.fileExists = st.isFile();
        s.fileSize = st.size;
      } catch {
        s.fileExists = false;
      }
    })
  );

  return top;
}

/**
 * Files that are read at least N times per session on average — strong
 * candidates for an @-import in CLAUDE.md so they're cached, not re-read.
 */
export function rereadCandidates(stats: FileReadStat[], minAvg = 3): FileReadStat[] {
  return stats.filter((s) => s.readsPerSessionAvg >= minAvg && s.sessionCount >= 2);
}
