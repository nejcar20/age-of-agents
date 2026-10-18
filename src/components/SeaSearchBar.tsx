import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StateFilter } from "../archipelago";
import type { Attention } from "../world";

/** Every state-filter option, in the order the `<select>` offers them —
 * "all" first (the neutral, unfiltered choice), then the same three
 * attention states the sea already draws a beacon/marker for, "needs you"
 * first among them since it's the query the product's whole thesis is built
 * around (this round's own brief). */
const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "All islands" },
  { value: "stopped", label: "❗ Needs you" },
  { value: "working", label: "⚒ Working" },
  { value: "unknown", label: "? Unknown" },
  { value: "quiet", label: "· Idle" },
];

/**
 * DELIBERATELY NOT `world.ts`'s shared `ATTENTION_LABEL` (sea/town
 * consistency round, which folded four identical copies of that table into
 * one): these words name a FILTER, inside a sentence — "showing islands
 * needing you" — not the state of one agent. The shared label reads
 * "stopped — needs you", which is right on an agent's row and wrong in this
 * sentence; "herdr cannot tell what this agent is doing" is not a filter
 * name at all. Two vocabularies here is the honest answer, so this one says
 * why rather than looking like the copy that got missed.
 */
const FILTER_LABEL: Record<Attention, string> = {
  stopped: "needing you",
  working: "working",
  unknown: "unclear",
  quiet: "idle",
};

/**
 * Search-and-filter round: "find the repo I want" stops being a nicety once
 * discovery finds the author's real 152 repositories (up from the 73 a
 * depth-2 cap silently showed) — see this round's own brief. Two controls,
 * kept in one small bar rather than two separate ones so they read as a
 * single "narrow the sea" affordance:
 *
 * - A name search box. Typing narrows which islands `Archipelago` highlights
 *   (see `isSeaIslandMatch`/`isFilterActive`, both pure and unit-tested in
 *   `archipelago.test.ts` — there is no DOM/WebGL test environment for the
 *   3D scene itself). Pressing Enter calls `onSubmit`, which `App.tsx` wires
 *   to fly the camera to the best match and open its panel — the same
 *   `flyToRequest` mechanism the Space hotkey already uses, not a second
 *   implementation of "jump to an island."
 * - A state filter `<select>` — "show me only what needs me" is the query
 *   the product's whole thesis is built on (this round's own brief), so it
 *   sits right next to the existing "N agents need you" badge rather than
 *   buried in a settings panel.
 *
 * Both are real `<input>`/`<select>` elements — `useHotkey`'s own
 * `isInteractiveTarget` already lists both tag names, so the global Space
 * jump hotkey (and Archipelago's own "r" reset-view hotkey) already bail
 * while either has focus, with no special-casing needed here. See this
 * component's own test file for a direct assertion of that, the same
 * pattern `AgentActions.test.tsx` already uses for its prompt textarea.
 */
export function SeaSearchBar({
  query,
  onQueryChange,
  stateFilter,
  onStateFilterChange,
  onSubmit,
  matchCount,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  stateFilter: StateFilter;
  onStateFilterChange: (value: StateFilter) => void;
  /** Fired on Enter in the text box — never on every keystroke (Item 2's
   * own "typing a name and pressing Enter should fly the camera there"). */
  onSubmit: () => void;
  /** How many islands currently pass BOTH filters — `undefined` while the
   * archipelago itself hasn't loaded yet, in which case this renders
   * nothing rather than a fabricated "0 of 0". Only shown once a filter is
   * actually active (an unfiltered sea has nothing worth captioning here). */
  matchCount?: number;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
    }
  };

  const filterActive = query.trim() !== "" || stateFilter !== "all";

  return (
    <div className="sea-search" role="search">
      <input
        type="text"
        className="sea-search__input"
        placeholder="search islands…"
        aria-label="Search islands by name"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <select
        className="sea-search__state"
        aria-label="Filter islands by state"
        value={stateFilter}
        onChange={(event) => onStateFilterChange(event.target.value as StateFilter)}
      >
        {STATE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {filterActive && matchCount !== undefined && (
        <span className="sea-search__count" role="status">
          {matchCount === 0
            ? "no islands match"
            : `${matchCount} island${matchCount === 1 ? "" : "s"} match${matchCount === 1 ? "es" : ""}`}
          {stateFilter !== "all" && query.trim() === "" ? ` (${FILTER_LABEL[stateFilter]})` : ""}
        </span>
      )}
    </div>
  );
}
