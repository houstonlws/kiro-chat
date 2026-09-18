import type { DiffLine, ToolCallView, ToolDetail, ToolDiff } from "../shared/protocol";

export interface ToolCallUpdateLike {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  name?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: Array<{ path?: string; line?: number | null }> | null;
}

const SKIP_DETAIL_KEYS = new Set([
  "__tool_use_purpose",
  "command",
  "path",
  "oldStr",
  "newStr",
  "old_str",
  "new_str",
  "old_string",
  "new_string",
  "oldText",
  "newText",
  "old_text",
  "new_text",
]);

export function applyToolCallUpdate(call: ToolCallView, update: ToolCallUpdateLike): void {
  if (update.kind) {
    call.kind = update.kind;
  }
  if (update.status) {
    call.status = update.status;
  }

  const input = asRecord(update.rawInput);
  if (input) {
    const purpose = pickString(input, "__tool_use_purpose", "purpose", "description");
    const command = pickString(input, "command", "tool", "name") ?? update.name ?? undefined;
    const path =
      pickString(input, "path", "file", "file_path", "filePath", "uri") ?? pathFromLocations(update.locations);
    if (purpose) {
      call.purpose = purpose;
    }
    if (command) {
      call.command = command;
    }
    if (path) {
      call.path = path;
    }
    const line = update.locations?.find((loc) => loc.line != null)?.line ?? undefined;
    if (line !== undefined && line !== null) {
      call.startLine = line;
    }
    const oldText = pickMaybeString(input, "oldStr", "old_str", "old_string", "oldText", "old_text");
    const newText = pickMaybeString(input, "newStr", "new_str", "new_string", "newText", "new_text");
    if (oldText !== undefined || newText !== undefined) {
      call.oldStr = oldText ?? "";
      call.newStr = newText ?? "";
      call.diff = {
        path: call.path ?? "",
        lines: buildLineDiff(call.oldStr, call.newStr),
      };
    }
    const details = leftoverDetails(input);
    if (details.length) {
      call.details = details;
    }
  } else if (update.locations?.length) {
    const path = pathFromLocations(update.locations);
    if (path) {
      call.path = path;
    }
    const line = update.locations.find((loc) => loc.line != null)?.line ?? undefined;
    if (line !== undefined && line !== null) {
      call.startLine = line;
    }
  }

  applyContent(call, update.content);
  const locLine = update.locations?.find((loc) => loc.line != null)?.line;
  if (locLine != null) {
    call.startLine = locLine;
  }

  if (update.rawOutput !== undefined) {
    const summary = parseSummary(update.rawOutput);
    if (summary) {
      call.summary = summary;
    }
  }

  call.title = displayTitle(call, update.title);
}

function applyContent(call: ToolCallView, content: unknown): void {
  if (!Array.isArray(content)) {
    if (content !== undefined && !call.summary) {
      const summary = parseSummary(content);
      if (summary) {
        call.summary = summary;
      }
    }
    return;
  }
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.type === "diff") {
      const path = typeof rec.path === "string" ? rec.path : call.path ?? "";
      const hasOld = typeof rec.oldText === "string";
      const hasNew = typeof rec.newText === "string";
      if (hasOld || hasNew) {
        call.path = path || call.path;
        if (hasOld && call.oldStr === undefined) {
          call.oldStr = rec.oldText as string;
        }
        if (hasNew && call.newStr === undefined) {
          call.newStr = rec.newText as string;
        }
        call.diff = {
          path,
          lines: buildLineDiff(hasOld ? (rec.oldText as string) : "", hasNew ? (rec.newText as string) : ""),
        };
      }
      continue;
    }
    if (rec.type === "content" && rec.content && typeof rec.content === "object") {
      const inner = rec.content as Record<string, unknown>;
      if (inner.type === "text" && typeof inner.text === "string") {
        texts.push(inner.text);
      }
      continue;
    }
    if (rec.type === "text" && typeof rec.text === "string") {
      texts.push(rec.text);
    }
  }
  if (texts.length && !call.summary) {
    call.summary = texts.join("\n").trim();
  }
}

