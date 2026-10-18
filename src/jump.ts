/**
 * What one press of the jump hotkey actually did.
 *
 * `jump_to_next` can end three ways and, before this fix, the UI showed
 * nothing for any of them: `Ok(Some(island))` (we moved), `Ok(None)`
 * (nothing is stopped — or herdr is down, so the world is empty), and
 * `Err(message)` (connect failed, or herdr rejected `agent.focus`). Pressing
 * the key with herdr down made the app look broken.
 */
export type JumpResult =
  | { ok: true; island: string | null }
  | { ok: false; error: string };

/**
 * The one short line shown to the user after a jump. Pure, so the wording is
 * testable without a Tauri host.
 *
 * Deliberately plain: principle 2 puts no animation and no delay on the
 * attention path, so this is a calm status line, not a toast that flies in.
 */
export function jumpMessage(result: JumpResult): string {
  if (!result.ok) {
    return `jump failed: ${result.error}`;
  }
  return result.island === null ? "nothing waiting" : `jumped to ${result.island}`;
}
