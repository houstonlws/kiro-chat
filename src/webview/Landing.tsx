import { useState } from "react";
import { isWorkflowSelected, WORKFLOWS, type SessionTab } from "../shared/protocol";
import { post } from "./vscodeApi";

export function Landing({ tab }: { tab: SessionTab }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="landing">
      <div className="landing-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="56" height="56">
          <circle cx="32" cy="32" r="30" fill="currentColor" opacity="0.08" />
          <path
            d="M18 24c0-4.4 3.6-8 8-8h12c4.4 0 8 3.6 8 8v10c0 4.4-3.6 8-8 8H31l-9 7v-7h-4c-4.4 0-8-3.6-8-8V24Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
          />
          <path d="M24 27h16M24 33h10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      </div>
      <h1>Let's build</h1>
      <p className="subtitle">Plan, search, or build anything</p>
      <div className="workflow-head">
        <span>
          Start with a workflow (optional) <span className="info" title="Optional. Skip to use the Default agent.">ⓘ</span>
        </span>
        <button type="button" className="link" onClick={() => setExpanded((v) => !v)}>
          See all {expanded ? "⌃" : "⌄"}
        </button>
      </div>
      {expanded && (
        <div className="workflows">
          {WORKFLOWS.map((wf) => (
            <button
              type="button"
              key={wf.id}
              className={isWorkflowSelected(tab.currentAgentId, wf.id) ? "selected" : ""}
              onClick={() => post({ type: "setAgent", tabId: tab.id, agentId: wf.id })}
            >
              <strong>{wf.name}</strong>
              <span>{wf.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
