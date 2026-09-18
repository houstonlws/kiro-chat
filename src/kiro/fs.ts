import * as vscode from "vscode";
import type { ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";

export async function readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
  const uri = vscode.Uri.file(params.path);
  const raw = await vscode.workspace.fs.readFile(uri);
  let text = Buffer.from(raw).toString("utf8");
  if (params.line !== undefined || params.limit !== undefined) {
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, (params.line ?? 1) - 1);
    const limit = params.limit ?? undefined;
    const end = limit !== undefined ? start + limit : lines.length;
    text = lines.slice(start, end).join("\n");
  }
  return { content: text };
}

export async function writeTextFile(params: WriteTextFileRequest): Promise<void> {
  await writeTextToUri(vscode.Uri.file(params.path), params.content);
}

export async function writeTextToUri(uri: vscode.Uri, content: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === uri.scheme && doc.uri.fsPath === uri.fsPath,
  );
  if (open) {
    const full = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(open.uri, full, content);
    if (await vscode.workspace.applyEdit(edit)) {
      return;
    }
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}
