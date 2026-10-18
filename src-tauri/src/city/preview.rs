//! Renders a `CityModel`/`CityLayout` pair to a top-down SVG, and backs the
//! `city_preview` binary (`src/bin/city_preview.rs`) that writes one out as
//! a standalone HTML file.
//!
//! This exists because nobody in this development loop has a display
//! Tauri's own window could appear on. A static SVG embedded in a plain
//! HTML file survives a headless-Chrome screenshot (`--headless
//! --screenshot=...`), which needs no display — making it the only path by
//! which the city's actual *look* (the spec's top design risk: a city that
//! reads as a scatter plot fails regardless of how good the eventual 3D
//! renderer is) gets an honest review before Task 6 commits to 3D.
//!
//! Palette and shape choices here are deliberately the ones Task 6's 3D
//! view should reuse, so the SVG preview and the eventual city read as the
//! same place rather than two different products — see `kind_color` for
//! the per-`BuildingKind` table and `KIND_ORDER` for a stable legend order.
//!
//! ## Fix round 1 (reviewer verdict: "reads as a treemap, not a city")
//!
//! The first cut encoded height only as opacity plus a barely-visible
//! shadow, drew every plot at its full RESERVED extent (including growth
//! headroom that isn't actually occupied yet — see `city::layout`'s
//! "headroom" note), used one uniform gap for every street, sat every
//! building on a perfectly regular lattice, and labelled same-named
//! districts (two different `src` directories) identically. Four
//! independent fixes, each aimed at one of those:
//!
//! - **Footprint + shadow length/blur, not just opacity, encode height**
//!   (`footprint_frac`, `shadow_offset`, `shadow_blur`) — the way an aerial
//!   photo actually reads a tall building: a bigger roof and a longer cast
//!   shadow, not a paler tile.
//! - **Plots are drawn at their CONTENT extent** (`content_extent`), not
//!   `Plot.w`/`Plot.d` — the reservation still does its job in the layout
//!   (a returning file lands in the same spot), it's just never painted as
//!   if it were already an occupied plaza.
//! - **A street hierarchy** (`avenue_bands_svg`): a genuinely empty
//!   horizontal band spanning the whole city — i.e. a real gap between one
//!   packed row of districts and the next — gets a full-width, slightly
//!   darker tint. An ordinary gap between two plots in the same row stays
//!   plain ground. This is read off the actual placed content, not
//!   asserted from the packer's internal row bookkeeping, so it can't
//!   fabricate a row boundary that isn't really there.
//! - **Deterministic per-building jitter** (`jitter`): a small, stable
//!   offset derived from the building's own path breaks the perfect-grid
//!   feel without disturbing the layout or moving between renders.
//! - **Duplicate district names get their parent folded in**
//!   (`preview_svg`'s `name_counts`): two `src` directories now read as
//!   `a/src` and `b/src`. Labels are dropped entirely for very small plots
//!   once the city is big enough that every remaining label would just be
//!   text noise (`LARGE_CITY_DISTRICTS`/`SMALL_PLOT_MAX_BUILDINGS`).
//!
//! ## Fix round 2 (reviewer follow-up)
//!
//! `avenue_bands_svg` had shipped with zero direct test coverage — a stub
//! that never emitted a band would have passed the whole suite, which is
//! the same "invented/erased structure, unverified" risk as a fabricated
//! wall. It now has direct unit tests (see this module's tests) covering:
//! a genuine gap gets a band at the exact right coordinates; no gap means
//! no band (the honesty direction); a gap narrower than
//! `MIN_AVENUE_CELLS` is not drawn; and the band's span follows the
//! CONTENT extent even when the reserved footprint differs from it.
//! Also: `label_suppression_notice` exposes when/why labels are being
//! suppressed so the binary's caption can say so (a fully unlabelled large
//! city used to be indistinguishable from a rendering bug), and
//! `city::model::EXCLUDED_DIRS`'s `out`/`coverage` entries moved to a
//! ROOT-only list (`EXCLUDED_ROOT_ONLY_DIRS`) since, unlike `.build` or
//! `ModuleCache`, those two names are plausible as real nested source
//! directories.

