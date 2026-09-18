import * as vscode from "vscode";
import type { FileChangeStatus, FileChangeView, ToolCallView } from "../shared/protocol";
import { writeTextToUri } from "./fs";
import { buildLineDiff } from "./toolDisplay";

export interface FileEdit {
  oldStr: string;
  newStr: string;
  matchedNewStr?: string;
}

export interface HighlightSpan {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface FileChange {
  path: string;
  relative: string;
  basename: string;
  status: FileChangeStatus;
  edits: FileEdit[];
  beforeText?: string;
  afterText?: string;
  span?: HighlightSpan;
  spans: HighlightSpan[];
  startLine?: number;
}

const SKIP_KINDS = new Set(["read", "search", "execute"]);
const SKIP_COMMANDS = /\b(read|grep|glob|search|ls|list_dir|execute|bash|shell|terminal)\b/i;

export function fileEditFromCall(call: ToolCallView): (FileEdit & { path: string; startLine?: number }) | undefined {
  if (!call.path) {
    return undefined;
  }
  if (!call.oldStr && !call.newStr) {
    return undefined;
  }
  const kind = (call.kind ?? "").toLowerCase();
  const command = call.command ?? "";
  if (SKIP_KINDS.has(kind) || SKIP_COMMANDS.test(command)) {
    return undefined;
  }
  return {
    path: toFsPath(call.path),
    oldStr: call.oldStr ?? "",
    newStr: call.newStr ?? "",
    startLine: call.startLine,
  };
}

export function isCompletedTool(status?: string): boolean {
  return /^(completed|success)$/i.test(status ?? "");
}

export class FileChangeStore {
  private readonly files = new Map<string, FileChange>();

  async record(path: string, oldStr: string, newStr: string, fallbackLine?: number): Promise<FileChange> {
    const fsPath = toFsPath(path);
    const key = normalize(fsPath);
    const snap = await captureSnapshot(fsPath, oldStr, newStr, fallbackLine);
    const existing = this.files.get(key);
    const edit: FileEdit = { oldStr, newStr, matchedNewStr: snap.matched };
    if (existing) {
      existing.edits.push(edit);
      existing.status = "pending";
      if (existing.beforeText === undefined) {
        existing.beforeText = snap.beforeText;
      }
      existing.afterText = snap.afterText ?? existing.afterText;
      refreshSpans(existing, snap.afterText, snap.span, snap.startLine);
      return existing;
    }
    const uri = vscode.Uri.file(fsPath);
    const entry: FileChange = {
      path: fsPath,
      relative: vscode.workspace.asRelativePath(uri, false),
      basename: basename(fsPath),
      status: "pending",
      edits: [edit],
      beforeText: snap.beforeText,
      afterText: snap.afterText,
      span: snap.span,
      spans: [],
      startLine: snap.startLine,
    };
    refreshSpans(entry, snap.afterText, snap.span, snap.startLine);
    this.files.set(key, entry);
    return entry;
  }

  async upgradeLast(path: string, oldStr: string, newStr: string, fallbackLine?: number): Promise<FileChange | undefined> {
    const entry = this.get(path);
    const last = entry?.edits.at(-1);
    if (!entry || !last || last.newStr) {
      return undefined;
    }
    last.oldStr = oldStr;
    last.newStr = newStr;
    const snap = await captureSnapshot(entry.path, oldStr, newStr, fallbackLine);
    last.matchedNewStr = snap.matched;
    if (entry.beforeText === undefined) {
      entry.beforeText = snap.beforeText;
    }
    entry.afterText = snap.afterText ?? entry.afterText;
    refreshSpans(entry, snap.afterText, snap.span, snap.startLine);
    entry.status = "pending";
    return entry;
  }

  remove(path: string): void {
    const fsPath = toFsPath(path);
    const key = normalize(fsPath);
    const base = basename(fsPath);
    let removed = false;
    for (const [id, entry] of [...this.files.entries()]) {
      if (
        id === key ||
        entry.path === path ||
        entry.path === fsPath ||
        entry.relative === path ||
        normalize(entry.path) === key
      ) {
        this.files.delete(id);
        removed = true;
      }
    }
    if (!removed && base) {
      for (const [id, entry] of [...this.files.entries()]) {
        if (entry.basename === base) {
          this.files.delete(id);
        }
      }
    }
  }

