import { invoke } from "@tauri-apps/api/core";

/**
 * Reveals `path` (a file or a directory) in the system file manager.
 * Centralized behind one function because the underlying command's final
 * name was still being decided when this was written (the coordinator's
 * own contract: "check the final name; it may be honestly named 'open' if
 * reveal is not available") — every button in this codebase goes through
 * here, so a rename on the Rust side is a one-line fix, not a hunt through
 * every panel.
 */
export function revealPath(path: string): Promise<void> {
  return invoke("reveal_path", { path });
}
