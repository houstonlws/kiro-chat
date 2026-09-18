import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Attachment, ContextKind } from "../shared/protocol";
import { workspaceCwd } from "../settings";

const execFileAsync = promisify(execFile);

export async function collectContext(kind: ContextKind): Promise<Attachment[]> {
  switch (kind) {
    case "openFiles":
      return openFiles();
    case "diagnostics":
      return diagnostics();
    case "gitDiff":
      return gitDiff();
    case "file":
      return pickFiles(false);
    case "folder":
      return pickFiles(true);
    case "spec":
      return globFolder(".kiro/specs", "Spec");
    case "steering":
      return globFolder(".kiro/steering", "Steering");
    case "mcp":
      return [
        {
          id: randomUUID(),
          name: "MCP",
          kind: "context",
          text: "Use connected MCP servers for this request.",
        },
      ];
    case "terminal":
      return terminal();
    default:
      return [];
  }
}

export async function attachmentsFromUris(uris: vscode.Uri[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const uri of uris) {
    if (uri.scheme !== "file") {
      continue;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    const folder = Boolean(stat.type & vscode.FileType.Directory);
    const text = folder ? undefined : await readLimited(uri);
    out.push({
      id: randomUUID(),
      name: uri.path.split("/").pop() || uri.fsPath,
      path: uri.fsPath,
      kind: folder ? "folder" : "file",
      text,
    });
  }
  return out;
}

export async function attachmentFromSelection(): Promise<Attachment | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  const name = `${editor.document.fileName.split(/[\\/]/).pop()}:${editor.selection.start.line + 1}`;
  return {
    id: randomUUID(),
    name,
    path: editor.document.uri.fsPath,
    kind: "selection",
    text: `Selection from ${name}\n\n\`\`\`\n${text}\n\`\`\``,
  };
}

async function openFiles(): Promise<Attachment[]> {
  const cwd = workspaceCwd();
  const docs = vscode.workspace.textDocuments.filter(
    (doc) => doc.uri.scheme === "file" && (!cwd || doc.uri.fsPath.startsWith(cwd)),
  );
  const out: Attachment[] = [];
  for (const doc of docs) {
    out.push({
      id: randomUUID(),
      name: vscode.workspace.asRelativePath(doc.uri),
      path: doc.uri.fsPath,
      kind: "file",
      text: `File: ${doc.uri.fsPath}\n\n\`\`\`\n${doc.getText().slice(0, 80_000)}\n\`\`\``,
    });
  }
  return out;
}

async function diagnostics(): Promise<Attachment[]> {
  const entries = vscode.languages.getDiagnostics();
  const lines: string[] = ["Diagnostics:"];
  for (const [uri, diags] of entries) {
    if (!diags.length) {
      continue;
    }
    lines.push(`\n${uri.fsPath}`);
    for (const d of diags.slice(0, 50)) {
      lines.push(
        `- [${vscode.DiagnosticSeverity[d.severity]}] L${d.range.start.line + 1}: ${d.message}`,
      );
    }
  }
  return [
    {
      id: randomUUID(),
      name: "Diagnostics",
      kind: "context",
      text: lines.join("\n"),
    },
  ];
}

async function gitDiff(): Promise<Attachment[]> {
  const cwd = workspaceCwd();
  if (!cwd) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("git", ["diff"], { cwd, timeout: 15_000, maxBuffer: 2_000_000 });
    return [
      {
        id: randomUUID(),
        name: "Git Diff",
        kind: "context",
        text: stdout.trim() ? `Git diff:\n\n\`\`\`diff\n${stdout.slice(0, 80_000)}\n\`\`\`` : "Git diff: (empty)",
      },
    ];
  } catch (err) {
    return [
      {
        id: randomUUID(),
        name: "Git Diff",
        kind: "context",
        text: `Could not read git diff: ${String(err)}`,
      },
    ];
  }
}

async function pickFiles(folders: boolean): Promise<Attachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: !folders,
    canSelectFolders: folders,
    canSelectMany: !folders,
    openLabel: folders ? "Add folder" : "Add file",
  });
  if (!uris?.length) {
    return [];
  }
  return attachmentsFromUris(uris);
}

async function globFolder(rel: string, label: string): Promise<Attachment[]> {
  const cwd = workspaceCwd();
  if (!cwd) {
    return [];
  }
  const pattern = new vscode.RelativePattern(cwd, `${rel}/**`);
  const files = await vscode.workspace.findFiles(pattern, undefined, 40);
  if (!files.length) {
    return [
      {
        id: randomUUID(),
        name: label,
        kind: "context",
        text: `No ${label.toLowerCase()} files found under ${rel}`,
      },
    ];
  }
  return attachmentsFromUris(files);
}

async function terminal(): Promise<Attachment[]> {
  const term = vscode.window.activeTerminal;
  const cwd = workspaceCwd();
  if (term?.shellIntegration?.cwd) {
    return [
      {
        id: randomUUID(),
        name: "Terminal",
        kind: "context",
        text: `Active terminal: ${term.name}\ncwd: ${term.shellIntegration.cwd.fsPath}\n\nVS Code does not expose the full terminal buffer. Paste recent output if needed.`,
      },
    ];
  }
  return [
    {
      id: randomUUID(),
      name: "Terminal",
      kind: "context",
      text: `Active terminal: ${term?.name ?? "(none)"}\nworkspace: ${cwd ?? "(none)"}\nPaste recent terminal output for more detail.`,
    },
  ];
}

async function readLimited(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString("utf8");
    if (text.includes("\u0000")) {
      return undefined;
    }
    return `File: ${uri.fsPath}\n\n\`\`\`\n${text.slice(0, 80_000)}\n\`\`\``;
  } catch {
    return undefined;
  }
}
