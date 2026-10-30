// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScoutControl, ScoutSheet, type ScoutControlProps } from "./ScoutSheet";

afterEach(cleanup);

const props = (over: Partial<ScoutControlProps> = {}): ScoutControlProps => ({
  scanners: { osv: true, npm: true },
  islandCount: 9,
  scouting: null,
  error: null,
  onScoutAll: vi.fn(),
  disabled: false,
  ...over,
});

describe("ScoutControl", () => {
  it("scout_sheet_names_missing_scanner_with_install_hint", () => {
    render(<ScoutControl {...props({ scanners: { osv: false, npm: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const sheet = screen.getByRole("dialog", { name: "Scout for threats" });
    expect(sheet.textContent).toContain("osv-scanner — not installed (brew install osv-scanner)");
    expect(sheet.textContent).toContain("npm ✓ found");
    expect(sheet.textContent).toContain(
      "Checks 9 islands' dependencies against public advisory databases. This uses the network.",
    );
  });

  it("scout_confirm_calls_scoutAll_once", () => {
    const onScoutAll = vi.fn();
    render(<ScoutControl {...props({ onScoutAll })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const confirm = screen.getByRole("button", { name: "Scout" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onScoutAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancel closes the sheet without scouting", () => {
    const onScoutAll = vi.fn();
    render(<ScoutControl {...props({ onScoutAll })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onScoutAll).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows progress beside the button, with no '/N' until the total is known", () => {
    const { rerender } = render(<ScoutControl {...props({ scouting: { done: 0, total: 0 } })} />);
    expect(screen.getByRole("status").textContent).toBe("Scouting…");
    expect((screen.getByRole("button", { name: "Scout for threats" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ScoutControl {...props({ scouting: { done: 3, total: 9 } })} />);
    expect(screen.getByRole("status").textContent).toBe("Scouting 3/9…");
  });

  it("surfaces a scout error rather than swallowing it", () => {
    render(<ScoutControl {...props({ error: "already scouting" })} />);
    expect(screen.getByRole("alert").textContent).toContain("already scouting");
  });

  it("is disabled in the browser preview", () => {
    const onScoutAll = vi.fn();
    render(<ScoutControl {...props({ onScoutAll, disabled: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const confirm = screen.getByRole("button", { name: "Scout" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole("dialog").textContent).toContain("Scouting is disabled in the preview.");
    fireEvent.click(confirm);
    expect(onScoutAll).not.toHaveBeenCalled();
  });
});

describe("ScoutSheet", () => {
  it("says island's for one island and islands' for more", () => {
    const sheet = (n: number) =>
      render(<ScoutSheet scanners={{ osv: true, npm: true }} islandCount={n} onConfirm={vi.fn()} onClose={vi.fn()} />);
    sheet(1);
    expect(screen.getByRole("dialog").textContent).toContain("Checks 1 island's dependencies");
    cleanup();
    sheet(2);
    expect(screen.getByRole("dialog").textContent).toContain("Checks 2 islands' dependencies");
  });
});
