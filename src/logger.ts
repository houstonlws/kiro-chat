import * as vscode from "vscode";

let log: vscode.OutputChannel | undefined;
let traffic: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!log) {
    log = vscode.window.createOutputChannel("Kiro Chat");
  }
  return log;
}

export function getTraffic(): vscode.OutputChannel {
  if (!traffic) {
    traffic = vscode.window.createOutputChannel("Kiro Chat ACP");
  }
  return traffic;
}

export function info(message: string): void {
  getLog().appendLine(message);
}

export function error(message: string, err?: unknown): void {
  const extra = err instanceof Error ? `\n${err.stack ?? err.message}` : err ? `\n${String(err)}` : "";
  getLog().appendLine(`[error] ${message}${extra}`);
}

export function logTrafficLine(direction: "->" | "<-", payload: string): void {
  getTraffic().appendLine(`${direction} ${payload}`);
}
