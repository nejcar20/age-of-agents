import type { ReactNode } from "react";
import { MOOD_LABEL, nextMood, useMood } from "../mood";
import { useRecording, useRecordingToggle } from "../recording";
import type { Agent, Island } from "../world";

/**
 * The world view's interface, in the "cartographer" direction: parchment
 * pieces laid over the sea like the furniture of a map table — a title
 * banner, a scroll of whoever needs you, a column of round brass-edged
 * buttons, and one big call to found a new island. The world stays the
 * picture; these sit at its edges.
 *
 * Every number here is the live one (`world.islands`), the same honesty
 * rule as the rest of the app: nothing counts up, nothing is celebrated.
 */

/** How many waiting agents the scroll lists before summarising the rest. */
const SCROLL_LIMIT = 4;

type Waiting = { agent: Agent; island: Island };

export function ChartHud({
  islands,
  islandCount,
  connected,
  onJump,
  onOpenAgent,
  search,
  searchOpen,
  onToggleSearch,
  listOpen,
  onToggleList,
  onNewProject,
}: {
  islands: Island[];
  /** Every island on the chart, settled or not. */
  islandCount: number;
  connected: boolean;
  /** Kept on the props for the island list, which shows it. */
  herdrVersion: string;
  /** Space's jump: to whoever has waited longest. */
  onJump: () => void;
  onOpenAgent: (island: Island) => void;
  /** The search bar, shown in its own parchment slip when open. */
  search: ReactNode;
  searchOpen: boolean;
  onToggleSearch: () => void;
  listOpen: boolean;
  onToggleList: () => void;
  onNewProject: () => void;
}) {
  const waiting: Waiting[] = islands.flatMap((island) =>
    island.agents.filter((agent) => agent.attention === "stopped").map((agent) => ({ agent, island })),
  );
  const agents = islands.flatMap((island) => island.agents);
  const working = agents.filter((agent) => agent.attention === "working").length;
  const idle = agents.length - waiting.length - working;

  return (
    <div className="chart-hud">
      <header className="chart-banner">
        <h1>Age of Agents</h1>
        <p>
          {islandCount} {islandCount === 1 ? "island" : "islands"} · {agents.length} {agents.length === 1 ? "agent" : "agents"}
          {connected ? "" : " · herdr not running"}
        </p>
      </header>

      <NeedsScroll waiting={waiting} working={working} idle={idle} onJump={onJump} onOpenAgent={onOpenAgent} />

      <div className="chart-column chart-column--hud">
        <RoundButton label="Search islands" pressed={searchOpen} onClick={onToggleSearch}>
          <path d="M16 16l4.5 4.5" />
          <circle cx="11" cy="11" r="6.5" />
        </RoundButton>
        <RoundButton label={listOpen ? "Hide the island list" : "Island list and settling"} pressed={listOpen} onClick={onToggleList}>
          <path d="M5 7h14M5 12h14M5 17h9" />
        </RoundButton>
        <MoodRoundButton />
        <RecordRoundButton />
      </div>

      {searchOpen && <div className="chart-slip chart-slip--search">{search}</div>}

      <button type="button" className="chart-found" onClick={onNewProject}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Found a new island
      </button>
    </div>
  );
}

function NeedsScroll({
  waiting,
  working,
  idle,
  onJump,
  onOpenAgent,
}: {
  waiting: Waiting[];
  working: number;
  idle: number;
  onJump: () => void;
  onOpenAgent: (island: Island) => void;
}) {
  const shown = waiting.slice(0, SCROLL_LIMIT);
  const more = waiting.length - shown.length;
  return (
    <section className="needs-scroll" aria-label="Agents that need you">
      <div className="needs-scroll__head">
        <h2>{waiting.length > 0 ? "Needs you" : "All quiet"}</h2>
        <button
          type="button"
          className={`needs-scroll__seal${waiting.length > 0 ? " needs-scroll__seal--active" : ""}`}
          onClick={onJump}
          disabled={waiting.length === 0}
          title="Go to whoever has waited longest (Space)"
          aria-label={waiting.length > 0 ? `${waiting.length} waiting — go to the first (Space)` : "Nobody is waiting"}
        >
          {waiting.length}
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="needs-scroll__list">
          {shown.map(({ agent, island }) => (
            <li key={agent.pane_id}>
              <button type="button" onClick={() => onOpenAgent(island)}>
                <span className="needs-scroll__task">{agent.title?.replace(/^[^\p{L}\p{N}]+/u, "").trim() || agent.pane_id}</span>
                <span className="needs-scroll__where">
                  {island.name}
                  {agent.kind ? ` · ${agent.kind}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="needs-scroll__more">and {more} more · Space to go through them</p>}
      <div className="needs-scroll__foot">
        <span><i className="needs-scroll__dot needs-scroll__dot--working" />{working} working</span>
        <span><i className="needs-scroll__dot needs-scroll__dot--idle" />{idle} idle</span>
      </div>
    </section>
  );
}

function RoundButton({
  label,
  pressed,
  onClick,
  accent = false,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`chart-round${accent ? " chart-round--accent" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function MoodRoundButton() {
  const { mood, setMood } = useMood();
  const label = `Time of day: ${MOOD_LABEL[mood]} (⇧M)`;
  return (
    <RoundButton label={label} onClick={() => setMood(nextMood(mood))} accent={mood !== "day"}>
      {mood === "day" && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
        </>
      )}
      {mood === "golden" && <path d="M3 17h18M6 17a6 6 0 0 1 12 0M12 5v2M4.9 9.9l1.4 1.4M19.1 9.9l-1.4 1.4" />}
      {mood === "night" && <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
    </RoundButton>
  );
}

function RecordRoundButton() {
  const recording = useRecording();
  const toggle = useRecordingToggle();
  return (
    <RoundButton label="Cinematic mode for recording (⇧R)" pressed={recording} onClick={toggle}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="#c9412f" stroke="none" />
    </RoundButton>
  );
}
