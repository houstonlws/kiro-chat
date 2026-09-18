import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import {
  type AgentOption,
  type Attachment,
  type HistoryItem,
  type HostToWebview,
  type ModelOption,
  type PermissionPrompt,
  type SessionTab,
  type ToolCallView,
  type UiState,
  type WebviewToHost,
} from "../shared/protocol";
import { workspaceCwd, workspaceKey } from "../settings";
import { KiroAcpConnection, type PermissionRequestPayload } from "../kiro/acpClient";
import { loadAgentOptions, resolveWorkflowAgentId, workflowModeCandidates } from "../kiro/agents";
import { listModels } from "../kiro/models";
import { listCliSessions } from "../kiro/sessions";
import {
  FileChangeHighlighter,
  FileChangeStore,
  fileEditFromCall,
  isCompletedTool,
  revertFileChange,
} from "../kiro/fileChanges";
import { applyToolCallUpdate } from "../kiro/toolDisplay";
import { attachmentFromSelection, attachmentsFromUris, collectContext } from "../context/collector";
import { error, info } from "../logger";

const STATE_KEY = "kiroChat.workspaceState";

interface Persisted {
  history: HistoryItem[];
  autopilot: boolean;
  lastModel?: string;
  lastAgent?: string;
}

export class ChatController {
  private webview?: vscode.Webview;
  private connection?: KiroAcpConnection;
  private view: UiState["view"] = "landing";
  private tabs: SessionTab[] = [];
  private activeTabId?: string;
  private history: HistoryItem[] = [];
  private models: ModelOption[] = [{ id: "auto", name: "Auto" }];
  private agents: AgentOption[] = loadAgentOptions();
  private autopilot = false;
  private connected = false;
  private connecting = false;
  private errorMsg?: string;
  private authHint?: string;
  private permission?: PermissionPrompt;
  private permissionWaiters = new Map<
    string,
    (decision: { optionId?: string; cancelled?: boolean }) => void
  >();
  private commands: string[] = [];
  private historyQuery = "";
  private modelConfigId = "model";
  private lastModel = "auto";
  private lastAgent = "default";
  private disposed = false;
  private agentSwitchSeq = 0;
  private agentSwitchInFlight: Promise<void> = Promise.resolve();
  private readonly fileChanges = new FileChangeStore();
  private readonly highlights = new FileChangeHighlighter();
  private readonly recordedToolIds = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.restore();
  }

  attachWebview(webview: vscode.Webview): void {
    this.webview = webview;
    this.pushState();
    void this.ensureConnected();
  }

  dispose(): void {
    this.disposed = true;
    this.highlights.dispose();
    void this.connection?.dispose();
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case "ready":
        this.pushState();
        await this.ensureConnected();
        return;
      case "newSession":
        await this.newSession();
        return;
      case "closeSession":
        await this.closeTab(message.tabId);
        return;
      case "selectTab":
        this.activeTabId = message.tabId;
        this.view = this.activeTab()?.empty ? "landing" : "chat";
        this.pushState();
        return;
      case "showHistory":
        this.view = "history";
        await this.refreshHistory();
        this.pushState();
        return;
      case "hideHistory": {
        const tab = this.activeTab();
        this.view = tab?.empty ? "landing" : "chat";
        this.pushState();
        return;
      }
      case "filterHistory":
        this.historyQuery = message.query;
        this.pushState();
        return;
      case "openHistoryItem":
        await this.openHistory(message.sessionId);
        return;
      case "send":
        await this.send(message.tabId, message.text);
        return;
      case "cancel":
        await this.cancel(message.tabId);
        return;
      case "setAutopilot":
        this.autopilot = message.value;
        this.persist();
        this.pushState();
        return;
      case "setModel":
        await this.setModel(message.tabId, message.modelId);
        return;
      case "setAgent":
        await this.setAgent(message.tabId, message.agentId);
        return;
      case "pickContext":
        await this.addAttachments(await collectContext(message.kind));
        return;
      case "removeAttachment":
        this.removeAttachment(message.tabId, message.attachmentId);
        return;
      case "attachDropped":
        await this.addDropped(message);
        return;
      case "permission":
        this.permissionWaiters.get(message.requestId)?.({
          optionId: message.optionId,
          cancelled: message.cancelled,
        });
        this.permissionWaiters.delete(message.requestId);
        this.permission = undefined;
        this.pushState();
        return;
      case "restoreCheckpoint":
        await this.restoreCheckpoint();
        return;
      case "toggleTools":
        this.toggleTools(message.tabId, message.blockId);
        return;
      case "openFile":
        await this.openChangedFile(message.path, { newStr: message.newStr, startLine: message.startLine });
        return;
      case "keepFile":
        this.keepFile(message.path);
        return;
      case "undoFile":
        await this.undoFile(message.path);
        return;
      case "keepAll":
        this.keepAll();
        return;
      case "undoAll":
        await this.undoAll();
        return;
      case "dismissError":
        this.errorMsg = undefined;
        this.pushState();
        return;
    }
  }

  async commandNewSession(): Promise<void> {
    await vscode.commands.executeCommand("kiroChat.panel.focus");
    await this.newSession();
  }

  async commandShowHistory(): Promise<void> {
    await vscode.commands.executeCommand("kiroChat.panel.focus");
    this.view = "history";
    await this.refreshHistory();
    this.pushState();
  }

  async commandCancel(): Promise<void> {
    const tab = this.activeTab();
    if (tab) {
      await this.cancel(tab.id);
    }
  }

  async commandRestart(): Promise<void> {
    this.connected = false;
    await this.connection?.dispose();
    this.connection = undefined;
    await this.ensureConnected(true);
  }

  async addFiles(uris: vscode.Uri[]): Promise<void> {
    await vscode.commands.executeCommand("kiroChat.panel.focus");
    await this.ensureConnected();
    if (!this.activeTab()) {
      await this.newSession();
    }
    await this.addAttachments(await attachmentsFromUris(uris));
  }

  async addSelection(): Promise<void> {
    await vscode.commands.executeCommand("kiroChat.panel.focus");
    await this.ensureConnected();
    if (!this.activeTab()) {
      await this.newSession();
    }
    const attachment = await attachmentFromSelection();
    if (attachment) {
      await this.addAttachments([attachment]);
    }
  }

  private restore(): void {
    const stored = this.context.workspaceState.get<Persisted>(this.persistKey());
    if (stored) {
      this.history = stored.history ?? [];
      this.autopilot = stored.autopilot ?? false;
      this.lastModel = stored.lastModel ?? "auto";
      this.lastAgent = stored.lastAgent ?? "default";
    }
  }

  private persist(): void {
    const data: Persisted = {
      history: this.history.slice(0, 80),
      autopilot: this.autopilot,
      lastModel: this.lastModel,
      lastAgent: this.lastAgent,
    };
    void this.context.workspaceState.update(this.persistKey(), data);
  }

  private persistKey(): string {
    return `${STATE_KEY}:${workspaceKey()}`;
  }

  private async ensureConnected(force = false): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!workspaceCwd()) {
      this.errorMsg = "Open a folder to chat.";
      this.connected = false;
      this.pushState();
      return;
    }
    if (this.connected && this.connection && !force) {
      return;
    }
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.errorMsg = undefined;
    this.authHint = undefined;
    this.pushState();
    try {
      const conn = new KiroAcpConnection({
        onSessionUpdate: (params) => this.onSessionUpdate(params),
        onPermission: (payload) => this.onPermission(payload),
        onCommandsAvailable: (params) => this.onCommands(params),
        onProcessExit: (code) => {
          this.connected = false;
          if (code) {
            this.errorMsg = `kiro-cli exited (${code}). Use Restart CLI.`;
            this.pushState();
          }
        },
      });
      const init = await conn.connect();
      this.connection = conn;
      this.connected = true;
      if (init.authMethods?.length) {
        this.authHint = "If prompts fail, run `kiro-cli login` in a terminal.";
      }
      this.models = await listModels();
      if (!this.tabs.length) {
        await this.newSession();
      }
      // #region agent log
      fetch("http://127.0.0.1:7594/ingest/da3c68fa-3ee2-4065-82b9-221861837eca", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e15303" },
        body: JSON.stringify({
          sessionId: "e15303",
          runId: "pre-fix",
          hypothesisId: "D",
          location: "controller.ts:ensureConnected.success",
          message: "connect succeeded",
          data: { tabCount: this.tabs.length, view: this.view, connected: this.connected },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    } catch (err) {
      error("Failed to connect to kiro-cli", err);
      this.connected = false;
      this.errorMsg = err instanceof Error ? err.message : String(err);
      const failData = {
        errorMsg: this.errorMsg,
        errName: err instanceof Error ? err.name : typeof err,
        errCode: err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined,
        tabCount: this.tabs.length,
        view: this.view,
        composerWouldHide: this.tabs.length === 0,
      };
      info(`[debug-e15303] connect failed ${JSON.stringify(failData)}`);
      // #region agent log
      fetch("http://127.0.0.1:7594/ingest/da3c68fa-3ee2-4065-82b9-221861837eca", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e15303" },
        body: JSON.stringify({
          sessionId: "e15303",
          runId: "pre-fix",
          hypothesisId: "D",
          location: "controller.ts:ensureConnected.catch",
          message: "connect failed",
          data: failData,
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      if (/auth|login/i.test(this.errorMsg)) {
        this.authHint = "Run `kiro-cli login` in a terminal, then Restart CLI.";
      }
    } finally {
      this.connecting = false;
      this.pushState();
    }
  }

  private async newSession(): Promise<void> {
    await this.ensureConnected();
    const cwd = workspaceCwd();
    if (!cwd || !this.connection) {
      this.pushState();
      return;
    }
    try {
      const created = await this.connection.newSession(cwd);
      this.errorMsg = undefined;
      this.ingestSessionMeta(created);
      const tab = this.makeTab(created.sessionId);
      this.tabs.push(tab);
      this.activeTabId = tab.id;
      this.view = "landing";
      this.upsertHistory({
        id: created.sessionId,
        sessionId: created.sessionId,
        title: "New Session",
        updatedAt: Date.now(),
        active: true,
      });
      this.persist();
    } catch (err) {
      this.errorMsg = this.describeError(err);
      if (/auth/i.test(this.errorMsg)) {
        this.authHint = "Run `kiro-cli login` in a terminal, then Restart CLI.";
      }
    }
    this.pushState();
  }

  private makeTab(sessionId: string): SessionTab {
    return {
      id: randomUUID(),
      sessionId,
      title: "New Session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blocks: [],
      attachments: [],
      currentModelId: this.lastModel,
      currentAgentId: this.lastAgent,
      running: false,
      empty: true,
    };
  }

  private ingestSessionMeta(created: acp.NewSessionResponse | acp.LoadSessionResponse | void): void {
    if (!created) {
      return;
    }
    this.agents = loadAgentOptions(created.modes?.availableModes);
    const modelOption = created.configOptions?.find(
      (opt) => opt.category === "model" || opt.id === "model" || /model/i.test(opt.name),
    );
    if (modelOption && "options" in modelOption) {
      this.modelConfigId = modelOption.id;
      const values = flattenSelectOptions(modelOption.options);
      if (values.length) {
        this.models = [
          { id: "auto", name: "Auto", description: "Models chosen by task for optimal usage and consistent quality" },
          ...values.filter((m) => m.id !== "auto"),
        ];
      }
      if ("currentValue" in modelOption && typeof modelOption.currentValue === "string") {
        const tab = this.activeTab();
        if (tab) {
          tab.currentModelId = modelOption.currentValue;
        }
      }
    }
  }

  private async closeTab(tabId: string): Promise<void> {
    this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.at(-1)?.id;
    }
    if (!this.tabs.length) {
      await this.newSession();
      return;
    }
    const tab = this.activeTab();
    this.view = tab?.empty ? "landing" : "chat";
    this.pushState();
  }

  private async openHistory(sessionId: string): Promise<void> {
    const existing = this.tabs.find((tab) => tab.sessionId === sessionId);
    if (existing) {
      this.activeTabId = existing.id;
      this.view = existing.empty ? "landing" : "chat";
      this.pushState();
      return;
    }
    await this.ensureConnected();
    const cwd = workspaceCwd();
    if (!cwd || !this.connection) {
      return;
    }
    const tab = this.makeTab(sessionId);
    const listed = this.history.find((h) => h.sessionId === sessionId);
    if (listed) {
      tab.title = listed.title;
    }
    tab.empty = false;
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.view = "chat";
    this.pushState();
    try {
      const loaded = await this.connection.loadSession(sessionId, cwd);
      this.ingestSessionMeta(loaded);
      if (!tab.blocks.length) {
        tab.empty = true;
        this.view = "landing";
      }
    } catch (err) {
      tab.blocks.push({
        id: randomUUID(),
        type: "error",
        text: this.describeError(err),
      });
    }
    this.pushState();
  }

  private async refreshHistory(): Promise<void> {
    const cwd = workspaceCwd();
    const merged = new Map<string, HistoryItem>();
    for (const item of this.history) {
      merged.set(item.sessionId, item);
    }
    for (const tab of this.tabs) {
      if (tab.sessionId) {
        merged.set(tab.sessionId, {
          id: tab.sessionId,
          sessionId: tab.sessionId,
          title: tab.title,
          updatedAt: tab.updatedAt,
          active: true,
        });
      }
    }
    try {
      const listed = await this.connection?.listSessions(cwd ?? "") ;
      const sessions = listed?.sessions ?? [];
      for (const session of sessions) {
        if (cwd && session.cwd && session.cwd !== cwd) {
          continue;
        }
        const prev = merged.get(session.sessionId);
        merged.set(session.sessionId, {
          id: session.sessionId,
          sessionId: session.sessionId,
          title: session.title || prev?.title || "Session",
          updatedAt: session.updatedAt ? Date.parse(session.updatedAt) || prev?.updatedAt || Date.now() : prev?.updatedAt || Date.now(),
          active: this.tabs.some((t) => t.sessionId === session.sessionId),
        });
      }
    } catch {
      /* optional */
    }
    try {
      for (const item of await listCliSessions()) {
        const prev = merged.get(item.sessionId);
        merged.set(item.sessionId, {
          ...item,
          title: prev?.title && prev.title !== "Session" ? prev.title : item.title,
          active: this.tabs.some((t) => t.sessionId === item.sessionId),
        });
      }
    } catch {
      /* optional */
    }
    this.history = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    this.persist();
  }

  private async send(tabId: string, text: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId || !this.connection) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && !tab.attachments.length) {
      return;
    }
    this.errorMsg = undefined;
    const attachments = [...tab.attachments];
    tab.attachments = [];
    tab.empty = false;
    tab.running = true;
    tab.updatedAt = Date.now();
    if (tab.title === "New Session" && trimmed) {
      tab.title = trimmed.slice(0, 48);
    }
    tab.blocks.push({
      id: randomUUID(),
      type: "user",
      text: trimmed,
      attachments,
    });
    this.view = "chat";
    this.upsertHistory({
      id: tab.sessionId,
      sessionId: tab.sessionId,
      title: tab.title,
      updatedAt: tab.updatedAt,
      active: true,
    });
    this.persist();
    this.pushState();

    await this.agentSwitchInFlight;
    await this.applySelectedMode(tab);
    if (this.disposed || !tab.sessionId || !this.connection) {
      tab.running = false;
      this.pushState();
      return;
    }

    const prompt = this.buildPrompt(trimmed, attachments);
    try {
      await this.connection.prompt(tab.sessionId, prompt);
    } catch (err) {
      tab.blocks.push({
        id: randomUUID(),
        type: "error",
        text: this.describeError(err),
      });
    } finally {
      tab.running = false;
      this.flushPendingTools(tab);
      this.pushState();
    }
  }

  private buildPrompt(text: string, attachments: Attachment[]): acp.ContentBlock[] {
    const blocks: acp.ContentBlock[] = [];
    for (const att of attachments) {
      if (att.kind === "image" && att.dataBase64 && att.mimeType) {
        blocks.push({ type: "image", data: att.dataBase64, mimeType: att.mimeType });
      } else if (att.path) {
        blocks.push({
          type: "resource_link",
          uri: vscode.Uri.file(att.path).toString(),
          name: att.name,
        } as acp.ContentBlock);
        if (att.text) {
          blocks.push({ type: "text", text: att.text });
        }
      } else if (att.text) {
        blocks.push({ type: "text", text: att.text });
      } else if (att.dataBase64) {
        blocks.push({
          type: "text",
          text: `Attached document: ${att.name} (base64, ${att.mimeType ?? "application/octet-stream"})\n`,
        });
      }
    }
    if (text.trim()) {
      blocks.push({ type: "text", text: text.trim() });
    }
    return blocks;
  }

  private async cancel(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId || !this.connection) {
      return;
    }
    await this.connection.cancel(tab.sessionId);
    for (const [id, resolve] of this.permissionWaiters) {
      resolve({ cancelled: true });
      this.permissionWaiters.delete(id);
    }
    this.permission = undefined;
    tab.running = false;
    this.pushState();
  }

  private async setModel(tabId: string, modelId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId || !this.connection) {
      return;
    }
    tab.currentModelId = modelId;
    this.lastModel = modelId;
    this.errorMsg = undefined;
    this.persist();
    this.pushState();
    if (modelId !== "auto") {
      try {
        await this.connection.setModel(tab.sessionId, modelId, this.modelConfigId);
      } catch (err) {
        this.errorMsg = this.describeError(err);
        this.pushState();
      }
    }
  }

  private async setAgent(tabId: string, agentId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId || !this.connection) {
      return;
    }
    const seq = ++this.agentSwitchSeq;
    const selected = agentId === "default" ? "default" : resolveWorkflowAgentId(agentId, this.agents);
    tab.currentAgentId = selected;
    this.lastAgent = selected;
    this.errorMsg = undefined;
    this.persist();
    this.pushState();
    const task = this.agentSwitchInFlight.then(async () => {
      if (seq !== this.agentSwitchSeq) {
        return;
      }
      await this.applySelectedMode(tab, seq);
    });
    this.agentSwitchInFlight = task.catch((err) => {
      info(`setAgent ${agentId} failed: ${this.describeError(err)}`);
    });
    await this.agentSwitchInFlight;
  }

  private async applySelectedMode(tab: SessionTab, seq?: number): Promise<void> {
    if (!tab.sessionId || !this.connection || tab.currentAgentId === "default") {
      return;
    }
    const candidates = workflowModeCandidates(tab.currentAgentId, this.agents);
    for (const modeId of candidates) {
      if (seq !== undefined && seq !== this.agentSwitchSeq) {
        return;
      }
      try {
        await this.connection.setMode(tab.sessionId, modeId);
        if (seq !== undefined && seq !== this.agentSwitchSeq) {
          return;
        }
        tab.currentAgentId = modeId;
        this.lastAgent = modeId;
        this.pushState();
        return;
      } catch (err) {
        info(`set_mode ${modeId} failed: ${this.describeError(err)}`);
      }
    }
  }

  private async restoreCheckpoint(): Promise<void> {
    const tab = this.activeTab();
    if (!tab?.sessionId || !this.connection) {
      return;
    }
    try {
      await this.connection.executeCommand(tab.sessionId, "/checkpoint restore");
    } catch (err) {
      void vscode.window.showWarningMessage(`Checkpoint restore unavailable: ${this.describeError(err)}`);
    }
  }

  private async addAttachments(items: Attachment[]): Promise<void> {
    const tab = this.activeTab();
    if (!tab || !items.length) {
      return;
    }
    tab.attachments.push(...items);
    this.pushState();
  }

  private async addDropped(message: Extract<WebviewToHost, { type: "attachDropped" }>): Promise<void> {
    const tab = this.activeTab();
    if (!tab) {
      return;
    }
    tab.attachments.push({
      id: randomUUID(),
      name: message.name,
      kind: message.isImage ? "image" : "file",
      mimeType: message.mimeType,
      dataBase64: message.dataBase64,
    });
    this.pushState();
  }

  private removeAttachment(tabId: string, attachmentId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    tab.attachments = tab.attachments.filter((a) => a.id !== attachmentId);
    this.pushState();
  }

  private toggleTools(tabId: string, blockId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const block = tab?.blocks.find((b) => b.id === blockId);
    if (block) {
      block.collapsed = !block.collapsed;
      this.pushState();
    }
  }

  private onCommands(params: unknown): void {
    const rec = params as { commands?: { name?: string }[] };
    this.commands = (rec.commands ?? []).map((c) => c.name ?? "").filter(Boolean);
    this.pushState();
  }

  private async onPermission(
    payload: PermissionRequestPayload,
  ): Promise<{ optionId?: string; cancelled?: boolean }> {
    if (this.autopilot) {
      const allow =
        payload.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ??
        payload.options.find((o) => /allow/i.test(o.optionId) || /allow/i.test(o.name)) ??
        payload.options[0];
      return { optionId: allow?.optionId };
    }
    this.permission = {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      title: payload.title,
      toolName: payload.toolName,
      options: payload.options,
    };
    this.pushState();
    return new Promise((resolve) => {
      this.permissionWaiters.set(payload.requestId, resolve);
    });
  }

  private onSessionUpdate(params: acp.SessionNotification): void {
    const tab =
      this.tabs.find((t) => t.sessionId === params.sessionId) ?? this.activeTab();
    if (!tab) {
      return;
    }
    const update = params.update as {
      sessionUpdate: string;
      content?: unknown;
      toolCallId?: string;
      title?: string;
      kind?: string;
      name?: string;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: Array<{ path?: string; line?: number | null }>;
      currentModeId?: string;
    };
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.sessionUpdate === "agent_thought_chunk") {
          break;
        }
        const text = (update as { content?: { type?: string; text?: string } }).content?.text ?? "";
        this.appendAssistant(tab, text);
        break;
      }
      case "user_message_chunk":
        break;
      case "tool_call":
      case "tool_call_update":
        if (update.toolCallId) {
          this.upsertTool(tab, {
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            name: update.name,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
            locations: update.locations,
          });
        }
        break;
      case "current_mode_update": {
        const modeId = (update as { currentModeId?: string }).currentModeId;
        if (modeId) {
          tab.currentAgentId = modeId;
        }
        break;
      }
      default:
        break;
    }
    this.pushState();
  }

  private appendAssistant(tab: SessionTab, text: string): void {
    const last = tab.blocks.at(-1);
    if (last?.type === "assistant") {
      last.text = (last.text ?? "") + text;
      return;
    }
    tab.blocks.push({
      id: randomUUID(),
      type: "assistant",
      text,
    });
    tab.empty = false;
  }

  private upsertTool(
    tab: SessionTab,
    update: {
      toolCallId: string;
      title?: string;
      kind?: string;
      name?: string;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
      locations?: Array<{ path?: string; line?: number | null }>;
    },
  ): void {
    let block = [...tab.blocks].reverse().find((b) => b.type === "tools");
    const last = tab.blocks.at(-1);
    if (!block || last?.type === "assistant") {
      block = { id: randomUUID(), type: "tools", toolCalls: [], collapsed: true };
      tab.blocks.push(block);
    }
    const calls = block.toolCalls ?? (block.toolCalls = []);
    let call = calls.find((c) => c.id === update.toolCallId);
    if (!call) {
      call = { id: update.toolCallId, title: update.title || "Tool" };
      calls.push(call);
    }
    applyToolCallUpdate(call, update);
    void this.recordCompletedEdit(call);
  }

  private async recordCompletedEdit(call: ToolCallView): Promise<void> {
    if (!isCompletedTool(call.status)) {
      return;
    }
    const edit = fileEditFromCall(call);
    if (!edit) {
      return;
    }
    if (this.recordedToolIds.has(call.id)) {
      const upgraded = await this.fileChanges.upgradeLast(edit.path, edit.oldStr, edit.newStr, edit.startLine);
      if (upgraded) {
        await this.highlights.reveal(upgraded.path, {
          spans: upgraded.spans,
          span: upgraded.span,
          needle: this.fileChanges.lastNeedle(upgraded.path),
          fallbackLine: upgraded.startLine,
          preserveFocus: true,
        });
        this.pushState();
      }
      return;
    }
    this.recordedToolIds.add(call.id);
    const entry = await this.fileChanges.record(edit.path, edit.oldStr, edit.newStr, edit.startLine);
    await this.highlights.reveal(entry.path, {
      spans: entry.spans,
      span: entry.span,
      needle: this.fileChanges.lastNeedle(entry.path),
      fallbackLine: entry.startLine,
      preserveFocus: true,
    });
    this.pushState();
  }

  private async openChangedFile(
    path: string,
    extra?: { newStr?: string; startLine?: number },
  ): Promise<void> {
    const entry = this.fileChanges.get(path);
    const needle =
      extra?.newStr || (entry?.status === "pending" ? this.fileChanges.lastNeedle(path) : undefined);
    try {
      await this.highlights.reveal(path, {
        spans: entry?.status === "pending" ? entry.spans : undefined,
        span: entry?.status === "pending" ? entry.span : undefined,
        needle,
        fallbackLine: extra?.startLine ?? entry?.startLine,
        preserveFocus: false,
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async commandKeepFile(path?: string | string[]): Promise<void> {
    const target = Array.isArray(path) ? path[0] : path;
    if (target) {
      this.keepFile(target);
    }
  }

  async commandUndoFile(path?: string | string[]): Promise<void> {
    const target = Array.isArray(path) ? path[0] : path;
    if (target) {
      await this.undoFile(target);
    }
  }

  private keepFile(path: string): void {
    this.fileChanges.remove(path);
    this.highlights.clear(path);
    this.pushState();
  }

  private keepAll(): void {
    for (const file of this.fileChanges.pending()) {
      this.highlights.clear(file.path);
      this.fileChanges.remove(file.path);
    }
    this.pushState();
  }

  private async undoFile(path: string): Promise<void> {
    const entry = this.fileChanges.get(path);
    if (!entry || entry.status !== "pending") {
      return;
    }
    const result = await revertFileChange(entry);
    if (!result.applied) {
      void vscode.window.showWarningMessage(
        `${entry.basename} no longer contains the agent edit; undo skipped.`,
      );
      return;
    }
    if (result.skipped) {
      void vscode.window.showWarningMessage(
        `${entry.basename} was edited; skipped ${result.skipped} change(s) that no longer match.`,
      );
    }
    this.fileChanges.remove(path);
    this.highlights.clear(path);
    this.pushState();
  }

  private async undoAll(): Promise<void> {
    for (const file of this.fileChanges.pending()) {
      await this.undoFile(file.path);
    }
  }

  private flushPendingTools(tab: SessionTab): void {
    const last = tab.blocks.at(-1);
    if (last?.type === "tools" && !last.toolCalls?.length) {
      tab.blocks.pop();
    }
  }

  private upsertHistory(item: HistoryItem): void {
    const rest = this.history.filter((h) => h.sessionId !== item.sessionId);
    this.history = [item, ...rest];
  }

  private activeTab(): SessionTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? this.tabs[0];
  }

  private describeError(err: unknown): string {
    if (err && typeof err === "object" && "message" in err) {
      return String((err as { message: unknown }).message);
    }
    return String(err);
  }

  private snapshot(): UiState {
    const q = this.historyQuery.trim().toLowerCase();
    const history = this.history
      .map((item) => ({
        ...item,
        active: this.tabs.some((t) => t.sessionId === item.sessionId),
      }))
      .filter((item) => {
        if (!q) {
          return true;
        }
        return `${item.title} ${new Date(item.updatedAt).toLocaleString()}`.toLowerCase().includes(q);
      });
    return {
      view: this.view,
      workspaceOpen: Boolean(workspaceCwd()),
      connected: this.connected,
      connecting: this.connecting,
      error: this.errorMsg,
      authHint: this.authHint,
      autopilot: this.autopilot,
      showAutopilotBanner: !this.autopilot && this.view === "chat",
      showCheckpointRestore: this.commands.some((c) => c.includes("checkpoint")),
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      history,
      models: this.models,
      agents: this.agents,
      permission: this.permission,
      contextOpen: false,
      changedFiles: this.fileChanges.list(),
    };
  }

  private pushState(): void {
    if (!this.webview) {
      return;
    }
    const message: HostToWebview = { type: "state", state: this.snapshot() };
    void this.webview.postMessage(message);
  }
}

function flattenSelectOptions(options: unknown): ModelOption[] {
  if (!Array.isArray(options)) {
    return [];
  }
  const out: ModelOption[] = [];
  for (const opt of options) {
    if (!opt || typeof opt !== "object") {
      continue;
    }
    const rec = opt as { value?: string; name?: string; description?: string | null; options?: unknown };
    if (rec.value) {
      out.push({
        id: rec.value,
        name: rec.name || rec.value,
        description: rec.description ?? undefined,
      });
    } else if (rec.options) {
      out.push(...flattenSelectOptions(rec.options));
    }
  }
  return out;
}