  get(path: string): FileChange | undefined {
    const fsPath = toFsPath(path);
    const key = normalize(fsPath);
    const direct = this.files.get(key);
    if (direct) {
      return direct;
    }
    const base = basename(fsPath);
    return [...this.files.values()].find(
      (entry) =>
        entry.path === path ||
        entry.path === fsPath ||
        entry.relative === path ||
        normalize(entry.path) === key ||
        (base !== undefined && entry.basename === base),
    );
  }

  lastNeedle(path: string): string | undefined {
    const edits = this.get(path)?.edits;
    if (!edits?.length) {
      return undefined;
    }
    for (let i = edits.length - 1; i >= 0; i--) {
      if (edits[i].matchedNewStr) {
        return edits[i].matchedNewStr;
      }
      if (edits[i].newStr) {
        return edits[i].newStr;
      }
    }
    return undefined;
  }

  list(): FileChangeView[] {
    return this.pending().map(({ path, relative, basename, status, startLine }) => ({
      path,
      relative,
      basename,
      status,
      startLine,
    }));
  }

  pending(): FileChange[] {
    return [...this.files.values()].filter((file) => file.status === "pending");
  }
}

export class FileChangeHighlighter implements vscode.Disposable {
  private readonly lineType: vscode.TextEditorDecorationType;
  private readonly inlineType: vscode.TextEditorDecorationType;
  private readonly needles = new Map<string, string>();
  private readonly spans = new Map<string, HighlightSpan[]>();
  private readonly lines = new Map<string, number>();
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.lineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(80, 200, 120, 0.28)",
      overviewRulerColor: "rgba(80, 200, 120, 0.85)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: "rgba(80, 200, 120, 0.95)",
    });
    this.inlineType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(80, 200, 120, 0.35)",
      overviewRulerColor: "rgba(80, 200, 120, 0.85)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          event.document.uri.scheme === "file" &&
          (this.spans.has(normalize(event.document.uri.fsPath)) ||
            this.needles.has(normalize(event.document.uri.fsPath)))
        ) {
          this.paintAll();
        }
      }),
      vscode.languages.registerHoverProvider({ scheme: "file" }, {
        provideHover: (document, position) => this.provideHover(document, position),
      }),
    );
  }

  async reveal(
    path: string,
    opts: {
      needle?: string;
      span?: HighlightSpan;
      spans?: HighlightSpan[];
      fallbackLine?: number;
      preserveFocus?: boolean;
    } = {},
  ): Promise<void> {
    const fsPath = toFsPath(path);
    const key = normalize(fsPath);
    if (opts.needle) {
      this.needles.set(key, opts.needle);
    }
    if (opts.spans?.length) {
      this.spans.set(key, opts.spans);
    } else if (opts.span) {
      this.spans.set(key, mergeSpans([...(this.spans.get(key) ?? []), opts.span]));
    }
    if (opts.fallbackLine !== undefined) {
      this.lines.set(key, opts.fallbackLine);
    }
    try {
      const uri = vscode.Uri.file(fsPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: opts.preserveFocus ?? false,
      });
      const range = focusRange(doc, {
        spans: this.spans.get(key),
        needle: this.needles.get(key),
        fallbackLine: this.lines.get(key),
        prefer: opts.span,
      });
      if (range) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        if (!opts.preserveFocus) {
          editor.selection = new vscode.Selection(range.start, range.start);
        }
      }
    } catch {
      /* file may not be on disk yet */
    }
    this.paintAll();
  }

  clear(path?: string): void {
    if (path) {
      const key = normalize(toFsPath(path));
      this.needles.delete(key);
      this.spans.delete(key);
      this.lines.delete(key);
    } else {
      this.needles.clear();
      this.spans.clear();
      this.lines.clear();
    }
    this.paintAll();
  }

  dispose(): void {
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.lineType.dispose();
    this.inlineType.dispose();
    this.needles.clear();
    this.spans.clear();
    this.lines.clear();
  }

  private paintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== "file") {
        continue;
      }
      const key = normalize(editor.document.uri.fsPath);
      const ranges = rangesForDocument(editor.document, {
        spans: this.spans.get(key),
        needle: this.needles.get(key),
        fallbackLine: this.lines.get(key),
      });
      if (!ranges.length) {
        editor.setDecorations(this.lineType, []);
        editor.setDecorations(this.inlineType, []);
        continue;
      }
      const hover = keepUndoMarkdown(editor.document.uri.fsPath);
      const lineOpts: vscode.DecorationOptions[] = [];
      const inlineOpts: vscode.DecorationOptions[] = [];
      for (const range of ranges) {
        const options: vscode.DecorationOptions = { range, hoverMessage: hover };
        if (isWholeLine(editor.document, range) || range.start.line !== range.end.line) {
          lineOpts.push(options);
        } else {
          inlineOpts.push(options);
        }
      }
      editor.setDecorations(this.lineType, lineOpts);
      editor.setDecorations(this.inlineType, inlineOpts);
    }
  }

  private provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (document.uri.scheme !== "file") {
      return undefined;
    }
    const key = normalize(document.uri.fsPath);
    const ranges = rangesForDocument(document, {
      spans: this.spans.get(key),
      needle: this.needles.get(key),
      fallbackLine: this.lines.get(key),
    });
    const range = ranges.find((item) => {
      const hoverRange = new vscode.Range(
        item.start.line,
        0,
        item.end.line,
        document.lineAt(item.end.line).range.end.character,
      );
      return hoverRange.contains(position);
    });
    if (!range) {
      return undefined;
    }
    const hoverRange = new vscode.Range(
      range.start.line,
      0,
      range.end.line,
      document.lineAt(range.end.line).range.end.character,
    );
    return new vscode.Hover(keepUndoMarkdown(document.uri.fsPath), hoverRange);
  }
}

