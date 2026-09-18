import { Component, type ReactNode, useEffect, useState } from "react";
import type { UiState } from "../shared/protocol";
import { listen, post, vscode } from "./vscodeApi";
import { ChangedFiles } from "./ChangedFiles";
import { Composer } from "./Composer";
import { Landing } from "./Landing";
import { SessionList } from "./SessionList";
import { Chat } from "./Chat";

const empty: UiState = {
  view: "landing",
  workspaceOpen: true,
  connected: false,
  connecting: true,
  autopilot: false,
  showAutopilotBanner: false,
  showCheckpointRestore: false,
  tabs: [],
  history: [],
  models: [],
  agents: [],
  contextOpen: false,
  changedFiles: [],
};

function hydrate(state?: Partial<UiState> | null): UiState {
  return {
    ...empty,
    ...state,
    tabs: Array.isArray(state?.tabs) ? state.tabs : [],
    history: Array.isArray(state?.history) ? state.history : [],
    models: Array.isArray(state?.models) ? state.models : [],
    agents: Array.isArray(state?.agents) ? state.agents : [],
    changedFiles: Array.isArray(state?.changedFiles) ? state.changedFiles : [],
  };
}

export class PanelErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render(): ReactNode {
    if (this.state.error) {
      return <div className="banner error">{this.state.error}</div>;
    }
    return this.props.children;
  }
}

export function App() {
  const [state, setState] = useState<UiState>(() => hydrate(vscode.getState()?.state));

  useEffect(() => {
    const stop = listen((message) => {
      if (message.type === "state") {
        const next = hydrate(message.state);
        setState(next);
        vscode.setState({ state: next });
      }
    });
    post({ type: "ready" });
    return stop;
  }, []);

  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];

  const changedFiles = state.changedFiles ?? [];

  return (
    <div className="app">
      <header className="tabs">
        <div className="tab-scroll">
          {state.tabs.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`tab ${item.id === tab?.id ? "active" : ""}`}
              onClick={() => post({ type: "selectTab", tabId: item.id })}
            >
              <span>{item.title}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ type: "closeSession", tabId: item.id });
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <div className="tab-actions">
          <button type="button" className="icon-btn" title="New session" onClick={() => post({ type: "newSession" })}>
            +
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Session list"
            onClick={() => post({ type: state.view === "history" ? "hideHistory" : "showHistory" })}
          >
            ☰
          </button>
        </div>
      </header>
      {!state.workspaceOpen && <div className="banner">Open a folder to chat with the workspace.</div>}
      {state.connecting && <div className="banner">Connecting to kiro-cli…</div>}
      {state.error && (
        <div className="banner error">
          <span>{state.error}</span>
          <button type="button" className="banner-dismiss" title="Dismiss" onClick={() => post({ type: "dismissError" })}>
            ×
          </button>
        </div>
      )}
      {state.authHint && <div className="banner">{state.authHint}</div>}
      {state.showAutopilotBanner && (
        <div className="banner">Autopilot OFF: Kiro will ask for approval for making changes.</div>
      )}
      <main>
        {state.view === "history" ? (
          <SessionList tabs={state.tabs} history={state.history} />
        ) : tab && (state.view === "landing" || tab.empty) ? (
          <Landing tab={tab} />
        ) : tab ? (
          <Chat tab={tab} state={state} />
        ) : (
          <Landing tab={tab ?? emptyTab()} />
        )}
      </main>
      {state.view === "chat" && changedFiles.length > 0 ? <ChangedFiles files={changedFiles} /> : null}
      {state.view !== "history" && (
        <Composer
          tab={tab}
          models={state.models ?? []}
          agents={state.agents ?? []}
          autopilot={state.autopilot}
          disabled={!state.workspaceOpen}
        />
      )}
    </div>
  );
}

function emptyTab() {
  return {
    id: "pending",
    title: "New Session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    blocks: [],
    attachments: [],
    currentModelId: "auto",
    currentAgentId: "default",
    running: false,
    empty: true,
  };
}
