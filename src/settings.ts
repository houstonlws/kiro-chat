import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

export interface KiroSettings {
  cliPath: string;
  shell: "auto" | "bash" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd";
  useLoginShell: boolean;
  extraArgs: string[];
  env: Record<string, string>;
  cwd: string;
  logTraffic: boolean;
}

export function readSettings(): KiroSettings {
  const cfg = vscode.workspace.getConfiguration("kiroChat");
  const platformPath =
    process.platform === "darwin"
      ? cfg.get<string>("osxCliPath", "")
      : process.platform === "win32"
        ? cfg.get<string>("windowsCliPath", "")
        : cfg.get<string>("linuxCliPath", "");
  return {
    cliPath: platformPath || cfg.get<string>("cliPath", ""),
    shell: cfg.get("shell", "auto"),
    useLoginShell: cfg.get("useLoginShell", true),
    extraArgs: cfg.get<string[]>("extraArgs", []),
    env: cfg.get<Record<string, string>>("env", {}),
    cwd: cfg.get<string>("cwd", ""),
    logTraffic: cfg.get("logTraffic", false),
  };
}

export function workspaceCwd(): string | undefined {
  const configured = readSettings().cwd.trim();
  if (configured) {
    return configured;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function workspaceKey(): string {
  return workspaceCwd() ?? "none";
}

export function defaultCliCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      path.join(home, ".local", "bin", "kiro-cli.exe"),
      path.join(home, "AppData", "Local", "kiro", "kiro-cli.exe"),
      "kiro-cli.exe",
      "kiro-cli",
    ];
  }
  return [
    path.join(home, ".local", "bin", "kiro-cli"),
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro-cli",
    "kiro-cli",
  ];
}

export function resolveShellName(shell: KiroSettings["shell"]): string {
  if (shell !== "auto") {
    return shell;
  }
  if (process.platform === "win32") {
    return "pwsh";
  }
  if (process.platform === "darwin") {
    return "zsh";
  }
  return "bash";
}
