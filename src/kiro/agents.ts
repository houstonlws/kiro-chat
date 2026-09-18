import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WORKFLOWS, type AgentOption } from "../shared/protocol";
import { workspaceCwd } from "../settings";

export function loadAgentOptions(availableModes?: { id: string; name?: string | null; description?: string | null }[]): AgentOption[] {
  const agents: AgentOption[] = [
    {
      id: "default",
      name: "Default",
      description: "General coding assistance",
      group: "built-in",
    },
  ];

  for (const wf of WORKFLOWS) {
    const match = availableModes?.find((mode) =>
      wf.aliases.some((alias) => mode.id.toLowerCase().includes(alias) || (mode.name ?? "").toLowerCase().includes(wf.name.toLowerCase())),
    );
    agents.push({
      id: match?.id ?? wf.id,
      name: wf.name,
      description: wf.description,
      group: "built-in",
    });
  }

  if (availableModes) {
    for (const mode of availableModes) {
      if (agents.some((a) => a.id === mode.id)) {
        continue;
      }
      agents.push({
        id: mode.id,
        name: mode.name || mode.id,
        description: mode.description ?? undefined,
        group: "mode",
      });
    }
  }

  for (const agent of readAgentDir(path.join(os.homedir(), ".kiro", "agents"), "global")) {
    if (!agents.some((a) => a.id === agent.id)) {
      agents.push(agent);
    }
  }
  const cwd = workspaceCwd();
  if (cwd) {
    for (const agent of readAgentDir(path.join(cwd, ".kiro", "agents"), "workspace")) {
      if (!agents.some((a) => a.id === agent.id)) {
        agents.push(agent);
      }
    }
  }
  return agents;
}

function readAgentDir(dir: string, group: "global" | "workspace"): AgentOption[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: AgentOption[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
        name?: string;
        description?: string;
      };
      const id = path.basename(file, ".json");
      out.push({
        id,
        name: raw.name || id,
        description: raw.description,
        group,
      });
    } catch {
      /* ignore malformed agent files */
    }
  }
  return out;
}

export function resolveWorkflowAgentId(workflowId: string, agents: AgentOption[]): string {
  const wf = WORKFLOWS.find((w) => w.id === workflowId || w.aliases.includes(workflowId));
  if (!wf) {
    return workflowId;
  }
  const found = agents.find((agent) =>
    wf.aliases.some(
      (alias) =>
        agent.id.toLowerCase() === alias ||
        agent.id.toLowerCase().includes(alias) ||
        agent.name.toLowerCase() === wf.name.toLowerCase(),
    ),
  );
  return found?.id ?? wf.id;
}

export function workflowModeCandidates(agentId: string, agents: AgentOption[]): string[] {
  const resolved = resolveWorkflowAgentId(agentId, agents);
  const wf = WORKFLOWS.find(
    (item) => item.id === agentId || item.aliases.includes(agentId) || item.id === resolved || item.aliases.includes(resolved),
  );
  const ids = [resolved, agentId, ...(wf?.aliases ?? [])];
  return [...new Set(ids.filter((id) => id && id !== "default"))];
}
