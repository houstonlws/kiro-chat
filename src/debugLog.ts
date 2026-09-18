import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

const INGEST = "http://127.0.0.1:7594/ingest/da3c68fa-3ee2-4065-82b9-221861837eca";
const SESSION = "e15303";

export function debugLog(
  location: string,
  message: string,
  data: unknown,
  hypothesisId: string,
  runId = "pre-fix",
): void {
  const entry = {
    sessionId: SESSION,
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  const line = `${JSON.stringify(entry)}\n`;
  const targets = [
    "/home/houston/Projects/kiro-chat/.cursor/debug-e15303.log",
    path.join(__dirname, "..", ".cursor", "debug-e15303.log"),
  ];
  for (const file of targets) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, line);
    } catch {
      /* ignore */
    }
  }
  fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": SESSION },
    body: JSON.stringify(entry),
  }).catch(() => {});
}