function keepUndoMarkdown(path: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;
  const keep = encodeURIComponent(JSON.stringify([path]));
  const undo = encodeURIComponent(JSON.stringify([path]));
  md.appendMarkdown(`[Keep](command:kiroChat.keepFile?${keep}) &nbsp;|&nbsp; [Undo](command:kiroChat.undoFile?${undo})`);
  return md;
}

export async function revertFileChange(entry: FileChange): Promise<{ applied: number; skipped: number }> {
  const uri = vscode.Uri.file(entry.path);
  const disk = await readDiskText(entry.path);
  const editor = editorDocument(entry.path)?.getText();
  const current =
    [disk, editor].find((text) => text !== undefined && canRestoreSnapshot(text, entry)) ?? editor ?? disk;
  if (current === undefined) {
    return { applied: 0, skipped: Math.max(1, entry.edits.length) };
  }

  if (entry.beforeText !== undefined) {
    if (!canRestoreSnapshot(current, entry)) {
      return { applied: 0, skipped: entry.edits.length };
    }
    const created = entry.edits.some((edit) => !edit.oldStr && edit.newStr);
    if (created && entry.beforeText.length === 0) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        await writeTextToUri(uri, "");
      }
      return { applied: 1, skipped: 0 };
    }
    await writeTextToUri(uri, entry.beforeText);
    return { applied: 1, skipped: 0 };
  }

  return revertBySnippets(entry, current);
}

async function revertBySnippets(entry: FileChange, text: string): Promise<{ applied: number; skipped: number }> {
  let next = text;
  let applied = 0;
  let skipped = 0;
  for (const edit of [...entry.edits].reverse()) {
    const needle = edit.matchedNewStr || edit.newStr;
    if (!needle) {
      skipped++;
      continue;
    }
    const found = findSnippet(next, needle) ?? findSnippet(next, edit.newStr);
    if (!found) {
      skipped++;
      continue;
    }
    next = next.slice(0, found.index) + edit.oldStr + next.slice(found.index + found.length);
    applied++;
  }
  if (!applied) {
    return { applied, skipped };
  }
  const uri = vscode.Uri.file(entry.path);
  const created = entry.edits.some((edit) => !edit.oldStr && edit.newStr);
  if (created && next.length === 0) {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    return { applied, skipped };
  }
  await writeTextToUri(uri, next);
  return { applied, skipped };
}

function canRestoreSnapshot(current: string, entry: FileChange): boolean {
  if (entry.afterText !== undefined && (current === entry.afterText || eol(current) === eol(entry.afterText))) {
    return true;
  }
  return entry.edits.some((edit) => {
    const needle = edit.matchedNewStr || edit.newStr;
    return Boolean(needle && findSnippet(current, needle));
  });
}

