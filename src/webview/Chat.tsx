import type { SessionTab, UiState } from "../shared/protocol";
import { Markdown } from "./Markdown";
import { ToolCalls } from "./ToolCalls";
import { post } from "./vscodeApi";

export function Chat({ tab, state }: { tab: SessionTab; state: UiState }) {
  return (
    <div className="chat">
      {state.showCheckpointRestore && (
        <div className="checkpoint">
          <span>Checkpoint</span>
          <span className="line" />
          <button type="button" onClick={() => post({ type: "restoreCheckpoint" })}>
            Restore
          </button>
        </div>
      )}
      {tab.blocks.map((block) => {
        if (block.type === "tools") {
          return (
            <ToolCalls
              key={block.id}
              block={block}
              onToggle={() => post({ type: "toggleTools", tabId: tab.id, blockId: block.id })}
            />
          );
        }
        if (block.type === "user") {
          return (
            <div className="user-bubble" key={block.id}>
              {block.attachments?.length ? (
                <div className="user-files">
                  {block.attachments.map((att) => (
                    <button
                      type="button"
                      key={att.id}
                      className="file-pill"
                      onClick={() => att.path && post({ type: "openFile", path: att.path })}
                    >
                      {att.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {block.text ? <div className="user-text">{block.text}</div> : null}
            </div>
          );
        }
        if (block.type === "error") {
          return (
            <div className="error-block" key={block.id}>
              {block.text}
            </div>
          );
        }
        return (
          <div className="assistant" key={block.id}>
            <div className="assistant-head">
              <span className="avatar">K</span>
              <strong>Kiro</strong>
            </div>
            <Markdown text={block.text ?? ""} />
          </div>
        );
      })}
      {state.permission && (
        <div className="permission">
          <div className="permission-title">{state.permission.title}</div>
          <div className="permission-actions">
            {state.permission.options.map((opt) => (
              <button
                type="button"
                key={opt.optionId}
                onClick={() => post({ type: "permission", requestId: state.permission!.requestId, optionId: opt.optionId })}
              >
                {opt.name}
              </button>
            ))}
            <button
              type="button"
              className="ghost"
              onClick={() => post({ type: "permission", requestId: state.permission!.requestId, cancelled: true })}
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
