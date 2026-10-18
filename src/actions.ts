/**
 * Pure logic for this round's new creating actions ("send an agent," "found
 * a new project") — the exact-call summaries shown on a confirm sheet
 * before anything runs (principle 1, same discipline `founding.ts`'s
 * `foundingSummary` already established) and small validation helpers, all
 * kept outside any component so they're testable without a DOM.
 */

/** The exact call `startAgent` (Item 2) will make, shown on its confirm
 * sheet before it runs. `kind` is the empty string only while
 * `agent_kinds()` hasn't resolved yet — never rendered as a call with no
 * kind at all once a kind exists to show. `resume` (Item 8) is named
 * explicitly whenever true, so a resumed conversation is never confused
 * with a fresh one on the one screen that's supposed to say exactly what
 * will happen. */
/** `agentName` (the `agent_name_taken` round) is herdr's own globally
 * unique handle for the agent, which is NOT its kind — this path sent the
 * kind for both and could therefore start exactly one agent per herdr
 * session before failing forever. It is shown here because this is the
 * sheet the author's own recovery route goes through ("Start agent…" on an
 * island whose workspace exists but has no agent), so the name being right
 * is the visible proof the fix took. `null` while `proposed_agent_name`
 * hasn't answered: omitted rather than guessed, exactly as `kind` already
 * is. */
export function startAgentSummary(
  root: string,
  kind: string,
  resume: boolean,
  agentName: string | null = null,
): string[] {
  const parts = [`root="${root}"`];
  if (agentName) parts.push(`name="${agentName}"`);
  if (kind) parts.push(`kind="${kind}"`);
  if (resume) parts.push("resume=true");
  return [`agent.start  ${parts.join("  ")}`];
}

/**
 * The exact steps `create_project` (Item 4) will take, shown on its confirm
 * sheet — mirrors `create_project`'s own documented behaviour ("makes the
 * directory, git inits it, creates the workspace, optionally starts an
 * agent") line for line, so the sheet never claims a step that doesn't
 * happen or hides one that does.
 */
export function createProjectSummary(
  parentDisplay: string,
  name: string,
  withAgent: boolean,
  kind: string,
): string[] {
  const path = `${parentDisplay}/${name}`;
  const lines = [`mkdir  ${path}`, `git init  ${path}`, `workspace.create  cwd="${path}"  label="${name}"`];
  if (withAgent) lines.push(kind ? `agent.start  kind="${kind}"` : "agent.start");
  return lines;
}

/**
 * Whether `name` is safe to hand to `create_project` as a new directory
 * name — deliberately conservative (a single path SEGMENT, no separators,
 * no traversal), not a full filesystem-safe-character audit: the backend
 * still validates for real, this only stops the confirm sheet from ever
 * showing a call that is obviously wrong (an empty name, a name that would
 * escape the chosen parent directory) before the user even has a chance to
 * cancel it.
 */
export function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "." || trimmed === "..") return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  return true;
}
