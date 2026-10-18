// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectTextSearch } from "./ProjectTextSearch";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const props = { root: "/app", focusSequence: 1, refresh: 0, compact: false, onSelect: vi.fn() };
const result = (query: string) => ({ root: "/app", query, files_searched: 3, files_skipped: 0, truncated: false, matches: [{ path: `${query}.ts`, line: 2, column: 1, text: query, truncated: false }] });
const submit = (query: string) => { const input = screen.getByRole("searchbox"); fireEvent.change(input, { target: { value: query } }); fireEvent.submit(input.closest("form")!); };

it("serializes searches and drops obsolete responses and queued queries", async () => {
  let finish!: (data: ReturnType<typeof result>) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation((_cmd, args) => Promise.resolve(result(args.query)));
  render(<ProjectTextSearch {...props} />);
  submit("old");
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  submit("middle");
  await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  submit("latest");
  await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => finish(result("old")));
  expect(await screen.findByRole("button", { name: "Open latest.ts at line 2" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Open old.ts at line 2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open middle.ts at line 2" })).toBeNull();
});

it("searches literal spaces, supports case matching, and reports partial searches", async () => {
  invoke.mockImplementation((_cmd, args) => Promise.resolve({ ...result(args.query), truncated: true, files_skipped: 2 }));
  render(<ProjectTextSearch {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Match case" }));
  submit("  auth");
  await screen.findByText(/Search reached a limit/);
  expect(invoke).toHaveBeenCalledWith("search_project_text", { root: "/app", query: "  auth", caseSensitive: true });
  expect(screen.getByRole("status").textContent).toContain("2 skipped");
});

it("reports errors and prevents invalid multiline or oversized requests", async () => {
  invoke.mockRejectedValue(new Error("Repository unavailable"));
  render(<ProjectTextSearch {...props} />);
  submit("auth");
  expect((await screen.findByRole("alert")).textContent).toContain("Repository unavailable");
  submit("x".repeat(501));
  expect(screen.getByRole("alert").textContent).toContain("up to 500");
  await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("shows context around a late Unicode match instead of clipping it off-screen", async () => {
  invoke.mockResolvedValue({ ...result("needle"), matches: [{ path: "long.ts", line: 1, column: 101, text: "😀".repeat(100) + "needle and context", truncated: false }] });
  render(<ProjectTextSearch {...props} />);
  submit("needle");
  const button = await screen.findByRole("button", { name: "Open long.ts at line 1" });
  expect(button.querySelector("mark")?.textContent).toBe("needle");
  expect(button.textContent?.length).toBeLessThan(100);
});
