//! `archipelago_fixture <out.json>` — writes the exact `Archipelago` JSON the
//! `get_archipelago` Tauri command returns, via `build_archipelago_for_roots`
//! — the SAME packing/measuring pipeline `build_archipelago` (and therefore
//! `get_archipelago`) calls internally — over the author's real repositories
//! under `~/Projects`, so the archipelago screenshot harness renders his
//! actual sea, not invented data (Item 6 of the archipelago-scene brief;
//! `docs/superpowers/phase-0-followups.md` §6).
//!
//! Dev-only tooling, the same category as `city_fixture`/`city_preview`: a
//! sibling binary the shipped app never links against or runs.
//!
//! Discovery here is a small, self-contained re-scan (walk `~/Projects` up
//! to two levels deep, matching `world::unsettled::scan_roots`'s own depth
//! for a discovered root) rather than a call into `world::unsettled` or
//! `config::Config` — both live in modules this crate keeps PRIVATE
//! (`mod world;`, `mod config;` in `lib.rs`), and this round's own
//! constraint is "add one small Rust command... do not otherwise change
//! Rust." Reimplementing a few lines of directory walking in a dev-only bin
//! costs nothing production-facing; widening a module's visibility would.

use std::path::{Path, PathBuf};

use tauri_app_lib::city::archipelago::{build_archipelago_for_roots, CityStatus};

/// Finds every git repository at or below `root`, up to `depth` levels —
/// "is there a `.git` here" (a file OR a directory, so worktrees count too,
/// same rule `commands::foundable_label` uses), never descending INTO a
/// repository it already found (a repo's own subdirectories are not
/// separately-foundable repos).
fn scan(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.join(".git").exists() {
            out.push(path);
            continue;
        }
        if depth > 1 {
            scan(&path, depth - 1, out);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = match args.as_slice() {
        [_, out] => out.clone(),
        _ => {
            eprintln!("usage: archipelago_fixture <out.json>");
            std::process::exit(1);
        }
    };

    let home = dirs::home_dir().expect("no home directory");
    let projects = home.join("Projects");
    let mut found = Vec::new();
    scan(&projects, 2, &mut found);

    let roots: Vec<(PathBuf, String)> = found
        .into_iter()
        .map(|p| {
            let canon = std::fs::canonicalize(&p).unwrap_or(p);
            let name = canon.file_name().and_then(|n| n.to_str()).unwrap_or("repo").to_string();
            (canon, name)
        })
        .collect();

    println!("scanned {} repositories under {}", roots.len(), projects.display());
    let archipelago = build_archipelago_for_roots(&roots);

    let json = serde_json::to_string(&archipelago).expect("Archipelago must serialize");
    if let Err(e) = std::fs::write(&out, &json) {
        eprintln!("failed to write {out}: {e}");
        std::process::exit(1);
    }

    println!("{} islands -> {out}", archipelago.islands.len());
    for island in &archipelago.islands {
        match &island.city {
            CityStatus::Known { district_count, building_count, width, depth, .. } => println!(
                "  {}: plot=({},{},{}x{}) known {district_count} districts / {building_count} buildings, land {width}x{depth}",
                island.name, island.plot.x, island.plot.z, island.plot.w, island.plot.d
            ),
            CityStatus::Unknown { reason } => println!(
                "  {}: plot=({},{},{}x{}) UNKNOWN: {reason}",
                island.name, island.plot.x, island.plot.z, island.plot.w, island.plot.d
            ),
        }
    }
}