async function captureSnapshot(
  fsPath: string,
  oldStr: string,
  newStr: string,
  fallbackLine?: number,
): Promise<{ beforeText?: string; afterText?: string; span?: HighlightSpan; startLine?: number; matched?: string }> {
  let disk = await readDiskText(fsPath);
  let editor = editorDocument(fsPath);
  let diskFound = disk ? findSnippet(disk, newStr) : undefined;
  let editorFound = editor ? findSnippet(editor.getText(), newStr) : undefined;
  if (!diskFound && !editorFound && newStr) {
    await delay(50);
    disk = await readDiskText(fsPath);
    editor = editorDocument(fsPath);
    diskFound = disk ? findSnippet(disk, newStr) : undefined;
    editorFound = editor ? findSnippet(editor.getText(), newStr) : undefined;
  }

  let afterText = disk ?? editor?.getText();
  let found = diskFound ?? editorFound;
  if (diskFound && disk) {
    afterText = disk;
    found = diskFound;
    if (editor && !editor.isDirty && editor.getText() !== disk) {
      await writeTextToUri(editor.uri, disk);
    }
  } else if (editorFound && editor) {
    afterText = editor.getText();
    found = editorFound;
  }

  let beforeText: string | undefined;
  let span: HighlightSpan | undefined;
  if (found && afterText !== undefined) {
    beforeText = afterText.slice(0, found.index) + oldStr + afterText.slice(found.index + found.length);
    span = offsetToSpan(afterText, found.index, found.length);
  } else if (afterText !== undefined && oldStr) {
    const oldFound = findSnippet(afterText, oldStr);
    if (oldFound) {
      beforeText = afterText;
    }
  }

  const startLine = span ? span.startLine + 1 : fallbackLine;
  return { beforeText, afterText, span, startLine, matched: found?.matched };
}

async function readDiskText(fsPath: string): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString("utf8");
  } catch {
    return undefined;
  }
}

function editorDocument(fsPath: string): vscode.TextDocument | undefined {
  const key = normalize(fsPath);
  return vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && normalize(doc.uri.fsPath) === key);
}

interface SnippetHit {
  index: number;
  length: number;
  matched: string;
}

function findSnippet(text: string, needle: string): SnippetHit | undefined {
  if (!needle) {
    return undefined;
  }
  const candidates = unique([needle, needle.replace(/\r\n/g, "\n"), needle.replace(/\n/g, "\r\n"), needle.trim()]);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const idx = text.indexOf(candidate);
    if (idx >= 0) {
      return { index: idx, length: candidate.length, matched: candidate };
    }
  }
  const trimmed = needle.trim();
  if (!trimmed) {
    return undefined;
  }
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    const pos = raw.indexOf(trimmed);
    if (pos >= 0) {
      return { index: offset + pos, length: trimmed.length, matched: trimmed };
    }
    offset += line.length + 1;
  }
  return undefined;
}

function rangeForDocument(
  doc: vscode.TextDocument,
  opts: { span?: HighlightSpan; needle?: string; fallbackLine?: number },
): vscode.Range | undefined {
  return rangesForDocument(doc, {
    spans: opts.span ? [opts.span] : undefined,
    needle: opts.needle,
    fallbackLine: opts.fallbackLine,
  })[0];
}

function rangesForDocument(
  doc: vscode.TextDocument,
  opts: { spans?: HighlightSpan[]; needle?: string; fallbackLine?: number },
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const span of opts.spans ?? []) {
    const range = spanToRange(doc, span);
    if (range) {
      ranges.push(range);
    }
  }
  if (!ranges.length && opts.needle) {
    const text = doc.getText();
    let from = 0;
    const needle = opts.needle;
    while (from < text.length) {
      const slice = text.slice(from);
      const found = findSnippet(slice, needle);
      if (!found) {
        break;
      }
      const start = from + found.index;
      ranges.push(new vscode.Range(doc.positionAt(start), doc.positionAt(start + found.length)));
      from = start + Math.max(found.length, 1);
    }
  }
  if (!ranges.length && opts.fallbackLine !== undefined) {
    const line = Math.max(0, Math.min(doc.lineCount - 1, opts.fallbackLine - 1));
    ranges.push(doc.lineAt(line).range);
  }
  return ranges;
}

