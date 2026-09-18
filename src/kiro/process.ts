import { spawn, execFile, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultCliCandidates,
  readSettings,
  resolveShellName,
  workspaceCwd,
  type KiroSettings,
} from "../settings";
import { error, info } from "../logger";

const execFileAsync = promisify(execFile);

export interface SpawnedAcp {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  cliPath: string;
  cwd: string;
}

export async function resolveCliPath(settings: KiroSettings = readSettings()): Promise<string> {
  if (settings.cliPath.trim()) {
    return expandHome(settings.cliPath.trim());
  }
  const fromShell = await whichFromShell("kiro-cli", settings);
  if (fromShell) {
    return fromShell;
  }
  for (const candidate of defaultCliCandidates()) {
    if (candidate.includes(path.sep) && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Could not find kiro-cli. Set kiroChat.cliPath (or the OS-specific path) to the absolute binary location.",
  );
}

export async function spawnAcpProcess(): Promise<SpawnedAcp> {
  const settings = readSettings();
  const cwd = workspaceCwd();
  if (!cwd) {
    throw new Error("Open a folder to chat.");
  }
  const cliPath = await resolveCliPath(settings);
  const extra = settings.extraArgs ?? [];
  const env = { ...process.env, ...settings.env };
  const useLogin =
    settings.useLoginShell && process.platform !== "win32";

  info(`Spawning ${cliPath} acp in ${cwd} (loginShell=${useLogin})`);

  if (useLogin) {
    return spawnViaLoginShell(cliPath, extra, cwd, env, settings);
  }
  return spawnDirect(cliPath, extra, cwd, env);
}

export async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const settings = readSettings();
  const cliPath = await resolveCliPath(settings);
  const workdir = cwd ?? workspaceCwd() ?? process.cwd();
  const env = { ...process.env, ...settings.env };

  if (settings.useLoginShell && process.platform !== "win32") {
    const shell = shellBinary(resolveShellName(settings.shell));
    try {
      const { stdout, stderr } = await execFileAsync(
        shell,
        ["-l", "-c", 'exec "$0" "$@"', cliPath, ...args],
        { cwd: workdir, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      error("login-shell CLI invocation failed, retrying direct", err);
    }
  }

  const { stdout, stderr } = await execFileAsync(cliPath, args, {
    cwd: workdir,
    env,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function spawnDirect(
  cliPath: string,
  extra: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnedAcp {
  const child = spawn(cliPath, ["acp", ...extra], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to create stdio pipes for kiro-cli");
  }
  attachStderr(child);
  return { process: child, stdin: child.stdin, stdout: child.stdout, cliPath, cwd };
}

function spawnViaLoginShell(
  cliPath: string,
  extra: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  settings: KiroSettings,
): SpawnedAcp {
  const shellName = resolveShellName(settings.shell);
  const shell = shellBinary(shellName === "zsh" ? "zsh" : "bash");
  // Profile scripts get /dev/null on fd 0. ACP stdin is fd 3.
  const stdio: StdioOptions = ["ignore", "pipe", "pipe", "pipe"];
  const child = spawn(
    shell,
    ["-l", "-c", 'exec "$0" "$@" <&3', cliPath, "acp", ...extra],
    { cwd, env, stdio },
  );
  const stdin = child.stdio[3] as NodeJS.WritableStream | null;
  if (!stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to create login-shell ACP pipes");
  }
  attachStderr(child);
  return { process: child, stdin, stdout: child.stdout, cliPath, cwd };
}

function attachStderr(child: ChildProcess): void {
  child.stderr?.on("data", (buf: Buffer) => {
    info(`[kiro-cli] ${buf.toString()}`);
  });
  child.on("exit", (code, signal) => {
    info(`kiro-cli exited code=${code} signal=${signal}`);
  });
}

async function whichFromShell(
  binary: string,
  settings: KiroSettings,
): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [binary], { timeout: 8000 });
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return first;
    }
    const shell = shellBinary(resolveShellName(settings.shell));
    const { stdout } = await execFileAsync(
      shell,
      settings.useLoginShell ? ["-l", "-c", `command -v ${binary}`] : ["-c", `command -v ${binary}`],
      { timeout: 8000 },
    );
    const found = stdout.trim().split(/\r?\n/)[0];
    return found || undefined;
  } catch {
    return undefined;
  }
}

function shellBinary(name: string): string {
  if (process.platform === "win32") {
    if (name === "cmd") {
      return process.env.ComSpec || "cmd.exe";
    }
    if (name === "powershell") {
      return "powershell.exe";
    }
    return "pwsh.exe";
  }
  if (name === "zsh") {
    return "/bin/zsh";
  }
  if (name === "fish") {
    return "/usr/bin/fish";
  }
  return "/bin/bash";
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
