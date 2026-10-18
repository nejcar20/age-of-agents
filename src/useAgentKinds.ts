import { useEffect, useState } from "react";
import { agentKinds, resumableAgentKinds } from "./agents";

/**
 * Fetched once and shared by every place this round needs "the kinds this
 * herdr actually accepts, configured default first" (the "send an agent"
 * picker on a settled island, and the "found a new project" flow's own
 * kind choice) — the coordinator's own explicit instruction: "use this
 * rather than hardcoding a list, so the choice cannot silently rot."
 *
 * `kinds[0]`, when present, IS the configured default — callers preselect
 * it directly rather than guessing "claude" the way earlier phases had to
 * before this command existed.
 */
export type AgentKindsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; kinds: string[] };

export function useAgentKinds(): AgentKindsState {
  const [state, setState] = useState<AgentKindsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    agentKinds()
      .then((kinds) => {
        if (!cancelled) setState({ status: "ready", kinds });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Which kinds `agent_kinds()` lists ALSO have a verified resume flag (Item
 * 8, second coordinator round) — `claude`/`codex` today, per the backend's
 * own doc comment on `resumable_agent_kinds`, never every kind. A kind
 * absent from this set must not get a resume toggle that looks available
 * but silently does nothing — the coordinator's own explicit instruction.
 */
export function useResumableAgentKinds(): AgentKindsState {
  const [state, setState] = useState<AgentKindsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    resumableAgentKinds()
      .then((kinds) => {
        if (!cancelled) setState({ status: "ready", kinds });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
