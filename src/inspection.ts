import { invoke } from "@tauri-apps/api/core";
import type { Building, CityModel } from "./city";
import type { TradeMode } from "./tradeRoutes";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "typechanged";
export type ChangeEntry = { path: string; previous_path: string | null; status: ChangeStatus; staged: boolean; unstaged: boolean };
export type RepoChanges = { root: string; branch: string | null; entries: ChangeEntry[]; truncated: boolean };
export type FileInspection = { path: string; kind: "text" | "binary" | "directory" | "missing"; content: string | null; truncated: boolean; staged_diff: string; unstaged_diff: string; diff_truncated: boolean };
export type TownFile = Omit<Building, "path"> & { path: string; absolutePath: string; districtPath: string; districtName: string };
export type CodeSelection = { path: string; kind: "file" | "directory" };
export type TextMatch = { path: string; line: number; column: number; text: string; truncated: boolean };
export type ProjectTextSearch = { root: string; query: string; matches: TextMatch[]; truncated: boolean; files_searched: number; files_skipped: number };
export const searchProjectText = (root: string, query: string, caseSensitive = false) => invoke<ProjectTextSearch>("search_project_text", { root, query, caseSensitive });
export const readRepoChanges = (root: string) => invoke<RepoChanges>("repo_changes", { root });
export const inspectProjectPath = (root: string, path: string) => invoke<FileInspection>("inspect_project_path", { root, path });

export function relativeProjectPath(root: string, path: string): string | null {
  const base = root.replace(/\/+$/, "");
  if (path === base) return ".";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

export function indexTownFiles(model: CityModel): TownFile[] {
  return model.districts.flatMap(district => district.buildings.flatMap(building => {
    const path = relativeProjectPath(model.root, building.path);
    return path === null ? [] : [{ ...building, path, absolutePath: building.path, districtPath: district.path, districtName: district.name }];
  })).sort((a, b) => a.path.localeCompare(b.path));
}

export function searchTownFiles(files: TownFile[], query: string): TownFile[] {
  const q = query.trim().toLocaleLowerCase();
  return files.filter(file => file.path.toLocaleLowerCase().includes(q));
}

export function buildScopedPrompt({ root, cwd, path, kind, brief, mode }: { root: string; cwd: string; path: string; kind: CodeSelection["kind"]; brief: string; mode: TradeMode }): string {
  return `Task from the town\n\nRepository: ${JSON.stringify(root)}\nYour working directory: ${JSON.stringify(cwd)}\nSelected ${kind} (relative to the repository): ${JSON.stringify(path)}\n\nMy task:\n${brief.trim()}\n\nYour working directory may be a subdirectory. First identify the root of your receiving checkout with git rev-parse --show-toplevel from that directory, including when it is a separate worktree. Resolve the selected path relative to that checkout root, not relative to the launch directory or another checkout. Inspect the selected ${kind} and the applicable repository instructions before acting. If it does not exist in your working tree, explain the mismatch rather than editing a different checkout.\n\n${mode === "plan" ? "Explain your findings and propose the changes and relevant tests. Wait for my approval before changing files." : "Implement the task in your working tree, follow the project's conventions, run relevant checks, and report the changes and remaining gaps."}`;
}
