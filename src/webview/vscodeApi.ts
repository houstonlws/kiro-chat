import type { HostToWebview, WebviewToHost, UiState } from "../shared/protocol";

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): { state?: UiState } | undefined;
  setState(state: { state?: UiState }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function getVsCodeApi(): VsCodeApi {
  try {
    return acquireVsCodeApi();
  } catch {
    return {
      postMessage() {},
      getState() {
        return undefined;
      },
      setState() {},
    };
  }
}

export const vscode = getVsCodeApi();

export function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

export function listen(handler: (message: HostToWebview) => void): () => void {
  const fn = (event: MessageEvent<HostToWebview>) => handler(event.data);
  window.addEventListener("message", fn);
  return () => window.removeEventListener("message", fn);
}
