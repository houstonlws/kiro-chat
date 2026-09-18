import { useState } from "react";
import type { HistoryItem, SessionTab } from "../shared/protocol";
import { post } from "./vscodeApi";

export function SessionList({
  tabs,
  history,
}: {
  tabs: SessionTab[];
  history: HistoryItem[];
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const active = tabs.filter((tab) => matches(tab.title, tab.updatedAt, q));
  const historic = history.filter(
    (item) => !tabs.some((tab) => tab.sessionId === item.sessionId) && matches(item.title, item.updatedAt, q),
  );

  return (
    <div className="session-list">
      <div className="session-filter">
        <button type="button" className="icon-btn" onClick={() => post({ type: "hideHistory" })} title="Back">
          ←
        </button>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            post({ type: "filterHistory", query: e.target.value });
          }}
          placeholder="Filter sessions..."
        />
      </div>
      <section>
        <h3>Active Sessions</h3>
        {active.length === 0 && <div className="empty-hint">No active sessions</div>}
        {active.map((tab) => (
          <button
            type="button"
            className="session-row"
            key={tab.id}
            onClick={() => post({ type: "selectTab", tabId: tab.id })}
          >
            <span className="bubble-icon">💬</span>
            <span>
              <strong>{tab.title}</strong>
              <span className="muted">{formatDate(tab.updatedAt)}</span>
            </span>
          </button>
        ))}
      </section>
      <section>
        <h3>Session History</h3>
        {historic.length === 0 && <div className="empty-hint">No previous sessions</div>}
        {historic.map((item) => (
          <button
            type="button"
            className="session-row"
            key={item.sessionId}
            onClick={() => post({ type: "openHistoryItem", sessionId: item.sessionId })}
          >
            <span className="bubble-icon">💬</span>
            <span>
              <strong>{item.title}</strong>
              <span className="muted">{formatDate(item.updatedAt)}</span>
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

function matches(title: string, ts: number, q: string): boolean {
  if (!q) {
    return true;
  }
  return `${title} ${formatDate(ts)}`.toLowerCase().includes(q);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}
