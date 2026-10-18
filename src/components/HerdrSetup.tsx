import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { displayPath, type UnsettledReport } from "../founding";

/** How often to re-check for an install while setup is showing. A stat of a
 * few directories — cheap, read-only, and it stops once Herdr connects. */
const INSTALL_CHECK_MS = 4000;

/**
 * Whether Herdr is installed (`herdr_setup`, a read-only file check) and
 * where the app looked for repositories (`list_unsettled`'s scan roots).
 * Only mounted while Herdr is offline: connected, there is nothing to set up.
 */
function useSetupFacts() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [scan, setScan] = useState<{ roots: string[]; home: string } | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => invoke<{ installed: boolean }>("herdr_setup")
      .then(result => { if (live && result) setInstalled(result.installed); })
      .catch(() => { if (live) setInstalled(null); });
    check();
    const timer = setInterval(check, INSTALL_CHECK_MS);
    invoke<UnsettledReport>("list_unsettled")
      .then(report => { if (live && report) setScan({ roots: report.roots, home: report.home }); })
      .catch(() => {});
    return () => { live = false; clearInterval(timer); };
  }, []);
  return { installed, scan };
}

/**
 * First-run setup, shown in place of the old one-line "Herdr is offline"
 * banner. It says what Herdr is, the two steps to get it running (install
 * only when it is missing), and waits visibly: the workspace already
 * reconnects on its own, so the card just disappears when Herdr arrives.
 *
 * The commands are selectable text, not copy buttons: the app never writes
 * the clipboard from its own surfaces (README, "What the app is permitted
 * to do").
 */
export function HerdrSetupCard({ projectCount }: { projectCount: number }) {
  const { installed, scan } = useSetupFacts();
  const roots = scan?.roots.map(root => displayPath(root, scan.home)) ?? [];
  return <section className="herdr-setup" aria-label="Connect your agents">
    <div className="herdr-setup__head">
      <h2>Connect your agents</h2>
      <p>Age of Agents shows the coding agents running in <strong>Herdr</strong>, a small background runtime that keeps agent terminals alive. Your repositories are already on the map; agents join them once Herdr is running.</p>
    </div>
    <ol className="herdr-setup__steps">
      <li className={installed ? "herdr-setup__step herdr-setup__step--done" : "herdr-setup__step"}>
        <span className="herdr-setup__marker" aria-hidden="true">{installed ? "✓" : "1"}</span>
        {installed ? <div><strong>Herdr is installed</strong></div> : <div>
          <strong>Install Herdr</strong>
          <code>brew install herdr</code>
          <span className="herdr-setup__or">or <code>curl -fsSL https://herdr.dev/install.sh | sh</code></span>
          <small>Other options at herdr.dev/docs/install</small>
        </div>}
      </li>
      <li className="herdr-setup__step">
        <span className="herdr-setup__marker" aria-hidden="true">2</span>
        <div><strong>Start it</strong><span>In any terminal, run <code>herdr</code>, then start an agent there or from a project here.</span></div>
      </li>
      <li className="herdr-setup__step herdr-setup__step--waiting" role="status">
        <span className="herdr-setup__spinner" aria-hidden="true" />
        <div><span>Waiting for Herdr… this page connects on its own.</span></div>
      </li>
    </ol>
    {roots.length > 0 && <p className="herdr-setup__scan">
      Found {projectCount} {projectCount === 1 ? "repository" : "repositories"} in {roots.join(", ")}. To look somewhere else, set <code>project_roots</code> in <code>~/.age-of-agents/config.json</code>.
    </p>}
  </section>;
}

/** The same message, one line high, for views where the card would cover
 * the thing you came to look at. */
export function HerdrSetupStrip({ onShowSetup }: { onShowSetup: () => void }) {
  return <div className="workbench__notice workbench__notice--warning" role="status">
    Herdr isn’t running yet, so no agents are on the map.
    <button className="herdr-setup__link" onClick={onShowSetup}>How to connect</button>
  </div>;
}

const LEGEND_KEY = "aoa.legendDismissed";

/** One line on how to read the map, until it is dismissed. */
export function WorldLegend() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(LEGEND_KEY) === "1"; } catch { return false; } });
  if (hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(LEGEND_KEY, "1"); } catch { /* Session-only preference. */ } };
  return <div className="world-legend" role="note">
    <span><b>Islands</b> are your repositories</span>
    <span><b>Buildings</b> are files, as tall as their code</span>
    <span><i className="state-dot state-dot--working" /> an agent is working</span>
    <span><i className="state-dot state-dot--stopped" /> an agent needs you</span>
    <button onClick={dismiss} aria-label="Dismiss map legend">×</button>
  </div>;
}