use crate::city::layout::{CityLayout, PlacedDistrict};
use crate::city::model::{BuildingKind, CityModel, CitySource};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Pixels per grid cell. Grid units come from `city::layout` (one cell of
/// margin, a two-cell stride between buildings — see that module's
/// `MARGIN`/`SPACING`), so this is the only knob needed to make the whole
/// preview bigger or smaller without touching any layout math.
const CELL: f64 = 16.0;

/// Outer whitespace around the whole city, in pixels.
const PADDING: f64 = 32.0;

/// Fraction of one grid cell a building's own footprint occupies, as a
/// function of its height bucket — `0.45` at height 1 up to `0.90` at
/// height 5. This, not opacity, is the primary way height reads in a
/// top-down view.
fn footprint_frac(height: u8) -> f64 {
    0.45 + (height.clamp(1, 5) as f64 - 1.0) * 0.1125
}

/// How far a building's own shadow is cast, in pixels — `0` at height 1
/// (no shadow drawn at all) growing to roughly 1.5 cells at height 5.
fn shadow_offset(height: u8) -> f64 {
    (height.clamp(1, 5) as f64 - 1.0) * 2.4
}

/// How soft (CSS `blur()` radius, in pixels) a building's shadow is —
/// grows alongside `shadow_offset` so a taller building's shadow reads as
/// both longer AND softer, the second aerial-photo cue for height.
fn shadow_blur(height: u8) -> f64 {
    (height.clamp(1, 5) as f64 - 1.0) * 0.9
}

/// Fraction of one grid cell a building may drift from its lattice
/// position, deterministically (see `jitter`) — enough to break the
/// perfect-grid/treemap feel, subtle enough to stay legible.
const JITTER_FRAC: f64 = 0.16;

/// Above this many districts, a city is crowded enough that labelling
/// every single tiny plot would drown the picture in text rather than
/// help read it — see `SMALL_PLOT_MAX_BUILDINGS`.
const LARGE_CITY_DISTRICTS: usize = 150;

/// In a large city (see `LARGE_CITY_DISTRICTS`), a district with this many
/// buildings or fewer gets no label at all.
const SMALL_PLOT_MAX_BUILDINGS: usize = 2;

/// A genuinely empty horizontal gap must be at least this many grid cells
/// tall to be drawn as a between-row "avenue" (see `avenue_bands_svg`) —
/// filters out a stray sub-cell sliver from ever being drawn as if it were
/// a real street.
const MIN_AVENUE_CELLS: i32 = 2;

const GROUND: &str = "#f4efe4";
/// Between-row streets: a hair darker than `GROUND`, so a genuine gap
/// between two packed rows of districts reads as a wider, more deliberate
/// street than an ordinary gap between two plots in the same row.
const AVENUE: &str = "#e7dfcd";
const PLOT_FILL: &str = "#e9e2d3";
const PLOT_STROKE: &str = "#cfc4ac";
const WALLED_STROKE: &str = "#a9855c";
const LABEL_FILL: &str = "#7a6f5c";

/// Per-`BuildingKind` fill. §3 asks for a calm, low-contrast, soft
/// palette rather than a diagnostic one — these are muted pastels, not
/// saturated category colours, chosen to sit quietly next to each other at
/// city scale. Task 6's 3D materials should sample this same table.
pub fn kind_color(kind: BuildingKind) -> &'static str {
    match kind {
        BuildingKind::Source => "#8fb2d9",
        BuildingKind::Test => "#8fcb9b",
        BuildingKind::Config => "#e0c27a",
        BuildingKind::Docs => "#b9a6da",
        BuildingKind::Asset => "#e2a0ae",
        BuildingKind::Data => "#7fcbc0",
    }
}

/// Human label for a legend entry.
pub fn kind_label(kind: BuildingKind) -> &'static str {
    match kind {
        BuildingKind::Source => "Source",
        BuildingKind::Test => "Test",
        BuildingKind::Config => "Config",
        BuildingKind::Docs => "Docs",
        BuildingKind::Asset => "Asset",
        BuildingKind::Data => "Data",
    }
}

