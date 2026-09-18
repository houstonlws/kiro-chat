import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ClientConnection, ClientContext } from "@agentclientprotocol/sdk";
import { spawnAcpProcess, type SpawnedAcp } from "./process";
import { TerminalBroker } from "./terminals";
import { readTextFile, writeTextFile } from "./fs";
import { readSettings } from "../settings";
import { error, info, logTrafficLine } from "../logger";
import { debugLog } from "../debugLog";

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  title: string;
  toolName?: string;
  options: { optionId: string; name: string; kind?: string }[];
}

export interface AcpHandlers {
  onSessionUpdate: (params: acp.SessionNotification) => void;
  onPermission: (payload: PermissionRequestPayload) => Promise<{ optionId?: string; cancelled?: boolean }>;
  onCommandsAvailable?: (params: unknown) => void;
  onProcessExit?: (code: number | null) => void;
}

export class KiroAcpConnection {
  private spawned?: SpawnedAcp;
  private connection?: ClientConnection;
  private agent?: ClientContext;
  private terminals = new TerminalBroker();
  private init?: acp.InitializeResponse;
  private permissionSeq = 0;

  constructor(private readonly handlers: AcpHandlers) {}

  get initializeResult(): acp.InitializeResponse | undefined {
    return this.init;
  }

  get cwd(): string | undefined {
    return this.spawned?.cwd;
  }

  get cliPath(): string | undefined {
    return this.spawned?.cliPath;
  }

  async connect(): Promise<acp.InitializeResponse> {
    await this.dispose();
    const spawned = await spawnAcpProcess();
    this.spawned = spawned;
    spawned.process.on("exit", (code) => this.handlers.onProcessExit?.(code));
    // #region agent log
    spawned.process.on("error", (err: NodeJS.ErrnoException) => {
      debugLog("acpClient.ts:process.error", "ACP child error", {
        message: err?.message,
        code: err?.code,
        errno: err?.errno,
        pid: spawned.process.pid ?? null,
      }, "F");
    });
    debugLog("acpClient.ts:connect", "spawned, starting initialize", {
      pid: spawned.process.pid ?? null,
      cliPath: spawned.cliPath,
      cwd: spawned.cwd,
      platform: process.platform,
    }, "F");
    // #endregion

    const input = Writable.toWeb(spawned.stdin as Writable);
    const output = Readable.toWeb(spawned.stdout as Readable) as ReadableStream<Uint8Array>;
    const stream = maybeWrapTraffic(acp.ndJsonStream(input, output));

    const app = acp
      .client({ name: "kiro-chat" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const params = ctx.params;
        const requestId = `perm-${++this.permissionSeq}`;
        const toolCall = params.toolCall as { title?: string; kind?: string } | undefined;
        const decision = await this.handlers.onPermission({
          requestId,
          sessionId: params.sessionId,
          title: toolCall?.title ?? toolCall?.kind ?? "Permission required",
          toolName: toolCall?.kind,
          options: (params.options ?? []).map((opt) => ({
            optionId: opt.optionId,
            name: opt.name,
            kind: opt.kind,
          })),
        });
        if (decision.cancelled || !decision.optionId) {
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: decision.optionId } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await writeTextFile(ctx.params);
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, (ctx) => this.terminals.create(ctx.params))
      .onRequest(acp.methods.client.terminal.output, (ctx) => this.terminals.output(ctx.params))
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => this.terminals.waitForExit(ctx.params))
      .onRequest(acp.methods.client.terminal.kill, (ctx) => {
        this.terminals.kill(ctx.params);
        return {};
      })
      .onRequest(acp.methods.client.terminal.release, (ctx) => {
        this.terminals.release(ctx.params);
        return {};
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.handlers.onSessionUpdate(ctx.params);
      })
      .onNotification("_kiro.dev/commands/available", { parse: (p) => p }, (ctx) => {
        this.handlers.onCommandsAvailable?.(ctx.params);
      });

    const connection = app.connect(stream);
    this.connection = connection;
    this.agent = connection.agent;

    try {
      const init = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "kiro-chat", version: "0.1.0" },
      });
      this.init = init;
      info(`ACP initialized protocol=${init.protocolVersion} agent=${init.agentInfo?.name ?? "kiro-cli"}`);
      // #region agent log
      debugLog("acpClient.ts:initialize", "initialize ok", {
        protocolVersion: init.protocolVersion,
        agent: init.agentInfo?.name ?? "kiro-cli",
        pid: spawned.process.pid ?? null,
      }, "F");
      // #endregion
      return init;
    } catch (err) {
      // #region agent log
      debugLog("acpClient.ts:initialize.catch", "initialize failed", {
        message: err instanceof Error ? err.message : String(err),
        pid: spawned.process.pid ?? null,
        exitCode: spawned.process.exitCode,
        killed: spawned.process.killed,
      }, "F");
      // #endregion
      throw err;
    }
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    if (!this.agent) {
      throw new Error("Not connected");
    }
    return this.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse | void> {
    if (!this.agent) {
      throw new Error("Not connected");
    }
    return this.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async listSessions(cwd: string): Promise<acp.ListSessionsResponse | undefined> {
    if (!this.agent) {
      return undefined;
    }
    try {
      return await this.agent.request(acp.methods.agent.session.list, { cwd });
    } catch (err) {
      info(`session/list unavailable: ${String(err)}`);
      return undefined;
    }
  }

  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    if (!this.agent) {
      throw new Error("Not connected");
    }
    return this.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.agent) {
      return;
    }
    await this.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (!this.agent) {
      return;
    }
    await this.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  async setModel(sessionId: string, modelId: string, configId = "model"): Promise<void> {
    if (!this.agent) {
      return;
    }
    try {
      await this.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value: modelId,
      });
      return;
    } catch {
      /* fall through */
    }
    try {
      await this.agent.request("session/set_model", { sessionId, modelId });
      return;
    } catch {
      /* fall through */
    }
    await this.executeCommand(sessionId, `/model ${modelId}`);
  }

  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    if (!this.agent) {
      return undefined;
    }
    try {
      return await this.agent.request("_kiro.dev/commands/execute", { sessionId, command });
    } catch (err) {
      error(`command ${command} failed`, err);
      throw err;
    }
  }

  async dispose(): Promise<void> {
    this.terminals.dispose();
    try {
      this.connection?.close();
    } catch {
      /* ignore */
    }
    this.connection = undefined;
    this.agent = undefined;
    if (this.spawned?.process && this.spawned.process.exitCode === null) {
      this.spawned.process.kill();
    }
    this.spawned = undefined;
  }
}

function maybeWrapTraffic(stream: acp.Stream): acp.Stream {
  if (!readSettings().logTraffic) {
    return stream;
  }
  const writer = stream.writable.getWriter();
  return {
    writable: new WritableStream({
      async write(chunk) {
        try {
          logTrafficLine("->", JSON.stringify(chunk));
        } catch {
          /* ignore */
        }
        await writer.write(chunk);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          try {
            logTrafficLine("<-", JSON.stringify(chunk));
          } catch {
            /* ignore */
          }
          controller.enqueue(chunk);
        },
      }),
    ),
  };
}
