import { spawn, execFile, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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
import { debugLog } from "../debugLog";

const execFileAsync = promisify(execFile);

export interface SpawnedAcp {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  cliPath: string;
  cwd: string;
}

export async function resolveCliPath(settings: KiroSettings = readSettings()): Promise<string> {
  let source = "missing";
  let resolved = "";
  let whereLines: string[] | undefined;
  if (settings.cliPath.trim()) {
    source = "settings";
    resolved = expandHome(settings.cliPath.trim());
  } else {
    const found = await whichFromShell("kiro-cli", settings);
    whereLines = found.lines;
    if (found.path) {
      source = "which";
      resolved = found.path;
    } else {
      for (const candidate of defaultCliCandidates()) {
        if (candidate.includes(path.sep) && existsSync(candidate)) {
          source = "candidate";
          resolved = candidate;
          break;
        }
      }
    }
  }
  // #region agent log
  debugLog(
    "process.ts:resolveCliPath",
    "resolved cliPath",
    { source, resolved, whereLines, platform: process.platform, probe: resolved ? probeExecutable(resolved) : null },
    source === "settings" ? "B" : "C",
  );
  // #endregion
  if (!resolved) {
    throw new Error(
      "Could not find kiro-cli. Set kiroChat.cliPath (or the OS-specific path) to the absolute binary location.",
    );
  }
  return resolved;
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
  let cwdExists = false;
  try {
    cwdExists = statSync(cwd).isDirectory();
  } catch {
    cwdExists = false;
  }
  // #region agent log
  debugLog("process.ts:spawnDirect", "about to spawnDirect", {
    cliPath,
    extra,
    cwd,
    cwdExists,
    windowsHide: true,
    platform: process.platform,
    probe: probeExecutable(cliPath),
  }, "A");
  // #endregion
  const child = spawn(cliPath, ["acp", ...extra], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // #region agent log
  child.on("error", (err: NodeJS.ErrnoException) => {
    const payload = {
      errMessage: err?.message,
      errCode: err?.code,
      errno: err?.errno,
      syscall: err?.syscall,
      errPath: (err as NodeJS.ErrnoException & { path?: string })?.path,
      cliPath,
      cwd,
      cwdExists,
      windowsHide: true,
      probe: probeExecutable(cliPath),
    };
    info(`[debug-e15303] spawn error ${JSON.stringify(payload)}`);
    debugLog("process.ts:spawnDirect.error", "child spawn error", payload, "A");
  });
  debugLog("process.ts:spawnDirect.after", "spawn returned", {
    pid: child.pid ?? null,
    spawnfile: child.spawnfile,
    hasStdin: Boolean(child.stdin),
    hasStdout: Boolean(child.stdout),
    exitCode: child.exitCode,
  }, "A");
  // #endregion
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
    const text = buf.toString();
    info(`[kiro-cli] ${text}`);
    // #region agent log
    debugLog("process.ts:stderr", "kiro-cli stderr", { preview: text.slice(0, 400) }, "G");
    // #endregion
  });
  child.on("exit", (code, signal) => {
    info(`kiro-cli exited code=${code} signal=${signal}`);
    // #region agent log
    debugLog("process.ts:exit", "kiro-cli exited", { code, signal, pid: child.pid ?? null }, "G");
    // #endregion
  });
}

async function whichFromShell(
  binary: string,
  settings: KiroSettings,
): Promise<{ path?: string; lines?: string[] }> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [binary], { timeout: 8000 });
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return { path: lines[0], lines };
    }
    const shell = shellBinary(resolveShellName(settings.shell));
    const { stdout } = await execFileAsync(
      shell,
      settings.useLoginShell ? ["-l", "-c", `command -v ${binary}`] : ["-c", `command -v ${binary}`],
      { timeout: 8000 },
    );
    const found = stdout.trim().split(/\r?\n/)[0];
    return { path: found || undefined, lines: found ? [found] : [] };
  } catch (err) {
    // #region agent log
    debugLog(
      "process.ts:whichFromShell.catch",
      "which/where failed",
      { platform: process.platform, err: err instanceof Error ? err.message : String(err) },
      "C",
    );
    // #endregion
    return {};
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

function probeExecutable(filePath: string): Record<string, unknown> {
  try {
    const st = statSync(filePath);
    const info: Record<string, unknown> = {
      exists: true,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      ext: path.extname(filePath).toLowerCase(),
    };
    if (!st.isFile()) {
      return info;
    }
    const buf = Buffer.alloc(48);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, 48, 0);
    } finally {
      closeSync(fd);
    }
    const head = buf.toString("utf8");
    info.isPE = buf[0] === 0x4d && buf[1] === 0x5a;
    info.isShebang = head.startsWith("#!");
    info.head = head.slice(0, 40).replace(/[^\x20-\x7e]/g, ".");
    return info;
  } catch (err) {
    return { exists: false, error: err instanceof Error ? err.message : String(err) };
  }
}