/// Every `BuildingKind`, in a fixed order — for a stable legend, here and
/// in whatever Task 6 builds next to it.
pub const KIND_ORDER: [BuildingKind; 6] = [
    BuildingKind::Source,
    BuildingKind::Test,
    BuildingKind::Config,
    BuildingKind::Docs,
    BuildingKind::Asset,
    BuildingKind::Data,
];

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A darker tint of a `#rrggbb` colour, same hue family — used for a
/// building's own shadow so it reads as "this building, in shade" rather
/// than a generic black smudge (the exact bug fixed in this file's first
/// review round, when the shadow WAS plain black). Falls back to black if
/// `hex` isn't well-formed, which never happens for the fixed palette in
/// `kind_color` but keeps this total rather than panicking.
fn darken(hex: &str, factor: f64) -> String {
    let channel = |i: usize| -> u8 {
        hex.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok()).unwrap_or(0)
    };
    let scale = |c: u8| -> u8 { (c as f64 * factor).round().clamp(0.0, 255.0) as u8 };
    format!("#{:02x}{:02x}{:02x}", scale(channel(1)), scale(channel(3)), scale(channel(5)))
}

/// A small, deterministic per-building offset (in pixels, already scaled
/// by `JITTER_FRAC`/`CELL`) derived from the building's own path — stable
/// across renders (never moves just because the picture was redrawn) and
/// independent of any other building, which is what keeps it from ever
/// interacting with the layout's own position-stability guarantee.
fn jitter(path: &str) -> (f64, f64) {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let hash = hasher.finish();
    let jx = ((hash & 0xffff) as f64 / 65535.0) - 0.5;
    let jy = (((hash >> 16) & 0xffff) as f64 / 65535.0) - 0.5;
    (jx * JITTER_FRAC * CELL, jy * JITTER_FRAC * CELL)
}

/// The district's CONTENT extent, in grid cells from the plot's own
/// top-left corner — the smallest rectangle that actually holds its
/// current buildings, as opposed to `Plot.w`/`Plot.d`, which is the
/// RESERVED footprint (padded with headroom for the next file, and never
/// shrunk once grown — see `city::layout`'s module docs). A building's
/// local position is `MARGIN + col * SPACING`, so the exact content size
/// falls out of the buildings' own placed coordinates without needing
/// either private constant: the furthest building's local coordinate plus
/// one cell for its own footprint plus one trailing margin cell.
/// Falls back to a single building's minimum footprint (3x3: one margin
/// cell either side of one building cell) if a district somehow has no
/// buildings, which should not happen in practice but must not draw a
/// zero-size or panic if it did.
fn content_extent(district: &PlacedDistrict) -> (u32, u32) {
    if district.buildings.is_empty() {
        return (3, 3);
    }
    let max_local_x = district.buildings.iter().map(|b| b.x - district.plot.x).max().unwrap_or(0);
    let max_local_z = district.buildings.iter().map(|b| b.z - district.plot.z).max().unwrap_or(0);
    let w = ((max_local_x + 2).max(1) as u32).min(district.plot.w);
    let d = ((max_local_z + 2).max(1) as u32).min(district.plot.d);
    (w, d)
}

