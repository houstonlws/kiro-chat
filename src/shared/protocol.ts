export type PanelView = "landing" | "chat" | "history";

export interface Attachment {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "folder" | "selection" | "context" | "image";
  mimeType?: string;
  text?: string;
  dataBase64?: string;
}

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ToolDiff {
  path: string;
  lines: DiffLine[];
}

export interface ToolDetail {
  label: string;
  value: string;
}

export interface ToolCallView {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  purpose?: string;
  command?: string;
  path?: string;
  oldStr?: string;
  newStr?: string;
  startLine?: number;
  summary?: string;
  diff?: ToolDiff;
  details?: ToolDetail[];
  expanded?: boolean;
}

export type FileChangeStatus = "pending" | "kept" | "undone";

export interface FileChangeView {
  path: string;
  relative: string;
  basename: string;
  status: FileChangeStatus;
  startLine?: number;
}

export interface ChatBlock {
  id: string;
  type: "user" | "assistant" | "tools" | "checkpoint" | "error";
  text?: string;
  attachments?: Attachment[];
  toolCalls?: ToolCallView[];
  collapsed?: boolean;
}

export interface SessionTab {
  id: string;
  sessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  blocks: ChatBlock[];
  attachments: Attachment[];
  currentModelId: string;
  currentAgentId: string;
  running: boolean;
  empty: boolean;
}

export interface HistoryItem {
  id: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  active: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  group: "built-in" | "global" | "workspace" | "mode";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface PermissionPrompt {
  requestId: string;
  sessionId: string;
  title: string;
  toolName?: string;
  options: PermissionOption[];
}

export interface ContextChip {
  id: string;
  label: string;
}

export interface UiState {
  view: PanelView;
  workspaceOpen: boolean;
  connected: boolean;
  connecting: boolean;
  error?: string;
  authHint?: string;
  autopilot: boolean;
  showAutopilotBanner: boolean;
  showCheckpointRestore: boolean;
  tabs: SessionTab[];
  activeTabId?: string;
  history: HistoryItem[];
  models: ModelOption[];
  agents: AgentOption[];
  permission?: PermissionPrompt;
  contextOpen: boolean;
  changedFiles?: FileChangeView[];
}

export type HostToWebview =
  | { type: "state"; state: UiState }
  | { type: "contextMenu"; items: { id: string; label: string; description?: string }[] };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "newSession" }
  | { type: "closeSession"; tabId: string }
  | { type: "selectTab"; tabId: string }
  | { type: "showHistory" }
  | { type: "hideHistory" }
  | { type: "filterHistory"; query: string }
  | { type: "openHistoryItem"; sessionId: string }
  | { type: "send"; tabId: string; text: string }
  | { type: "cancel"; tabId: string }
  | { type: "setAutopilot"; value: boolean }
  | { type: "setModel"; tabId: string; modelId: string }
  | { type: "setAgent"; tabId: string; agentId: string }
  | { type: "pickContext"; kind: ContextKind }
  | { type: "removeAttachment"; tabId: string; attachmentId: string }
  | { type: "attachDropped"; name: string; mimeType: string; dataBase64: string; isImage: boolean }
  | { type: "permission"; requestId: string; optionId?: string; cancelled?: boolean }
  | { type: "restoreCheckpoint" }
  | { type: "toggleTools"; tabId: string; blockId: string }
  | { type: "openFile"; path: string; newStr?: string; startLine?: number }
  | { type: "keepFile"; path: string }
  | { type: "undoFile"; path: string }
  | { type: "keepAll" }
  | { type: "undoAll" }
  | { type: "dismissError" };

export type ContextKind =
  | "openFiles"
  | "diagnostics"
  | "gitDiff"
  | "file"
  | "folder"
  | "spec"
  | "steering"
  | "mcp"
  | "terminal";

export const CONTEXT_MENU_ITEMS: { id: ContextKind; label: string }[] = [
  { id: "openFiles", label: "Currently Open Files" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "gitDiff", label: "Git Diff" },
  { id: "file", label: "File" },
  { id: "folder", label: "Folder" },
  { id: "spec", label: "Spec" },
  { id: "steering", label: "Steering" },
  { id: "mcp", label: "MCP" },
  { id: "terminal", label: "Terminal" },
];

export const WORKFLOWS: {
  id: string;
  name: string;
  description: string;
  aliases: string[];
}[] = [
  {
    id: "spec",
    name: "Spec",
    description: "Structured feature development",
    aliases: ["spec", "kiro_spec", "kiro-spec"],
  },
  {
    id: "plan",
    name: "Plan",
    description:
      "Plan-only mode that helps break ideas down into an implementation plan without making any changes",
    aliases: ["plan", "kiro_planner", "planner", "kiro-planner"],
  },
  {
    id: "bugfix",
    name: "Bug Fix",
    description: "Structured bug-fix workflow: investigate, diagnose, and resolve bugs",
    aliases: ["bugfix", "bug-fix", "bug_fix", "kiro_bugfix"],
  },
  {
    id: "quickspec",
    name: "Quick Spec",
    description: "Fast spec workflow: clarify, then auto-generate requirements, design, and tasks",
    aliases: ["quickspec", "quick-spec", "quick_spec", "kiro_quick_spec"],
  },
];

export function isWorkflowSelected(agentId: string, workflowId: string): boolean {
  const id = agentId.toLowerCase();
  let best: { workflowId: string; score: number } | undefined;
  for (const wf of WORKFLOWS) {
    for (const alias of [wf.id, ...wf.aliases]) {
      const token = alias.toLowerCase();
      if (id !== token && !id.includes(token)) {
        continue;
      }
      const score = id === token ? token.length + 100 : token.length;
      if (!best || score > best.score) {
        best = { workflowId: wf.id, score };
      }
    }
  }
  return best?.workflowId === workflowId;
}
