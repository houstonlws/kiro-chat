import * as vscode from "vscode";
import { ChatController } from "./controller";
import type { WebviewToHost } from "../shared/protocol";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "kiroChat.panel";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webview.html = this.html(webview);
    this.controller.attachWebview(webview);
    webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.controller.handle(message);
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${style}" />
  <title>Kiro Chat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
