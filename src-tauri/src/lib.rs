mod cache_io;
pub mod city;
mod commands;
mod config;
mod herdr;
mod history;
mod inspection;
mod platform;
mod transitions;
mod terminal_transport;
mod world;

use commands::AppState;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use world::attention::stops_to_notify;
use world::state::WorldState;

/// Applies one freshly observed `WorldState` to the running app: stores it
/// as the current world and pushes it to the frontend as a `world-updated`
/// event.
///
/// This is called for every state `herdr::events::run_connection_loop`
/// produces, including `WorldState::disconnected()` — a disconnected world
/// is a normal, expected value here (herdr not started yet, a dropped
/// connection, a subscription herdr rejected), not an error case to filter
/// out. Storing and emitting it unconditionally is exactly how the frontend
/// learns herdr has gone away, so there is no `if world.herdr_connected`
/// branch here on purpose.
///
/// Kept as a named function (rather than inlined in the closure passed to
/// `run_connection_loop`) so it has an obvious place to grow. That closure
/// must be `Fn`, not `FnMut` (see `run_connection_loop`'s signature), so any
/// future mutation — e.g. a transition log — has to go through interior
/// mutability rather than a captured `mut` variable. `AppState` already
/// guards its fields with `Mutex`, and this function already fetches it
/// fresh from `handle` on every call, so adding one more `Mutex`-guarded
/// field to `AppState` and locking it in here is a one-line addition, not a
/// rewrite of this closure/function split.
///
/// `state.transitions.lock()` is taken only for the `record()` call itself
/// — the guard is a temporary that drops at the end of that statement, so
/// it is never held across `handle.emit(..)` below, nor across any `.await`
/// (this function has none). That property was called out in Task 8's
/// review as something that must survive future changes here.
fn on_world_state(handle: &AppHandle, world: WorldState) {
    let state = handle.state::<AppState>();
    state.replace_world(world.clone());
    state.transitions.lock().unwrap().record(&world);

    // Native "stopped" notification, once per transition (Task 12). The
    // pure decision of which islands are newly stopped lives in
    // `world::attention::stops_to_notify` so it's unit-testable without a
    // GUI; this closure only does the stateful bookkeeping and the actual
    // `show()` call. As with `transitions` above, the `Mutex` guard here is
    // taken only long enough to read and replace the notified set — it is
    // never held across `handle.notification()...show()` below, nor across
    // `handle.emit(..)`, nor across any `.await` (this function has none).
    let (to_notify, updated_notified) = {
        let notified = state.notified_stopped.lock().unwrap();
        stops_to_notify(&notified, &world)
    };
    *state.notified_stopped.lock().unwrap() = updated_notified;

    if !to_notify.is_empty() {
        // Read once at startup and shared (see `AppState.config`), not
        // re-read from disk on every notifying world.
        if state.config.notify_on_stop {
            for island in world.islands.iter().filter(|i| to_notify.contains(&i.id)) {
                let result = handle
                    .notification()
                    .builder()
                    .title(format!("{} needs you", island.name))
                    .body("An agent has stopped.")
                    .show();
                if let Err(e) = result {
                    eprintln!("notification: failed to show for {}: {e}", island.name);
                }
            }
        }
    }

    // Quiet, permanent trace of the herdr connection's health — but only
    // when it actually CHANGES.
    //
    // FINAL REVIEW minor: this used to print on every call. While herdr is
    // down the reconnect loop emits a `disconnected()` world on every
    // backoff cycle, forever, so an overnight run buried the `transitions:`
    // and `herdr events:` lines — the only diagnostics that matter — under
    // thousands of identical "herdr_connected=false islands=0" lines. That
    // directly threatens the week-long evidence run this phase exists for.
    // Logging the (connected, island count) pair on change keeps every
    // genuinely informative transition (herdr going away, coming back, a
    // repo appearing) and drops the repeats.
    let fingerprint = (world.herdr_connected, world.islands.len());
    let changed = {
        let mut last = state.last_logged.lock().unwrap();
        let changed = *last != Some(fingerprint);
        if changed {
            *last = Some(fingerprint);
        }
        changed
    };
    if changed {
        eprintln!(
            "world-updated: herdr_connected={} islands={}",
            fingerprint.0, fingerprint.1
        );
    }

    // FINAL REVIEW minor: this emit is the ONLY path by which the UI learns
    // herdr came back or went away, so a failure here means a window that
    // silently lies about the world. It must not be swallowed.
    if let Err(e) = handle.emit("world-updated", world) {
        eprintln!("world-updated: failed to emit to the frontend: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Registered but unused until now (`docs/superpowers/phase-0-followups.md`
        // flagged exactly this: the Cargo dependency and the `opener:default`
        // capability permission both already existed, but nothing ever called
        // `.plugin()` — a plugin with no registration cannot answer ANY of its
        // own commands, capability grant or not. Backs the town view's "open
        // this file" button (`@tauri-apps/plugin-opener`'s `openPath`, called
        // directly from the frontend — no custom Rust command needed for it).
        .plugin(tauri_plugin_opener::init())
        // Terminal-feel round: the paste half of "make it feel like iTerm2".
        // Registered so `commands::clipboard_read_text` can read the system
        // clipboard on terminal paste, and clipboard_write_text copies completed
        // selections in terminal output. Both are gesture-scoped and
        // deliberately NOT listed in `capabilities/default.json` — the
        // webview may not call the plugin's own commands, only this app's
        // audited wrappers. See that command's doc comment for why the
        // web Clipboard API was not good enough here.
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .manage(terminal_transport::TerminalTransportState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let home = dirs::home_dir().expect("no home directory");
            let path = herdr::socket_path::resolve(None, &herdr::socket_path::RealEnv, &home);
            let seen = app.state::<AppState>().seen.clone();

            tauri::async_runtime::spawn(async move {
                herdr::events::run_connection_loop(path, seen, move |world| {
                    on_world_state(&handle, world);
                })
                .await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_world,
            commands::jump_to_next,
            commands::focus_pane,
            commands::mark_agent_seen,
            commands::list_unsettled,
            commands::found_settlement,
            commands::canonical_path,
            commands::city_for,
            inspection::repo_changes,
            inspection::inspect_project_path,
            inspection::search_project_text,
            terminal_transport::herdr_setup,
            terminal_transport::terminal_attach,
            terminal_transport::terminal_ack,
            terminal_transport::terminal_write,
            terminal_transport::terminal_resize,
            terminal_transport::terminal_scroll,
            terminal_transport::terminal_detach,
            commands::get_archipelago,
            commands::repo_history,
            commands::agent_kinds,
            commands::proposed_agent_name,
            commands::resumable_agent_kinds,
            commands::start_agent,
            commands::create_project,
            commands::reveal_path,
            commands::focus_workspace,
            commands::send_prompt,
            commands::read_agent,
            commands::pane_read,
            commands::pane_read_scrollback,
            commands::clipboard_read_text,
            commands::clipboard_write_text,
            commands::pane_send_text,
            commands::pane_send_keys
        ])
        .run(tauri::generate_context!())
        .expect("error while running Age of Agents");
}
