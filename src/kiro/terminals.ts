import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { workspaceCwd } from "../settings";

interface Handle {
  id: string;
  output: string;
  exitCode?: number;
  signal?: string;
  killed: boolean;
  child: ReturnType<typeof spawn>;
  waiters: Array<() => void>;
}

export class TerminalBroker {
  private terminals = new Map<string, Handle>();

  create(params: CreateTerminalRequest): CreateTerminalResponse {
    const id = randomUUID();
    const cwd = params.cwd || workspaceCwd() || process.cwd();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const item of params.env ?? []) {
      env[item.name] = item.value;
    }
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      shell: false,
    });
    const handle: Handle = {
      id,
      output: "",
      killed: false,
      child,
      waiters: [],
    };
    child.stdout?.on("data", (buf: Buffer) => {
      handle.output += buf.toString();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      handle.output += buf.toString();
    });
    child.on("exit", (code, signal) => {
      handle.exitCode = code ?? undefined;
      handle.signal = signal ?? undefined;
      handle.waiters.splice(0).forEach((w) => w());
    });
    this.terminals.set(id, handle);
    return { terminalId: id };
  }

  output(params: TerminalOutputRequest): TerminalOutputResponse {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      return { output: "", truncated: false };
    }
    return {
      output: handle.output,
      truncated: false,
      exitStatus:
        handle.exitCode !== undefined || handle.signal
          ? { exitCode: handle.exitCode ?? null, signal: handle.signal ?? null }
          : undefined,
    };
  }

  async waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      return { exitCode: null, signal: null };
    }
    if (handle.exitCode !== undefined || handle.signal) {
      return { exitCode: handle.exitCode ?? null, signal: handle.signal ?? null };
    }
    await new Promise<void>((resolve) => handle.waiters.push(resolve));
    return { exitCode: handle.exitCode ?? null, signal: handle.signal ?? null };
  }

  kill(params: KillTerminalRequest): void {
    const handle = this.terminals.get(params.terminalId);
    handle?.child.kill();
  }

  release(params: ReleaseTerminalRequest): void {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      return;
    }
    handle.child.kill();
    this.terminals.delete(params.terminalId);
  }

  dispose(): void {
    for (const handle of this.terminals.values()) {
      handle.child.kill();
    }
    this.terminals.clear();
  }
}
