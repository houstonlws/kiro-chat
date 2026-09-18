import { useCallback, useRef, useState } from "react";
import type { AgentOption, ModelOption, SessionTab } from "../shared/protocol";
import { CONTEXT_MENU_ITEMS } from "../shared/protocol";
import { post } from "./vscodeApi";
import { Popover } from "./Popover";

export function Composer({
  tab,
  models,
  agents,
  autopilot,
  disabled,
}: {
  tab?: SessionTab;
  models: ModelOption[];
  agents: AgentOption[];
  autopilot: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const closeMenus = useCallback(() => {
    setContextOpen(false);
    setModelOpen(false);
    setAgentOpen(false);
  }, []);

  if (!tab) {
    return null;
  }

  const running = tab.running;
  const send = () => {
    if (running) {
      post({ type: "cancel", tabId: tab.id });
      return;
    }
    if (!text.trim() && !tab.attachments.length) {
      return;
    }
    post({ type: "send", tabId: tab.id, text });
    setText("");
  };

  const currentModel = models.find((m) => m.id === tab.currentModelId) ?? models[0];
  const currentAgent = agents.find((a) => a.id === tab.currentAgentId) ?? agents[0];

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void readFiles(e.dataTransfer.files);
      }}
    >
      {tab.attachments.length > 0 && (
        <div className="chips">
          {tab.attachments.map((att) => (
            <span className="chip" key={att.id}>
              {att.name}
              <button
                type="button"
                onClick={() => post({ type: "removeAttachment", tabId: tab.id, attachmentId: att.id })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          value={text}
          disabled={disabled}
          placeholder="Ask a question or describe a task..."
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className={`send ${running ? "stop" : ""}`}
          onClick={send}
          disabled={disabled}
          title={running ? "Cancel" : "Send"}
        >
          {running ? "■" : "↑"}
        </button>
      </div>
      <div className="composer-bar">
        <div className="left">
          <Popover
            open={contextOpen}
            onClose={closeMenus}
            trigger={
              <button
                type="button"
                className="icon-btn"
                title="Add context"
                onClick={() => {
                  setModelOpen(false);
                  setAgentOpen(false);
                  setContextOpen((value) => !value);
                }}
              >
                #
              </button>
            }
          >
            <div className="menu-title">Select context type</div>
            {CONTEXT_MENU_ITEMS.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  closeMenus();
                  post({ type: "pickContext", kind: item.id });
                }}
              >
                {item.label}
              </button>
            ))}
          </Popover>
          <button type="button" className="icon-btn" title="Attach image or document" onClick={() => fileRef.current?.click()}>
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              if (e.target.files) {
                void readFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <Popover
            open={modelOpen}
            onClose={closeMenus}
            wide
            trigger={
              <button
                type="button"
                className="text-btn"
                disabled={running}
                onClick={() => {
                  setContextOpen(false);
                  setAgentOpen(false);
                  setModelOpen((value) => !value);
                }}
              >
                {currentModel?.name ?? "Auto"} ▾
              </button>
            }
          >
            {models.map((model) => (
              <button
                type="button"
                key={model.id}
                className={model.id === tab.currentModelId ? "selected" : ""}
                onClick={() => {
                  closeMenus();
                  post({ type: "setModel", tabId: tab.id, modelId: model.id });
                }}
              >
                <strong>{model.name}</strong>
                {model.description ? <span className="muted">{model.description}</span> : null}
              </button>
            ))}
          </Popover>
        </div>
        <div className="right">
          <Popover
            open={agentOpen}
            onClose={closeMenus}
            align="right"
            wide
            trigger={
              <button
                type="button"
                className="text-btn"
                disabled={running}
                onClick={() => {
                  setContextOpen(false);
                  setModelOpen(false);
                  setAgentOpen((value) => !value);
                }}
              >
                {currentAgent?.name ?? "Default"} ▾
              </button>
            }
          >
            {renderAgentGroups(agents, tab.currentAgentId, (id) => {
              closeMenus();
              post({ type: "setAgent", tabId: tab.id, agentId: id });
            })}
          </Popover>
          <label className="autopilot">
            Autopilot
            <span className={`switch ${autopilot ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={autopilot}
                onChange={(e) => post({ type: "setAutopilot", value: e.target.checked })}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

function renderAgentGroups(
  agents: AgentOption[],
  current: string,
  onPick: (id: string) => void,
) {
  const groups: { key: AgentOption["group"]; label: string }[] = [
    { key: "built-in", label: "BUILT-IN" },
    { key: "mode", label: "MODES" },
    { key: "workspace", label: "WORKSPACE" },
    { key: "global", label: "GLOBAL" },
  ];
  return groups.map((group) => {
    const items = agents.filter((a) => a.group === group.key);
    if (!items.length) {
      return null;
    }
    return (
      <div key={group.key}>
        <div className="menu-title">{group.label}</div>
        {items.map((agent) => (
          <button
            type="button"
            key={agent.id}
            className={agent.id === current ? "selected" : ""}
            onClick={() => onPick(agent.id)}
          >
            <strong>{agent.name}</strong>
            {agent.description ? <span className="muted">{agent.description}</span> : null}
          </button>
        ))}
      </div>
    );
  });
}

async function readFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    const isImage = file.type.startsWith("image/");
    const dataBase64 = await toBase64(file);
    post({
      type: "attachDropped",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64,
      isImage,
    });
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
