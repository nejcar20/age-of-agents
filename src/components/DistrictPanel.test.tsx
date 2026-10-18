// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DistrictPanel, type SelectedDistrictInfo } from "./DistrictPanel";
import { isModalOpen } from "../useHotkey";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

const selection: SelectedDistrictInfo = { name: "src", path: "/repo/src", buildingCount: 42 };

describe("DistrictPanel", () => {
  it("shows the district's path and building count", () => {
    render(<DistrictPanel selection={selection} onClose={vi.fn()} />);
    expect(screen.getByText("/repo/src")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("is detected by isModalOpen() while mounted, and not after unmount", () => {
    const { unmount } = render(<DistrictPanel selection={selection} onClose={vi.fn()} />);
    expect(isModalOpen()).toBe(true);
    unmount();
    expect(isModalOpen()).toBe(false);
  });

  it("clears the selection on Escape", () => {
    const onClose = vi.fn();
    render(<DistrictPanel selection={selection} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the explicit close button too", () => {
    const onClose = vi.fn();
    render(<DistrictPanel selection={selection} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reveals the directory via reveal_path when clicked, never automatically", () => {
    invokeMock.mockResolvedValue(undefined);
    render(<DistrictPanel selection={selection} onClose={vi.fn()} />);
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(invokeMock).toHaveBeenCalledWith("reveal_path", { path: "/repo/src" });
  });

  it("shows an honest error when reveal rejects", async () => {
    invokeMock.mockRejectedValue(new Error("no file manager found"));
    render(<DistrictPanel selection={selection} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no file manager found/);
  });
});
