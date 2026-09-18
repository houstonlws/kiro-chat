import { createRoot } from "react-dom/client";
import { App, PanelErrorBoundary } from "./App";

const root = document.getElementById("root");
if (root) {
  try {
    createRoot(root).render(
      <PanelErrorBoundary>
        <App />
      </PanelErrorBoundary>,
    );
  } catch (err) {
    root.textContent = err instanceof Error ? err.message : String(err);
  }
}