function displayTitle(call: ToolCallView, acpTitle?: string | null): string {
  if (call.purpose) {
    return call.purpose;
  }
  if (call.command && call.path) {
    return `${call.command} ${basename(call.path)}`;
  }
  if (call.command) {
    return call.command;
  }
  if (acpTitle) {
    return acpTitle;
  }
  return call.title || "Tool";
}

function leftoverDetails(input: Record<string, unknown>): ToolDetail[] {
  const details: ToolDetail[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (SKIP_DETAIL_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.length > 400) {
      continue;
    }
    details.push({ label: key, value: formatValue(value) });
  }
  return details;
}

function parseSummary(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return looksLikeJson(trimmed) ? parseSummary(tryParse(trimmed)) : trimmed || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          return pickString(rec, "Text", "text", "message", "output") ?? "";
        }
        return "";
      })
      .filter(Boolean);
    return parts.length ? parts.join("\n") : undefined;
  }
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  if (Array.isArray(rec.items)) {
    return parseSummary(rec.items);
  }
  return pickString(rec, "Text", "text", "message", "output", "result", "stdout");
}

export function buildLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  return toHunks(ops);
}

type Op = { kind: "eq" | "del" | "add"; text: string };

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split("\n");
}

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const prefix = a.slice(0, start).map((text) => ({ kind: "eq" as const, text }));
  const suffix = a.slice(endA + 1).map((text) => ({ kind: "eq" as const, text }));
  return [...prefix, ...middleDiff(a.slice(start, endA + 1), b.slice(start, endB + 1)), ...suffix];
}

function middleDiff(a: string[], b: string[]): Op[] {
  if (!a.length) {
    return b.map((text) => ({ kind: "add" as const, text }));
  }
  if (!b.length) {
    return a.map((text) => ({ kind: "del" as const, text }));
  }
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  return lcsDiff(a, b);
}

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i++] });
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j++] });
  }
  return out;
}

function toHunks(ops: Op[]): DiffLine[] {
  const CONTEXT = 3;
  const indexed = indexOps(ops);
  const changeIdx = indexed.map((op, i) => (op.kind === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (!changeIdx.length) {
    if (!indexed.length) {
      return [];
    }
    return indexed.map((op) => ({
      type: "context" as const,
      text: op.text,
      oldLine: op.oldLine,
      newLine: op.newLine,
    }));
  }
  const regions: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(indexed.length, idx + CONTEXT + 1);
    const last = regions.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      regions.push({ start, end });
    }
  }
  const lines: DiffLine[] = [];
  for (const region of regions) {
    const slice = indexed.slice(region.start, region.end);
    const hasContext = slice.some((op) => op.kind === "eq");
    if (hasContext) {
      const first = slice[0];
      const oldCount = slice.filter((op) => op.kind !== "add").length;
      const newCount = slice.filter((op) => op.kind !== "del").length;
      const oldStart = first.oldLine ?? 1;
      const newStart = first.newLine ?? 1;
      lines.push({
        type: "hunk",
        text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      });
    }
    for (const op of slice) {
      if (op.kind === "eq") {
        lines.push({ type: "context", text: op.text, oldLine: op.oldLine, newLine: op.newLine });
      } else if (op.kind === "del") {
        lines.push({ type: "del", text: op.text, oldLine: op.oldLine });
      } else {
        lines.push({ type: "add", text: op.text, newLine: op.newLine });
      }
    }
  }
  return lines;
}

function indexOps(ops: Op[]): Array<Op & { oldLine?: number; newLine?: number }> {
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    if (op.kind === "eq") {
      const row = { ...op, oldLine, newLine };
      oldLine++;
      newLine++;
      return row;
    }
    if (op.kind === "del") {
      const row = { ...op, oldLine };
      oldLine++;
      return row;
    }
    const row = { ...op, newLine };
    newLine++;
    return row;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return asRecord(tryParse(value));
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function pickString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length) {
      return value;
    }
  }
  return undefined;
}

function pickMaybeString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function pathFromLocations(locations?: Array<{ path?: string }> | null): string | undefined {
  const path = locations?.find((loc) => loc.path)?.path;
  return path || undefined;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 237)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 237)}…` : json;
  } catch {
    return String(value);
  }
}

