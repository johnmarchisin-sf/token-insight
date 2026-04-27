// Walk ~/.claude/projects/, parse each JSONL file into a Session.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import {
  RawJsonlEntry,
  Session,
  SessionTurn,
  Role,
  TokenUsage,
  ToolCall,
} from './types.js';
import { costForUsage } from './pricing.js';
import {
  decodeProjectDirName,
  defaultProjectsDir,
  groupForWorkspace,
  rollupNameForPath,
} from './workspace-mapper.js';

export interface LoadOptions {
  projectsDir?: string;
  since?: Date;
  until?: Date;
}

export async function loadAllSessions(opts: LoadOptions = {}): Promise<Session[]> {
  const root = opts.projectsDir ?? defaultProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Claude Code projects directory not found at ${root}. Have you used Claude Code yet?`
      );
    }
    throw err;
  }

  const sessions: Session[] = [];
  for (const dirName of projectDirs) {
    const dirPath = path.join(root, dirName);
    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const decoded = decodeProjectDirName(dirName);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      try {
        const session = await parseSessionFile(filePath, decoded);
        if (!session) continue;
        if (opts.since && session.endedAt < opts.since) continue;
        if (opts.until && session.startedAt > opts.until) continue;
        sessions.push(session);
      } catch (err) {
        // Skip unparseable files but log to stderr.
        process.stderr.write(`[token-insight] skipping ${filePath}: ${(err as Error).message}\n`);
      }
    }
  }
  return sessions;
}

async function parseSessionFile(filePath: string, decodedWorkspacePath: string): Promise<Session | null> {
  const turns: SessionTurn[] = [];
  let sessionId = path.basename(filePath, '.jsonl');
  let actualCwd: string | undefined;

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: RawJsonlEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.sessionId && typeof entry.sessionId === 'string') sessionId = entry.sessionId;
    if (entry.cwd && typeof entry.cwd === 'string') actualCwd = entry.cwd;

    const turn = entryToTurn(entry);
    if (turn) turns.push(turn);
  }

  if (turns.length === 0) return null;

  const workspacePath = actualCwd || decodedWorkspacePath;
  const startedAt = turns[0].ts;
  const endedAt = turns[turns.length - 1].ts;

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cost: 0,
    turnCount: turns.length,
    userTurnCount: 0,
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
  for (const t of turns) {
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.cacheWriteTokens += t.cacheWriteTokens;
    totals.cacheReadTokens += t.cacheReadTokens;
    totals.cost += t.cost;
    if (t.role === 'user') totals.userTurnCount += 1;
  }
  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;

  return {
    sessionId,
    workspacePath,
    workspaceName: rollupNameForPath(workspacePath),
    workspaceGroup: groupForWorkspace(workspacePath),
    filePath,
    startedAt,
    endedAt,
    turns,
    totals,
  };
}

function entryToTurn(entry: RawJsonlEntry): SessionTurn | null {
  const ts = entry.timestamp ? new Date(entry.timestamp) : null;
  if (!ts || isNaN(ts.getTime())) return null;

  const role = normalizeRole(entry.type, entry.message?.role);
  const usage: TokenUsage = entry.message?.usage ?? entry.usage ?? {};
  const model = entry.message?.model;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  const cost = costForUsage(model, {
    input: inputTokens,
    output: outputTokens,
    cacheWrite: cacheWriteTokens,
    cacheRead: cacheReadTokens,
  });

  return {
    ts,
    role,
    model,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    cost,
    promptText: role === 'user' ? extractText(entry.message?.content) : undefined,
    isSidechain: Boolean(entry.isSidechain),
    toolCalls: role === 'assistant' ? extractToolCalls(entry.message?.content) : undefined,
  };
}

function extractToolCalls(content: unknown): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: ToolCall[] = [];
  for (const c of content) {
    if (
      c &&
      typeof c === 'object' &&
      (c as any).type === 'tool_use' &&
      typeof (c as any).name === 'string'
    ) {
      const input = (c as any).input;
      calls.push({
        name: (c as any).name,
        input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

function normalizeRole(type: unknown, role: unknown): Role {
  const t = String(type ?? role ?? '').toLowerCase();
  if (t === 'user') return 'user';
  if (t === 'assistant') return 'assistant';
  if (t === 'system') return 'system';
  if (t === 'summary') return 'summary';
  if (t === 'tool' || t === 'tool_result' || t === 'tool_use') return 'tool';
  return 'unknown';
}

function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && 'text' in c && typeof (c as any).text === 'string') {
        parts.push((c as any).text);
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
    return parts.join('\n').trim() || undefined;
  }
  return undefined;
}
