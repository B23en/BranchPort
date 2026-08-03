export type ToolCategory = 'edit' | 'exec' | 'explore' | 'deleg' | 'other';

export interface ToolCall {
  toolUseId: string;
  name: string;
  category: ToolCategory;
  inputPreview: string;
  filePath: string | null;
  resultPreview: string | null;
  isError: boolean;
}

export interface TreeNode {
  id: string;
  type: 'Q' | 'A';
  preview: string;
  text: string;
  timestamp: string | null;
  sessionId: string;
  isForkRoot: boolean;
  forkName: string | null;
  tools: ToolCall[];
  outputTokens: number;
  hasImage: boolean;
  interrupted: boolean;
  children: TreeNode[];
}

export type Phase = 'edit' | 'exec' | 'explore' | 'chat';

export interface Turn {
  id: string;
  phase: Phase;
  prompt: string;
  answer: string;
  headline: string;
  timestamp: string | null;
  endTimestamp: string | null;
  sessionId: string;
  isForkRoot: boolean;
  forkName: string | null;
  tools: ToolCall[];
  toolCount: number;
  delegated: boolean;
  hasError: boolean;
  hasImage: boolean;
  interrupted: boolean;
  files: string[];
  outputTokens: number;
  gapMin: number | null;
  compactBefore: boolean;
  children: Turn[];
}

export interface SessionRef {
  sessionId: string;
  projectDir: string;
  filePath: string;
  mtimeMs: number;
}

export interface ParseStats {
  totalLines: number;
  parseErrors: number;
  keptNodes: number;
}
