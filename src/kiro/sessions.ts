import { runCli } from "./process";
import type { HistoryItem } from "../shared/protocol";
import { info } from "../logger";
import { workspaceCwd } from "../settings";

export async function listCliSessions(): Promise<HistoryItem[]> {
  const cwd = workspaceCwd();
  if (!cwd) {
    return [];
  }
  try {
    const { stdout } = await runCli(["chat", "--list-sessions", "--format", "json"], cwd);
    const parsed = JSON.parse(stdout) as unknown;
    const items = normalize(parsed);
    if (items.length) {
      return items;
    }
  } catch (err) {
    info(`list-sessions json failed: ${String(err)}`);
  }
  try {
    const { stdout } = await runCli(["chat", "--list-sessions"], cwd);
    return parseText(stdout);
  } catch (err) {
    info(`list-sessions failed: ${String(err)}`);
    return [];
  }
}

function normalize(parsed: unknown): HistoryItem[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? ((parsed as { sessions: unknown[] }).sessions)
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const rec = row as Record<string, unknown>;
    const sessionId = String(rec.id ?? rec.sessionId ?? rec.session_id ?? "");
    if (!sessionId) {
      return [];
    }
    const updated =
      typeof rec.updatedAt === "number"
        ? rec.updatedAt
        : Date.parse(String(rec.updatedAt ?? rec.updated_at ?? rec.timestamp ?? Date.now())) || Date.now();
    const item: HistoryItem = {
      id: sessionId,
      sessionId,
      title: String(rec.title ?? rec.name ?? "Session"),
      updatedAt: updated,
      active: false,
    };
    return [item];
  });
}

function parseText(stdout: string): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(id|session|----)/i.test(trimmed)) {
      continue;
    }
    const uuid = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!uuid) {
      continue;
    }
    const title = trimmed.replace(uuid[0], "").replace(/^[|\-\s]+|[|\-\s]+$/g, "") || "Session";
    items.push({
      id: uuid[0],
      sessionId: uuid[0],
      title,
      updatedAt: Date.now(),
      active: false,
    });
  }
  return items;
}
