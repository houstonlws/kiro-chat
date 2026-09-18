import { runCli } from "./process";
import type { ModelOption } from "../shared/protocol";
import { info } from "../logger";

const FALLBACK: ModelOption[] = [
  { id: "auto", name: "Auto", description: "Models chosen by task for optimal usage and consistent quality" },
];

export async function listModels(): Promise<ModelOption[]> {
  try {
    const { stdout } = await runCli(["chat", "--list-models", "--format", "json"]);
    const parsed = JSON.parse(stdout) as unknown;
    const models = normalize(parsed);
    if (models.length) {
      return [FALLBACK[0], ...models.filter((m) => m.id !== "auto")];
    }
  } catch (err) {
    info(`list-models json failed: ${String(err)}`);
  }
  try {
    const { stdout } = await runCli(["chat", "--list-models"]);
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("-") && !/^models?:/i.test(line))
      .map((line) => {
        const [id, ...rest] = line.split(/\s{2,}|\t/);
        return { id: id.replace(/^[\*\-]\s*/, ""), name: rest.join(" ") || id };
      });
    if (models.length) {
      return [FALLBACK[0], ...models.filter((m) => m.id !== "auto")];
    }
  } catch (err) {
    info(`list-models text failed: ${String(err)}`);
  }
  return FALLBACK;
}

function normalize(parsed: unknown): ModelOption[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : [];
  return rows
    .map((row) => {
      if (typeof row === "string") {
        return { id: row, name: row };
      }
      if (row && typeof row === "object") {
        const rec = row as Record<string, unknown>;
        const id = String(rec.id ?? rec.modelId ?? rec.name ?? "");
        if (!id) {
          return undefined;
        }
        return {
          id,
          name: String(rec.name ?? rec.displayName ?? id),
          description: rec.description ? String(rec.description) : undefined,
        };
      }
      return undefined;
    })
    .filter((m): m is ModelOption => Boolean(m));
}
