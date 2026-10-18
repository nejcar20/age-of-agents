import { Component, type ErrorInfo, type ReactNode } from "react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * Last-resort, whole-app fallback — deliberately NOT the fix for IMPORTANT 3
 * (final whole-branch review; see `App.tsx`'s `TownViewBoundary`, which is
 * scoped tightly around `<TownView>` so a town-view crash cannot take the
 * archipelago or the jump hotkey down with it). This one exists for
 * whatever `TownViewBoundary` cannot see — a crash anywhere ELSE in `App`
 * (the archipelago list, the unsettled list, `App` itself) — so that failure
 * mode is a visible, legible screen instead of the blank window this branch
 * shipped with no boundary at all. There is no in-app state to recover to
 * at this scope (unlike a town-view crash, which can return to a perfectly
 * healthy archipelago), so the only honest recovery offered is a reload.
 */
type RootBoundaryState = { error: Error | null };

class RootErrorBoundary extends Component<{ children: ReactNode }, RootBoundaryState> {
  state: RootBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RootBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Age of Agents crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      // Plain inline styles, not a CSS class: this is the one screen that
      // must render correctly even if something upstream of a normal
      // component crash also implicated the stylesheet, and it must never
      // end up UNDER a `position: fixed` overlay the way `.sheet__error`
      // once did — hence the high `zIndex` and covering the whole viewport
      // itself rather than trusting document flow.
      return (
        <div
          role="alert"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483647,
            background: "#12161c",
            color: "#e6e9ef",
            font: "14px/1.5 -apple-system, system-ui, sans-serif",
            padding: 24,
            overflow: "auto",
          }}
        >
          <h1 style={{ fontSize: 16, marginTop: 0 }}>Age of Agents hit a problem</h1>
          <p>{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: "#232935",
              border: "none",
              color: "inherit",
              font: "inherit",
              padding: "8px 14px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
