import { formatLastChanged } from "../lastChanged";
import { ATTENTION_LABEL, ATTENTION_MARK, sortIslands, type Island, type IslandSortMode } from "../world";

// The glyph and words for an agent's state come from the SHARED vocabulary
// in `world.ts` (`ATTENTION_MARK`/`ATTENTION_LABEL`), used directly below —
// this file used to hold one of four identical copies of that table.

export function IslandGrid({
  islands,
  connected,
  sortMode,
  onOpen,
}: {
  islands: Island[];
  connected: boolean;
  /** Defaults to `"name"` (the original ordering) so a caller that hasn't
   * been updated for the sort control — such as an existing test — keeps
   * seeing the exact same behaviour it always did. */
  sortMode?: IslandSortMode;
  onOpen: (island: Island) => void;
}) {
  if (islands.length === 0) {
    // While disconnected we have no idea whether there are agents in git
    // repositories — claiming there are none states as fact something we
    // cannot know (principle 4), and App already shows the honest "start
    // herdr" hint right above this.
    return connected ? <p className="empty">No agents in a git repository yet.</p> : null;
  }
  return (
    <ul className="islands">
      {sortIslands(islands, sortMode).map((island) => (
        <li
          key={island.id}
          className={`island island--${island.attention}`}
          // Deliberately NOT a <button>: native buttons activate on Space,
          // and Space is the global jump-to-stopped hotkey (the product's
          // headline feature) — a focused row would then both jump AND open
          // a town from one keypress (task-6-design-inputs.md §7.3). A
          // plain, keyboard-focusable role="button" only wires up Enter.
          role="button"
          tabIndex={0}
          onClick={() => onOpen(island)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpen(island);
          }}
        >
          <span className="island__marker" title={ATTENTION_LABEL[island.attention]}>
            {ATTENTION_MARK[island.attention]}
          </span>
          <span className="island__name">{island.name}</span>
          <span className="island__changed">{formatLastChanged(island.last_changed_at)}</span>
          {island.agents.length > 1 ? (
            // More than one agent: the island's own marker can only say
            // "something here is stopped", not which pane — the same guess
            // just moved from the code to the human. Show each agent's own
            // marker instead, so the pane that actually stopped is visible
            // at a glance.
            <span className="island__agent-markers">
              {island.agents.map((agent) => (
                <span
                  key={agent.pane_id}
                  className={`island__agent-marker island__agent-marker--${agent.attention}`}
                  title={ATTENTION_LABEL[agent.attention]}
                >
                  {ATTENTION_MARK[agent.attention]}
                </span>
              ))}
            </span>
          ) : (
            <span className="island__agents">
              {island.agents.length} agent{island.agents.length === 1 ? "" : "s"}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