/// Full-width tinted bands across genuinely empty horizontal gaps between
/// districts' occupied z-ranges — the street separating one shelf-packed
/// row from the next (see `city::layout`'s row/frontier packing). Computed
/// purely from where districts' CONTENT (not reserved footprint) actually
/// sits: every district's `[z, z + content_depth)` interval is merged with
/// every other overlapping one, and whatever's left over between merged
/// intervals is a real, unoccupied horizontal band. This stays honest even
/// where a cached district's growth-in-place has shifted it off whatever
/// row the packer originally put it in, since it never consults the
/// packer's own row bookkeeping at all — only what's actually empty.
/// Ordinary gaps between two plots within the same row are never touched,
/// which is what makes the two read as a hierarchy rather than one uniform
/// gap everywhere.
fn avenue_bands_svg(layout: &CityLayout, extents: &[(u32, u32)], width: f64) -> String {
    let mut spans: Vec<(i32, i32)> = layout
        .districts
        .iter()
        .zip(extents)
        .map(|(d, &(_, cd))| (d.plot.z, d.plot.z + cd as i32))
        .collect();
    spans.sort_by_key(|s| s.0);

    let mut merged: Vec<(i32, i32)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }

    let mut out = String::new();
    for pair in merged.windows(2) {
        let (gap_start, gap_end) = (pair[0].1, pair[1].0);
        if gap_end - gap_start < MIN_AVENUE_CELLS {
            continue;
        }
        let y = gap_start as f64 * CELL + PADDING;
        let h = (gap_end - gap_start) as f64 * CELL;
        out.push_str(&format!(
            "<rect class=\"avenue\" x=\"0\" y=\"{y:.1}\" width=\"{width:.1}\" height=\"{h:.1}\" fill=\"{AVENUE}\" />\n"
        ));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn district_svg(
    district: &PlacedDistrict,
    model: &CityModel,
    content_w: u32,
    content_d: u32,
    name_counts: &HashMap<&str, u32>,
    suppress_small_labels: bool,
    out: &mut String,
) {
    let d = &model.districts[district.district_index];
    let plot = &district.plot;
    let px = plot.x as f64 * CELL + PADDING;
    let pz = plot.z as f64 * CELL + PADDING;
    // Drawn at CONTENT extent, not the reserved `plot.w`/`plot.d` — see
    // `content_extent`'s doc comment for why.
    let pw = content_w as f64 * CELL;
    let pd = content_d as f64 * CELL;

    // Walled districts get a distinct, heavier border rather than a
    // different fill — the plot itself should still read as "the same
    // material", just fenced.
    let stroke = if d.walled { WALLED_STROKE } else { PLOT_STROKE };
    let stroke_width = if d.walled { 2.6 } else { 1.2 };
    out.push_str(&format!(
        "<rect class=\"plot{}\" x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"4\" fill=\"{}\" stroke=\"{}\" stroke-width=\"{}\" />\n",
        if d.walled { " walled" } else { "" },
        px,
        pz,
        pw,
        pd,
        PLOT_FILL,
        stroke,
        stroke_width,
    ));

    let suppress_label = suppress_small_labels && d.buildings.len() <= SMALL_PLOT_MAX_BUILDINGS;
    if !suppress_label {
        // Two directories can share a basename (two `src`s under different
        // parents) — disambiguate with the parent segment whenever that
        // basename isn't unique across the whole city, rather than always
        // qualifying (which would just add noise to the common case).
        let duplicated = name_counts.get(d.name.as_str()).copied().unwrap_or(0) > 1;
        let label = if duplicated {
            Path::new(&d.path)
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| format!("{}/{}", n.to_string_lossy(), d.name))
                .unwrap_or_else(|| d.name.clone())
        } else {
            d.name.clone()
        };
        let font_size: f64 = (CELL * 0.6).clamp(7.0, 11.0);
        out.push_str(&format!(
            "<text class=\"district-label\" x=\"{:.1}\" y=\"{:.1}\" font-size=\"{:.1}\" fill=\"{}\">{}</text>\n",
            px + 4.0,
            pz + font_size + 1.0,
            font_size,
            LABEL_FILL,
            escape_xml(&label),
        ));
    }

    for b in &district.buildings {
        let building = &d.buildings[b.building_index];
        let bx = b.x as f64 * CELL + PADDING;
        let bz = b.z as f64 * CELL + PADDING;
        let height = b.height.clamp(1, 5);
        let size = CELL * footprint_frac(height);
        let inset = (CELL - size) / 2.0;
        let (jx, jy) = jitter(&building.path);
        let cx = bx + inset + jx;
        let cy = bz + inset + jy;
        let color = kind_color(building.kind);

        let offset = shadow_offset(height);
        if offset > 0.0 {
            let blur = shadow_blur(height);
            let shadow_color = darken(color, 0.55);
            out.push_str(&format!(
                "<rect class=\"shadow\" x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"3\" fill=\"{}\" opacity=\"0.30\" style=\"filter: blur({:.1}px)\" />\n",
                cx + offset,
                cy + offset,
                size,
                size,
                shadow_color,
                blur,
            ));
        }

        out.push_str(&format!(
            "<rect class=\"building h{}\" x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"3\" fill=\"{}\" />\n",
            height, cx, cy, size, size, color,
        ));
    }
}

/// Whether `preview_svg` will suppress labels on small plots for `model`
/// (see `LARGE_CITY_DISTRICTS`/`SMALL_PLOT_MAX_BUILDINGS`), and a short,
/// human-readable reason if so — for the binary's caption. Without this, a
/// large city with every tiny plot correctly left unlabelled looks
/// identical to a rendering bug that silently ate every label; this makes
/// the render self-explaining instead.
pub fn label_suppression_notice(model: &CityModel) -> Option<String> {
    (model.districts.len() > LARGE_CITY_DISTRICTS)
        .then(|| format!("labels hidden above {LARGE_CITY_DISTRICTS} districts"))
}

