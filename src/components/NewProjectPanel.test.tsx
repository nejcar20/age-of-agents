// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewProjectPanel } from "./NewProjectPanel";
import { isModalOpen } from "../useHotkey";

const { invokeMock, openMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), openMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  openMock.mockReset();
});

function stubDefaults() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
    if (cmd === "canonical_path") return Promise.resolve("/Users/x/Projects");
    return Promise.resolve(undefined);
  });
}

async function pickParent() {
  openMock.mockResolvedValue("/Users/x/Projects");
  fireEvent.click(screen.getByRole("button", { name: "browse…" }));
  await screen.findByText("/Users/x/Projects");
}

describe("NewProjectPanel", () => {
  it("is detected by isModalOpen() while mounted, and not after unmount", () => {
    stubDefaults();
    const { unmount } = render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(isModalOpen()).toBe(true);
    unmount();
    expect(isModalOpen()).toBe(false);
  });

  it("closes on Escape when nothing is in flight", () => {
    stubDefaults();
    const onClose = vi.fn();
    render(<NewProjectPanel onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables 'Next…' until a parent directory AND a valid name are both chosen", async () => {
    stubDefaults();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Next…" }) as HTMLButtonElement).disabled).toBe(true);
    await pickParent();
    expect((screen.getByRole("button", { name: "Next…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    expect((screen.getByRole("button", { name: "Next…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("rejects a name that would escape the chosen parent directory", async () => {
    stubDefaults();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "../elsewhere" } });
    expect((screen.getByRole("button", { name: "Next…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("canonicalizes the browsed directory before showing it, same as the founding flow", async () => {
    stubDefaults();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    expect(invokeMock).toHaveBeenCalledWith("canonical_path", { path: "/Users/x/Projects" });
  });

  it("never calls create_project just from filling out the form", async () => {
    stubDefaults();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    expect(invokeMock).not.toHaveBeenCalledWith("create_project", expect.anything());
  });

  it("shows the exact steps on the confirm screen before anything runs", async () => {
    stubDefaults();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    fireEvent.click(screen.getByRole("button", { name: "Next…" }));
    await screen.findByRole("heading", { name: "Create project" });
    expect(invokeMock).not.toHaveBeenCalledWith("create_project", expect.anything());
    expect(screen.getByText(/git init/)).toBeTruthy();
    expect(screen.getByText(/workspace.create/)).toBeTruthy();
  });

  it("creates the project only after the confirm button is clicked, and reports the new path", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "canonical_path") return Promise.resolve("/Users/x/Projects");
      if (cmd === "create_project") {
        return Promise.resolve({ path: "/Users/x/Projects/widget", undiscoverable_reason: null });
      }
      return Promise.resolve(undefined);
    });
    const onCreated = vi.fn();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={onCreated} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    fireEvent.click(screen.getByRole("button", { name: "Next…" }));
    await screen.findByRole("heading", { name: "Create project" });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_project", {
        parent: "/Users/x/Projects",
        name: "widget",
        startAgent: true,
        kind: "claude",
      }),
    );
    // `undiscoverable_reason: null` — the ordinary case — closes straight
    // through to `onCreated`, exactly as before this round.
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("/Users/x/Projects/widget", null));
  });

  it("omits the kind argument when the user turns off 'start an agent'", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "canonical_path") return Promise.resolve("/Users/x/Projects");
      if (cmd === "create_project") {
        return Promise.resolve({ path: "/Users/x/Projects/widget", undiscoverable_reason: null });
      }
      return Promise.resolve(undefined);
    });
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    fireEvent.click(screen.getByLabelText("start an agent"));
    fireEvent.click(screen.getByRole("button", { name: "Next…" }));
    await screen.findByRole("heading", { name: "Create project" });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_project", {
        parent: "/Users/x/Projects",
        name: "widget",
        startAgent: false,
        kind: undefined,
      }),
    );
  });

  // Security review: a project created successfully but sitting somewhere
  // the archipelago's scan cannot see must not look like nothing happened.
  it("holds the panel open on a 'created, but not visible' screen when undiscoverable_reason is non-null, and does not call onCreated until acknowledged", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "canonical_path") return Promise.resolve("/Users/x/Projects");
      if (cmd === "create_project") {
        return Promise.resolve({
          path: "/Users/x/Projects/widget",
          undiscoverable_reason: "outside every configured scan root",
        });
      }
      return Promise.resolve(undefined);
    });
    const onCreated = vi.fn();
    render(<NewProjectPanel onClose={vi.fn()} onCreated={onCreated} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    fireEvent.click(screen.getByRole("button", { name: "Next…" }));
    await screen.findByRole("heading", { name: "Create project" });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    // Says plainly that it was created, where, and why it won't show up.
    await screen.findByText(/outside every configured scan root/);
    expect(screen.getByText(/Projects\/widget/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onCreated).toHaveBeenCalledWith(
      "/Users/x/Projects/widget",
      "outside every configured scan root",
    );
  });

  it("shows an honest, visible error when creation fails, never hidden underneath the overlay", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "canonical_path") return Promise.resolve("/Users/x/Projects");
      if (cmd === "create_project") return Promise.reject(new Error("directory already exists"));
      return Promise.resolve(undefined);
    });
    render(<NewProjectPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickParent();
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), { target: { value: "widget" } });
    fireEvent.click(screen.getByRole("button", { name: "Next…" }));
    await screen.findByRole("heading", { name: "Create project" });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/directory already exists/);
  });
});
