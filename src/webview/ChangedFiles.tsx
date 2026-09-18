import type { FileChangeView } from "../shared/protocol";
import { post } from "./vscodeApi";

export function ChangedFiles({ files }: { files: FileChangeView[] }) {
  if (!files.length) {
    return null;
  }
  const pending = files.some((file) => file.status === "pending");
  const count = files.length;
  return (
    <div className="changed-files">
      <div className="changed-files-head">
        <span>
          {count} file{count === 1 ? "" : "s"} changed
        </span>
        {pending ? (
          <div className="changed-files-actions">
            <button type="button" onClick={() => post({ type: "keepAll" })}>
              Keep all
            </button>
            <button type="button" onClick={() => post({ type: "undoAll" })}>
              Undo all
            </button>
          </div>
        ) : null}
      </div>
      <div className="changed-files-list">
        {files.map((file) => (
          <div
            key={file.path}
            className={`changed-file ${file.status}`}
            onClick={() => post({ type: "openFile", path: file.path })}
          >
            <div>
              <div className="changed-file-name">{file.basename}</div>
              <div className="changed-file-path" title={file.path}>
                {file.relative}
              </div>
            </div>
            <div className="changed-file-btns">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  post({ type: "keepFile", path: file.path });
                }}
              >
                Keep
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  post({ type: "undoFile", path: file.path });
                }}
              >
                Undo
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
