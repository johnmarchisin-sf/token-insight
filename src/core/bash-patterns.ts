// Mines Bash tool calls across sessions to find repeated commands that look
// like hook candidates. The analyzer normalizes each command into a shape
// (paths/numbers/quoted strings replaced with placeholders), groups by shape,
// and tags each occurrence with whether it followed a file edit (PostToolUse
// hint) or appeared in the first few turns of a session (SessionStart hint).
//
// The recommendations engine uses these tags to decide whether a shape is a
// good fit for one hook type or the other.

import { Session } from './types.js';

export interface BashPatternOccurrence {
  workspace: string;
  sessionId: string;
  /** Turn index within the session (0-based). */
  turnIndex: number;
  /** Whether this Bash call directly followed an Edit/Write/MultiEdit. */
  followedEdit: boolean;
}

export interface BashPattern {
  /** Normalized command shape, e.g. "npm run typecheck" or "gh pr view <num>". */
  shape: string;
  /** Total occurrences across all sessions. */
  count: number;
  /** Number of distinct sessions this shape appeared in. */
  sessionCount: number;
  /** Number of distinct workspaces. */
  workspaceCount: number;
  /** How many times this shape ran immediately after an Edit/Write/MultiEdit. */
  postEditCount: number;
  /** How many distinct sessions had this shape in their first 5 turns. */
  sessionStartCount: number;
  /** Up to 3 verbatim example commands (pre-normalization). */
  examples: string[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const SESSION_START_TURN_LIMIT = 5;

// Trivial single-word or shell-builtin commands; never useful as hooks.
const TRIVIAL_SHAPES = new Set([
  'cd',
  'ls',
  'pwd',
  'cat',
  'which',
  'echo',
  'true',
  'false',
  'mkdir',
  'rmdir',
  'rm',
  'mv',
  'cp',
  'head',
  'tail',
  'find',
  'clear',
  'history',
  'export',
  'env',
  'open',
]);

// Setup commands that you'd want to run manually, not as a hook.
const ONE_OFF_KEYWORDS = ['install', 'clone', ' init', 'create-react', 'mkcert'];

export function extractBashPatterns(sessions: Session[]): BashPattern[] {
  // shape -> aggregate accumulator
  const acc = new Map<
    string,
    {
      count: number;
      sessions: Set<string>;
      workspaces: Set<string>;
      postEditCount: number;
      sessionStartSessions: Set<string>;
      examples: string[];
    }
  >();

  for (const s of sessions) {
    let lastToolName: string | null = null;
    for (let ti = 0; ti < s.turns.length; ti++) {
      const turn = s.turns[ti];
      if (!turn.toolCalls) continue;
      for (const tc of turn.toolCalls) {
        if (tc.name !== 'Bash') {
          lastToolName = tc.name;
          continue;
        }
        const cmd = typeof tc.input.command === 'string' ? tc.input.command : '';
        const shape = normalizeCommand(cmd);
        if (!shape) {
          lastToolName = tc.name;
          continue;
        }
        const followedEdit = lastToolName != null && EDIT_TOOLS.has(lastToolName);
        const entry = acc.get(shape) || {
          count: 0,
          sessions: new Set<string>(),
          workspaces: new Set<string>(),
          postEditCount: 0,
          sessionStartSessions: new Set<string>(),
          examples: [],
        };
        entry.count += 1;
        entry.sessions.add(s.sessionId);
        entry.workspaces.add(s.workspaceName);
        if (followedEdit) entry.postEditCount += 1;
        if (ti < SESSION_START_TURN_LIMIT) entry.sessionStartSessions.add(s.sessionId);
        if (entry.examples.length < 3 && !entry.examples.includes(cmd)) {
          entry.examples.push(cmd);
        }
        acc.set(shape, entry);
        lastToolName = tc.name;
      }
    }
  }

  const out: BashPattern[] = [];
  for (const [shape, agg] of acc) {
    out.push({
      shape,
      count: agg.count,
      sessionCount: agg.sessions.size,
      workspaceCount: agg.workspaces.size,
      postEditCount: agg.postEditCount,
      sessionStartCount: agg.sessionStartSessions.size,
      examples: agg.examples,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// Normalizes a shell command into its hook-candidate shape. Returns the
// empty string for commands that should never be considered (compounds,
// trivial builtins, one-off setup commands).
export function normalizeCommand(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Drop compound commands — they're too varied to cluster usefully.
  if (/[;&|]{1,2}/.test(trimmed) || /\n/.test(trimmed)) return '';
  // Strip leading "sudo" / time / nice prefixes — same shape underneath.
  const stripped = trimmed.replace(/^(sudo|time|nice|nohup)\s+/i, '');

  // Replace quoted strings, paths, and numbers with placeholders so cosmetic
  // differences don't fragment the cluster.
  let shape = stripped
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    // Path token: any whitespace-bounded chunk that contains a "/" and looks
    // like a path (allowed leading chars: word, dot, tilde, slash). This
    // catches absolute (/Users/...), home-relative (~/foo), and relative
    // (.context/foo, src/foo) paths uniformly.
    .replace(/(?<=^|\s)[~./\w-][\w./@:~-]*\/[\w./@:~-]+/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();

  // Filter trivial single-builtin commands.
  const head = shape.split(/\s+/)[0];
  if (TRIVIAL_SHAPES.has(head)) return '';

  // Filter one-off setup commands.
  for (const kw of ONE_OFF_KEYWORDS) {
    if (shape.includes(kw)) return '';
  }

  return shape;
}