/// A short, human-readable note for the binary's caption when `model` has
/// one or more excluded git submodules (`CityModel::submodules`) — same
/// spirit as `label_suppression_notice`: a city that is honestly missing
/// a submodule's subtree (a deliberate exclusion — see
/// `city::model::RealFiles::files` for why) must not look identical to
/// one that silently lost it to a bug. Caption text only; no drawing
/// changes.
pub fn submodule_notice(model: &CityModel) -> Option<String> {
    (model.submodules > 0).then(|| {
        let n = model.submodules;
        let noun = if n == 1 { "submodule" } else { "submodules" };
        format!("{n} {noun} not shown")
    })
}

/// A short, human-readable note for the binary's caption when `model`'s
/// file list came from the filesystem-walk fallback rather than git's own
/// answer (`CityModel::source` — see `city::model::RealFiles::files` for
/// exactly when that happens: no git repo, `git` missing, or the
/// `RealGitFiles` call otherwise failing/timing out).
///
/// Important 3 (Phase 0.5b final-fix review): the walk applies only
/// `EXCLUDED_DIRS`, so it can surface gitignored build output and `.env`
/// files as buildings, silently drops symlinks, and never detects
/// submodules — a materially different, less trustworthy city than git's
/// own answer, and before this notice existed nothing distinguished the
/// two in the rendered output at all. Caption text only; no drawing
/// changes, same spirit as `label_suppression_notice`/`submodule_notice`.
pub fn source_notice(model: &CityModel) -> Option<String> {
    (model.source == CitySource::Walk)
        .then(|| "git unavailable — showing a filesystem guess, not git's own file list".to_string())
}

