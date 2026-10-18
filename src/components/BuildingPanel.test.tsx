// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildingPanel, type SelectedBuildingInfo } from "./BuildingPanel";
import { decideHotkey, isModalOpen } from "../useHotkey";

const { openPathMock, invokeMock } = vi.hoisted(() => ({ openPathMock: vi.fn(), invokeMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: openPathMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

afterEach(() => {
  cleanup();
  openPathMock.mockReset();
  invokeMock.mockReset();
});

const selection: SelectedBuildingInfo = {
  path: "/repo/src/index.ts",
  name: "index.ts",
  kind: "Source",
  lines: 128,
  districtName: "src",
};

describe("BuildingPanel", () => {
  it("shows the building's path, kind, line count and district", () => {
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    expect(screen.getByText("/repo/src/index.ts")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
  });

  // The whole point of `role="dialog"`: `useHotkey`'s `isModalOpen()` must
  // detect this panel structurally, the same way it already detects
  // `UnsettledList`'s confirm sheet — that is what makes the app-level
  // Escape hotkey (closes the whole town) self-gate into a no-op while a
  // building is selected, with no coordination between the two components.
  it("is detected by isModalOpen() while mounted, and not after unmount", () => {
    const { unmount } = render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    expect(isModalOpen()).toBe(true);
    unmount();
    expect(isModalOpen()).toBe(false);
  });

  // The other half of the Escape-ordering proof: this component clears the
  // selection itself, independent of `useHotkey`'s modal gate (which would
  // otherwise block this handler too — see the component's own doc comment
  // for why it deliberately does not use `useHotkey`).
  // The full ordering claim, composed from the same primitives `App.tsx`'s
  // real Escape hotkey uses (`decideHotkey` + `isModalOpen`), against a
  // REALLY mounted `BuildingPanel` rather than a fake `[role="dialog"]`
  // stand-in: with a building selected, the exact check `useHotkey`
  // performs on every Escape keydown must decide NOT to fire (i.e., not
  // close the town), leaving this component's own listener (proven above)
  // as the only thing Escape actually does.
  it("makes the app-level Escape hotkey's own decision resolve to 'do not fire' while mounted", () => {
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    const decision = decideHotkey(
      { key: "Escape", metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: document.body },
      { key: "Escape", enabled: true, modalOpen: isModalOpen() },
    );
    expect(decision.fire).toBe(false);
  });

  it("clears the selection on Escape", () => {
    const onClose = vi.fn();
    render(<BuildingPanel selection={selection} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not react to a key other than Escape", () => {
    const onClose = vi.fn();
    render(<BuildingPanel selection={selection} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes via the explicit close button too", () => {
    const onClose = vi.fn();
    render(<BuildingPanel selection={selection} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the file via openPath when the button is clicked, never automatically", () => {
    openPathMock.mockResolvedValue(undefined);
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    expect(openPathMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(openPathMock).toHaveBeenCalledWith("/repo/src/index.ts");
  });

  it("shows an honest error when openPath rejects, rather than failing silently", async () => {
    openPathMock.mockRejectedValue(new Error("no application found"));
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no application found/);
  });

  it("reveals the file via reveal_path when the button is clicked, never automatically", () => {
    invokeMock.mockResolvedValue(undefined);
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(invokeMock).toHaveBeenCalledWith("reveal_path", { path: "/repo/src/index.ts" });
  });

  it("shows an honest error when reveal rejects, rather than failing silently", async () => {
    invokeMock.mockRejectedValue(new Error("no file manager found"));
    render(<BuildingPanel selection={selection} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no file manager found/);
  });
});
