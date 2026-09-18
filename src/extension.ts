import * as vscode from "vscode";
import { ChatController } from "./chat/controller";
import { ChatViewProvider } from "./chat/panel";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ChatController(context);
  const provider = new ChatViewProvider(context, controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("kiroChat.open", () =>
      vscode.commands.executeCommand("kiroChat.panel.focus"),
    ),
    vscode.commands.registerCommand("kiroChat.newSession", () => controller.commandNewSession()),
    vscode.commands.registerCommand("kiroChat.sessionList", () => controller.commandShowHistory()),
    vscode.commands.registerCommand("kiroChat.cancelTurn", () => controller.commandCancel()),
    vscode.commands.registerCommand("kiroChat.restartCli", () => controller.commandRestart()),
    vscode.commands.registerCommand("kiroChat.addFiles", (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const selected = uris?.length ? uris : uri ? [uri] : [];
      return controller.addFiles(selected);
    }),
    vscode.commands.registerCommand("kiroChat.addFile", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      return uri ? controller.addFiles([uri]) : undefined;
    }),
    vscode.commands.registerCommand("kiroChat.addSelection", () => controller.addSelection()),
    vscode.commands.registerCommand("kiroChat.keepFile", (path?: string | string[]) =>
      controller.commandKeepFile(path),
    ),
    vscode.commands.registerCommand("kiroChat.undoFile", (path?: string | string[]) =>
      controller.commandUndoFile(path),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.commandRestart()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kiroChat")) {
        void controller.commandRestart();
      }
    }),
    { dispose: () => controller.dispose() },
  );
}

export function deactivate(): void {
  /* disposed via subscriptions */
}
