//! `city_fixture <repo-path> <out.json>` — writes the exact `CityView` JSON
//! (`{ model, layout }`) the `city_for` Tauri command returns, via the same
//! `layout_city_persisted_from_root` call `city_preview` uses, so the
//! screenshot harness's 3D render and Task 5's SVG preview are provably the
//! same city.
//!
//! Dev-only tooling for Task 6's screenshot harness
//! (`.superpowers/sdd/2026-09-17-phase-0-5b-first-island/task-6-design-inputs.md`
//! §1): a sibling binary to `city_preview`, never referenced by the shipped
//! app (Tauri's bundle ships the `src-tauri` binary crate plus the
//! `src/` webview assets — a `src/bin/*.rs` binary is a separate cargo
//! target the app never links against or runs).

use std::path::Path;

use serde::Serialize;
use tauri_app_lib::city::layout::{layout_city_persisted_from_root, CityLayout};
use tauri_app_lib::city::model::{CityModel, RealFiles, RealGitFiles};

#[derive(Serialize)]
struct CityView {
    model: CityModel,
    layout: CityLayout,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (repo, out) = match args.as_slice() {
        [_, repo, out] => (repo.clone(), out.clone()),
        _ => {
            eprintln!("usage: city_fixture <repo-path> <out.json>");
            std::process::exit(1);
        }
    };

    let root = Path::new(&repo);
    let (model, layout) =
        layout_city_persisted_from_root(root, &RealFiles::new(Box::new(RealGitFiles::default())));
    let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();
    let view = CityView { model, layout };

    let json = serde_json::to_string(&view).expect("CityView must serialize");
    if let Err(e) = std::fs::write(&out, json) {
        eprintln!("failed to write {out}: {e}");
        std::process::exit(1);
    }

    println!(
        "{}: {} districts, {building_count} buildings -> {out}",
        view.model.name,
        view.model.districts.len(),
    );
}