function focusRange(
  doc: vscode.TextDocument,
  opts: { spans?: HighlightSpan[]; needle?: string; fallbackLine?: number; prefer?: HighlightSpan },
): vscode.Range | undefined {
  if (opts.prefer) {
    const preferred = spanToRange(doc, opts.prefer);
    if (preferred) {
      return preferred;
    }
  }
  const ranges = rangesForDocument(doc, opts);
  return ranges.at(-1) ?? ranges[0];
}

function refreshSpans(
  entry: FileChange,
  afterText?: string,
  latest?: HighlightSpan,
  fallbackLine?: number,
): void {
  const text = afterText ?? entry.afterText;
  const spans: HighlightSpan[] = [];
  if (entry.beforeText !== undefined && text !== undefined) {
    spans.push(...spansFromLineDiff(entry.beforeText, text));
  }
  if (text) {
    for (const edit of entry.edits) {
      const needle = edit.matchedNewStr || edit.newStr;
      if (!needle) {
        continue;
      }
      const found = findSnippet(text, needle);
      if (found) {
        spans.push(offsetToSpan(text, found.index, found.length));
      }
    }
  }
  if (latest) {
    spans.push(latest);
  }
  entry.spans = mergeSpans(spans);
  entry.span = latest ?? entry.spans.at(-1);
  if (entry.span) {
    entry.startLine = entry.span.startLine + 1;
  } else if (fallbackLine !== undefined) {
    entry.startLine = fallbackLine;
  }
}

function spansFromLineDiff(before: string, after: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const line of buildLineDiff(before, after)) {
    if (line.type !== "add" || line.newLine === undefined) {
      continue;
    }
    const i = Math.max(0, line.newLine - 1);
    spans.push({
      startLine: i,
      startChar: 0,
      endLine: i,
      endChar: Math.max(line.text.length, 1),
    });
  }
  return spans;
}

function mergeSpans(spans: HighlightSpan[]): HighlightSpan[] {
  if (!spans.length) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.startChar - b.startChar);
  const out: HighlightSpan[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && span.startLine <= last.endLine + 1) {
      if (span.endLine > last.endLine) {
        last.endLine = span.endLine;
        last.endChar = span.endChar;
      } else if (span.endLine === last.endLine) {
        last.endChar = Math.max(last.endChar, span.endChar);
      }
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

function spanToRange(doc: vscode.TextDocument, span: HighlightSpan): vscode.Range | undefined {
  if (doc.lineCount === 0) {
    return undefined;
  }
  const startLine = clamp(span.startLine, 0, doc.lineCount - 1);
  const endLine = clamp(span.endLine, 0, doc.lineCount - 1);
  const start = new vscode.Position(startLine, clamp(span.startChar, 0, doc.lineAt(startLine).text.length));
  const end = new vscode.Position(endLine, clamp(span.endChar, 0, doc.lineAt(endLine).text.length));
  return new vscode.Range(start, end);
}

function offsetToSpan(text: string, index: number, length: number): HighlightSpan {
  const start = positionAt(text, index);
  const end = positionAt(text, index + length);
  return {
    startLine: start.line,
    startChar: start.character,
    endLine: end.line,
    endChar: end.character,
  };
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  const sliced = text.slice(0, Math.max(0, offset));
  const lines = sliced.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
}

function isWholeLine(doc: vscode.TextDocument, range: vscode.Range): boolean {
  if (range.start.line !== range.end.line) {
    return true;
  }
  const line = doc.lineAt(range.start.line);
  return range.start.character === 0 && range.end.character >= line.text.length;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function eol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toFsPath(path: string): string {
  if (path.startsWith("file:")) {
    try {
      return vscode.Uri.parse(path).fsPath;
    } catch {
      return path;
    }
  }
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
    return path;
  }
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root) {
    return vscode.Uri.joinPath(root.uri, path).fsPath;
  }
  return path;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function normalize(path: string): string {
  const slash = path.replace(/\\/g, "/");
  return process.platform === "win32" ? slash.toLowerCase() : slash;
}