/// Draws `model`/`layout` top-down: a pale ground, a street hierarchy
/// (`avenue_bands_svg`), district plots as quiet blocks with their names
/// (disambiguated when a basename repeats; suppressed for tiny plots once
/// the city is big enough to get crowded), and one rect per building with
/// class `building h<height>` and a fill by `kind` — height reads
/// primarily as footprint size and shadow reach, not opacity alone (see
/// this module's "Fix round 1" doc comment). Walled districts get a
/// distinct border. `layout.width`/`layout.depth` (the cached extent
/// INCLUDING holes — see `CityLayout`) size the viewBox, not a
/// recomputation from the present districts, so a deleted district never
/// rescales the preview.
pub fn preview_svg(model: &CityModel, layout: &CityLayout) -> String {
    let width = (layout.width as f64 * CELL + PADDING * 2.0).max(200.0);
    let height = (layout.depth as f64 * CELL + PADDING * 2.0).max(200.0);

    let mut name_counts: HashMap<&str, u32> = HashMap::new();
    for d in &model.districts {
        *name_counts.entry(d.name.as_str()).or_insert(0) += 1;
    }
    let suppress_small_labels = model.districts.len() > LARGE_CITY_DISTRICTS;

    // Computed once, reused both for drawing each plot at its content
    // extent (not its reserved one) and for finding the real between-row
    // gaps below.
    let extents: Vec<(u32, u32)> = layout.districts.iter().map(content_extent).collect();

    let mut body = String::new();
    body.push_str(&avenue_bands_svg(layout, &extents, width));
    for (district, &(content_w, content_d)) in layout.districts.iter().zip(&extents) {
        district_svg(
            district,
            model,
            content_w,
            content_d,
            &name_counts,
            suppress_small_labels,
            &mut body,
        );
    }

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {width:.1} {height:.1}\" width=\"{width:.1}\" height=\"{height:.1}\">\n\
<style>\n\
  .building {{ stroke: rgba(0,0,0,0.08); stroke-width: 0.6; }}\n\
  .building.h1 {{ opacity: 0.7; }}\n\
  .building.h2 {{ opacity: 0.8; }}\n\
  .building.h3 {{ opacity: 0.88; }}\n\
  .building.h4 {{ opacity: 0.95; }}\n\
  .building.h5 {{ opacity: 1; stroke: rgba(0,0,0,0.2); stroke-width: 1; }}\n\
  .district-label {{ font-family: -apple-system, 'Segoe UI', sans-serif; letter-spacing: 0.02em; }}\n\
</style>\n\
<rect x=\"0\" y=\"0\" width=\"{width:.1}\" height=\"{height:.1}\" fill=\"{GROUND}\" />\n\
{body}\
</svg>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::layout::{layout_city, Plot};
    use crate::city::model::{build_city, FileSource};
    use std::path::{Path, PathBuf};

    // Adapted from the task brief's starting test to the current
    // `FileSource` signature (`Vec<(PathBuf, Option<u32>)>`, `None` meaning
    // "unreadable" — see `city::model::FileSource`), which evolved after
    // this brief was written. The class assertion matches on
    // `class="building "` (with the trailing space) rather than the exact
    // `class="building"`, since Step 3's own spec calls for `building
    // h<height>` as the class, not a bare `building`.
    struct FakeFiles(Vec<(String, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), Some(*n))).collect()
        }
    }

    fn fake(paths: &[(&str, u32)]) -> FakeFiles {
        FakeFiles(paths.iter().map(|(p, n)| (p.to_string(), *n)).collect())
    }

    /// Finds `class="{class}"` in `svg`, then returns the numeric value of
    /// the next `attr="..."` after that point — a small helper so tests can
    /// check actual geometry (footprint size, plot size) rather than only
    /// substring presence.
    fn attr_after(svg: &str, class: &str, attr: &str) -> f64 {
        let marker = format!("class=\"{class}\"");
        let start = svg.find(&marker).unwrap_or_else(|| panic!("{marker} not found in svg"));
        let tail = &svg[start..];
        let attr_marker = format!(" {attr}=\"");
        let a = tail.find(&attr_marker).unwrap_or_else(|| panic!("{attr} not found after {marker}"))
            + attr_marker.len();
        let b = tail[a..].find('"').unwrap();
        tail[a..a + b].parse().unwrap_or_else(|_| panic!("{attr} was not numeric"))
    }

    /// A minimal `PlacedDistrict` for `avenue_bands_svg` unit tests: only
    /// `plot.z` matters to that function (it never reads `plot.x`/`plot.w`,
    /// and the content depth it uses comes from the separate `extents`
    /// slice, not from `plot.d`) — everything else is a harmless filler
    /// value.
    fn district_at(z: i32, reserved_d: u32) -> PlacedDistrict {
        PlacedDistrict {
            district_index: 0,
            plot: Plot { x: 0, z, w: 3, d: reserved_d },
            buildings: Vec::new(),
            road_edges: Vec::new(),
        }
    }

    fn layout_of(districts: Vec<PlacedDistrict>) -> CityLayout {
        CityLayout { districts, width: 1_000, depth: 1_000, grid_pitch: crate::city::layout::SPACING }
    }

    // `avenue_bands_svg` fix round 2, Important: this function shipped with
    // zero direct test coverage — a stub that always returned `String::new()`
    // would have passed the entire suite, which is the same
    // unverified-structural-claim risk as a fabricated wall. Verified by
    // mutation while writing these: temporarily replacing the function body
    // with `String::new()` turned
    // `a_genuine_row_gap_gets_an_avenue_at_the_right_coordinates` and
    // `the_avenue_follows_content_extent_not_the_reserved_footprint` red,
    // and replacing the `< MIN_AVENUE_CELLS` guard with `< 1` turned
    // `a_gap_narrower_than_the_minimum_gets_no_avenue` red — each test
    // fails for the specific reason it exists to catch.

    #[test]
    fn a_genuine_row_gap_gets_an_avenue_at_the_right_coordinates() {
        let a = district_at(0, 3); // content occupies z:[0, 3)
        let b = district_at(10, 3); // content occupies z:[10, 13)
        let layout = layout_of(vec![a, b]);
        let extents = vec![(3, 3), (3, 3)];

        let svg = avenue_bands_svg(&layout, &extents, 500.0);

        assert!(svg.contains("class=\"avenue\""));
        let expected_y = 3.0 * CELL + PADDING; // gap starts where A's content ends
        let expected_h = 7.0 * CELL; // gap is 10 - 3 = 7 cells tall
        assert!(svg.contains(&format!("y=\"{expected_y:.1}\"")), "avenue svg: {svg}");
        assert!(svg.contains(&format!("height=\"{expected_h:.1}\"")), "avenue svg: {svg}");
        assert!(svg.contains("x=\"0\""));
        assert!(svg.contains("width=\"500.0\""), "avenue must span the full given city width");
    }

    #[test]
    fn no_avenue_is_fabricated_when_rows_actually_touch() {
        // Content spans z:[0,5) and z:[5,10) — contiguous, zero real gap.
        let a = district_at(0, 5);
        let b = district_at(5, 5);
        let layout = layout_of(vec![a, b]);
        let extents = vec![(3, 5), (3, 5)];

        let svg = avenue_bands_svg(&layout, &extents, 500.0);
        assert_eq!(svg, "", "no real gap exists between the rows, so no street may be drawn");
    }

    #[test]
    fn a_gap_narrower_than_the_minimum_gets_no_avenue() {
        // Content occupies z:[0,3) and z:[3 + (MIN_AVENUE_CELLS - 1), ..) —
        // a gap exactly one cell short of the threshold.
        let a = district_at(0, 3);
        let b = district_at(3 + MIN_AVENUE_CELLS - 1, 3);
        let layout = layout_of(vec![a, b]);
        let extents = vec![(3, 3), (3, 3)];

        let svg = avenue_bands_svg(&layout, &extents, 500.0);
        assert_eq!(svg, "", "a gap narrower than MIN_AVENUE_CELLS must not be drawn as a street");
    }

    #[test]
    fn the_avenue_follows_content_extent_not_the_reserved_footprint() {
        // District A reserves a much deeper plot (10 cells) than it
        // currently uses (content depth 3 cells) — the exact headroom
        // scenario `content_extent` exists to see through (see that
        // function's doc comment). If this function read `plot.d` instead
        // of the passed `extents`, A's z-interval would be computed as
        // [0, 10), touching B's [10, 13) with a ZERO-width gap and
        // silently erasing a street that the picture actually needs (A is
        // only drawn 3 cells deep, so there IS a real 7-cell gap).
        let a = district_at(0, 10);
        let b = district_at(10, 3);
        let layout = layout_of(vec![a, b]);
        let extents = vec![(3, 3), (3, 3)]; // both content depths are 3

        let svg = avenue_bands_svg(&layout, &extents, 500.0);
        let expected_y = 3.0 * CELL + PADDING;
        let expected_h = 7.0 * CELL;
        assert!(
            svg.contains(&format!("y=\"{expected_y:.1}\""))
                && svg.contains(&format!("height=\"{expected_h:.1}\"")),
            "avenue must follow A's CONTENT depth (3), not its reserved depth (10): {svg}"
        );
    }

    #[test]
    fn the_svg_contains_one_rect_per_building_and_names_each_district() {
        let model = build_city(
            Path::new("/p/api"),
            &fake(&[("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 400)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));

        assert_eq!(svg.matches("class=\"building ").count(), 2);
        assert!(svg.contains("src"), "district name must be labelled");
        assert!(svg.starts_with("<svg"));
    }

    #[test]
    fn taller_buildings_are_visually_distinct() {
        let model = build_city(
            Path::new("/p/api"),
            &fake(&[("/p/api/src/tiny.rs", 5), ("/p/api/src/huge.rs", 9_000)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));
        // Height must reach the output somehow — here, as the building's
        // own class (which also drives opacity via the embedded stylesheet).
        assert!(svg.contains("building h1") && svg.contains("building h5"));
    }

    #[test]
    fn taller_buildings_have_a_visibly_bigger_footprint_than_shorter_ones() {
        // Fix round 1: height must read primarily as footprint size (and
        // shadow reach), not opacity alone — a treemap of same-size tiles
        // does not read as a skyline no matter how it's shaded.
        let model = build_city(
            Path::new("/p/api"),
            &fake(&[("/p/api/src/tiny.rs", 5), ("/p/api/src/huge.rs", 9_000)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));
        let w1 = attr_after(&svg, "building h1", "width");
        let w5 = attr_after(&svg, "building h5", "width");
        assert!(w5 > w1 * 1.5, "h5 footprint ({w5}) should be much larger than h1's ({w1})");
    }

    #[test]
    fn a_plot_is_drawn_at_its_content_extent_not_its_reserved_headroom() {
        // Fix round 1: a freshly allocated plot is sized with headroom for
        // one MORE building than it currently has (`city::layout`'s
        // "headroom" note) — drawing it at that reserved size paints the
        // headroom as if it were already an occupied plaza, which is the
        // "large empty margins" void the reviewer flagged.
        let model = build_city(Path::new("/p/api"), &fake(&[("/p/api/src/a.rs", 10)]));
        let layout = layout_city(&model);
        let reserved = &layout.districts[0].plot;
        assert!(
            reserved.w > 3,
            "fixture must actually carry reserved headroom for this test to mean anything"
        );

        let svg = preview_svg(&model, &layout);
        let drawn_w = attr_after(&svg, "plot", "width");
        assert_eq!(drawn_w, 3.0 * CELL, "one building's plot should draw at its exact content size");
    }

    #[test]
    fn duplicate_district_names_are_disambiguated_with_their_parent() {
        let model = build_city(
            Path::new("/p/api"),
            &fake(&[("/p/api/a/src/x.rs", 10), ("/p/api/b/src/y.rs", 10)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));
        assert!(svg.contains(">a/src<"), "duplicate basenames must be disambiguated by parent");
        assert!(svg.contains(">b/src<"));
    }

    #[test]
    fn tiny_districts_are_unlabelled_once_the_city_is_large_enough_to_get_crowded() {
        let files: Vec<(String, u32)> = (0..(LARGE_CITY_DISTRICTS + 1))
            .map(|i| (format!("/p/api/d{i}/f.rs"), 10))
            .collect();
        let model = build_city(Path::new("/p/api"), &FakeFiles(files));
        assert!(model.districts.len() > LARGE_CITY_DISTRICTS);

        let svg = preview_svg(&model, &layout_city(&model));
        // Not a bare `contains("district-label")`: the embedded stylesheet
        // always defines that class's rule regardless of whether any tag
        // uses it, so the check must look for the class actually being
        // applied to an element.
        assert!(
            !svg.contains("class=\"district-label\""),
            "every district here has exactly 1 building, so a large city must suppress all of them"
        );
    }

    #[test]
    fn the_svg_is_byte_identical_across_renders_so_jitter_never_moves_a_building() {
        let model = build_city(
            Path::new("/p/api"),
            &fake(&[("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 400)]),
        );
        let layout = layout_city(&model);
        assert_eq!(preview_svg(&model, &layout), preview_svg(&model, &layout));
    }

    #[test]
    fn a_deleted_district_does_not_shrink_the_viewbox() {
        // `layout.width`/`depth` are the cached extent including holes;
        // the viewBox must be derived from those, not from a fresh scan of
        // `layout.districts`.
        let model = build_city(Path::new("/p/api"), &fake(&[("/p/api/src/a.rs", 10)]));
        let mut layout = layout_city(&model);
        layout.width += 500;
        layout.depth += 500;
        layout.districts.clear();
        let expected_width = layout.width as f64 * CELL + PADDING * 2.0;

        let svg = preview_svg(&model, &layout);
        assert!(svg.contains(&format!("{expected_width:.1}")));
    }

    /// Coordinator review, Item 1: the caption must say when submodules
    /// were excluded, in the same spirit as `label_suppression_notice`,
    /// and must say nothing when there are none — this only touches the
    /// caption string, never the drawing.
    #[test]
    fn submodule_notice_reports_the_count_and_is_absent_when_zero() {
        let mut model = build_city(Path::new("/p/api"), &fake(&[("/p/api/src/a.rs", 10)]));
        assert_eq!(model.submodules, 0, "a plain FakeFiles source reports no submodules");
        assert_eq!(submodule_notice(&model), None);

        model.submodules = 1;
        assert_eq!(submodule_notice(&model).as_deref(), Some("1 submodule not shown"));

        model.submodules = 3;
        assert_eq!(submodule_notice(&model).as_deref(), Some("3 submodules not shown"));
    }

    /// Important 3 (Phase 0.5b final-fix review): a degraded
    /// (filesystem-walk) render must say so in the caption, and a healthy
    /// git-sourced one must say nothing — same drawing either way, only
    /// the notice differs.
    #[test]
    fn source_notice_appears_only_for_a_degraded_walk_source() {
        let mut model = build_city(Path::new("/p/api"), &fake(&[("/p/api/src/a.rs", 10)]));
        assert_eq!(model.source, CitySource::Git, "a plain FakeFiles source reports Git");
        assert_eq!(source_notice(&model), None);

        model.source = CitySource::Walk;
        assert_eq!(
            source_notice(&model).as_deref(),
            Some("git unavailable — showing a filesystem guess, not git's own file list")
        );
    }
}
