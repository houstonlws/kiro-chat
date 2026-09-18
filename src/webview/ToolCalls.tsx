import type { ChatBlock, DiffLine, ToolCallView, ToolDiff } from "../shared/protocol";
import { post } from "./vscodeApi";

export function ToolCalls({ block, onToggle }: { block: ChatBlock; onToggle: () => void }) {
  const calls = block.toolCalls ?? [];
  const count = calls.length;
  return (
    <div className="tool-group">
      <button type="button" className="tool-summary" onClick={onToggle}>
        <span className={`chevron ${block.collapsed === false ? "open" : ""}`}>▸</span>
        {count} tool call{count === 1 ? "" : "s"}
      </button>
      {block.collapsed === false && (
        <div className="tool-list">
          {calls.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCard({ call }: { call: ToolCallView }) {
  const name = call.path ? basename(call.path) : undefined;
  return (
    <div className="tool-item">
      <div className="tool-head">
        <span className={`status-dot ${call.status ?? ""}`} />
        <div className="tool-head-text">
          <div className="tool-title">{call.title}</div>
          <div className="tool-meta">
            {call.command ? <span className="tool-cmd">{call.command}</span> : null}
            {name && call.path ? (
              <button
                type="button"
                className="tool-path"
                title={call.path}
                onClick={() =>
                  post({
                    type: "openFile",
                    path: call.path!,
                    newStr: call.newStr,
                    startLine: call.startLine ?? firstAddedLine(call),
                  })
                }
              >
                {name}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {call.diff?.lines.length ? <DiffView diff={call.diff} /> : null}
      {call.summary ? <div className="tool-result">{call.summary}</div> : null}
      {call.details?.length ? (
        <dl className="tool-kv">
          {call.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function DiffView({ diff }: { diff: ToolDiff }) {
  const hasContext = diff.lines.some((line) => line.type === "context");
  const lines = hasContext ? diff.lines : diff.lines.filter((line) => line.type !== "hunk");
  return (
    <div className={`diff ${hasContext ? "has-gutter" : "snippet"}`}>
      <pre className="diff-body">
        {lines.map((line, i) => (
          <DiffRow
            key={`${line.type}-${i}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
            line={line}
            showLineNumbers={hasContext}
          />
        ))}
      </pre>
    </div>
  );
}

function DiffRow({ line, showLineNumbers }: { line: DiffLine; showLineNumbers: boolean }) {
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "hunk" ? "" : " ";
  return (
    <div className={`diff-line diff-${line.type}`}>
      {showLineNumbers ? (
        <>
          <span className="diff-ln">{line.oldLine ?? ""}</span>
          <span className="diff-ln">{line.newLine ?? ""}</span>
        </>
      ) : null}
      <span className="diff-mark">{marker}</span>
      <span className="diff-text">{line.text}</span>
    </div>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function firstAddedLine(call: ToolCallView): number | undefined {
  const line = call.diff?.lines.find((row) => row.type === "add" && row.newLine);
  return line?.newLine;
}
