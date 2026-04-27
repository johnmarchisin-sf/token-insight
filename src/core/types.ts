// Shared types for token-insight.

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RawJsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: TokenUsage;
  };
  usage?: TokenUsage;
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  [k: string]: unknown;
}

export type Role = 'user' | 'assistant' | 'system' | 'summary' | 'tool' | 'unknown';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface SessionTurn {
  ts: Date;
  role: Role;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cost: number;
  promptText?: string;
  isSidechain: boolean;
  toolCalls?: ToolCall[];
}

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  turnCount: number;
  userTurnCount: number;
  durationMs: number;
}

export interface Session {
  sessionId: string;
  workspacePath: string;     // decoded absolute path on disk
  workspaceName: string;     // friendly short name (final segment)
  workspaceGroup: string;    // group bucket: "conductor", "other", or first known parent
  filePath: string;          // path to the .jsonl file
  startedAt: Date;
  endedAt: Date;
  turns: SessionTurn[];
  totals: SessionTotals;
}

export interface PromptCluster {
  id: string;
  representative: string;
  size: number;
  totalTokens: number;
  totalCost: number;
  workspaces: string[];
  examplePrompts: string[];
  trigrams: string[];
}

export interface WasteFlag {
  sessionId: string;
  workspaceName: string;
  filePath: string;
  startedAt: Date;
  totalTokens: number;
  cost: number;
  reasons: string[];
  cacheReadRatio: number;
  tokensPerUserTurn: number;
}
