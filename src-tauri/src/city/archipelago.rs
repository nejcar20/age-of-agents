//! Lays out every one of the user's repositories as an island in a shared
//! sea — the data layer behind the archipelago screen ("fly over the sea,
//! every repo an island, click one to land in its town").
//!
//! This is `city::layout` one level up: instead of packing a repository's
//! DISTRICTS onto one repository's road grid, it packs the user's
//! REPOSITORIES onto one shared sea. The design constraints are the same
//! ones `layout.rs`'s module doc spent four fix rounds earning, so this
//! module follows that pattern deliberately rather than re-deriving it:
//!
//! - **A repository's island keeps its position across sessions.** Keyed by
//!   its canonical root (`world::repo::normalize_path` — the only
//!   canonicalization path in this codebase; see that module's doc comment
//!   for the bugs an independent second normalization has caused here
//!   before), persisted to `~/.age-of-agents/archipelago.json`, and never
//!   evicted: a repository that stops being discovered (deleted, moved, a
//!   scan miss) leaves its plot as an honest hole a same-path repository
//!   reclaims exactly if it returns — the identical "never compact, never
//!   evict" contract `LayoutCache.plots` already keeps for districts.
//! - **A single cache file**, not one per repo. `LayoutCache` gets one file
//!   per repository because a repository's OWN layout is the unit of work a
//!   click ever asks for (`city_for` only ever loads one). The archipelago
//!   is inherently a single cross-repository object — one sea, one packing
//!   frontier shared by every island — so splitting it across files would
//!   only add I/O for no benefit; `towns/` stays exactly as it is.
//! - **No two islands ever overlap, and open water always separates them.**
//!   Reuse-if-it-still-fits, grow-in-place-if-possible, relocate-only-if-
//!   blocked — the same three-way rule `layout_with_cache` uses for a
//!   district's plot, applied here to a whole repository's plot. A fixed
//!   water margin is baked into every plot's own extent (`plan_reserved`),
//!   the same way `MARGIN` is baked into a district's plot around its
//!   buildings, so two plots packed edge-to-edge still leave real sea
//!   (`2 * SEA_MARGIN` grid units, never less — see that constant) between
//!   the two LANDS drawn inside them.
//! - **A sea reads as a sea, not a packed tile floor.** `pack_with_cache`'s
//!   Phase 1 (reuse/grow/relocate) is shared with `layout.rs` because it's
//!   the right rule for either target; what changed is where a BRAND-NEW
//!   root's plot comes from. Shelf-packing (rows of plots left-to-right,
//!   wrapping downward) is exactly right for a town block — dense, legible,
//!   rectangular — and exactly wrong for a sea: rendered on the author's
//!   real 73 repositories it produced one long diagonal conveyor-belt strip,
//!   corner to corner, that reads as a packing algorithm's output because
//!   that is precisely what it was. A fresh root's plot is now allocated
//!   from a golden-angle (phyllotaxis) spiral instead (`spiral_center`,
//!   `allocate_free_plot`): slot `k`'s centre sits at radius `unit·√k` and
//!   angle `k · GOLDEN_ANGLE_RADIANS`. The `√k` radius spreads the cluster
//!   outward in two dimensions at even density as it grows (this is Vogel's
//!   model, the same one a sunflower's seed head uses); the golden angle is
//!   the one irrational turn-fraction for which no run of consecutive
//!   slots ever nearly repeats, so islands never line up into visible
//!   spokes or rings the way any "nicer" fixed angle eventually would. Slot
//!   0 is the exact centre — see the next bullet. Collision safety is NOT
//!   assumed from the spiral's spacing: `allocate_free_plot` still checks
//!   every candidate against `SpatialIndex` and advances to the next slot
//!   on any overlap, so overlap-freedom holds regardless of how the spiral
//!   is tuned; the tuning (`spiral_unit_for`) only affects how often that
//!   fallback search is needed and how tight the cluster looks.
//! - **The sea has a heart.** Among the roots newly appointed a slot in one
//!   `pack_with_cache` call, the ones with the biggest reserved footprint
//!   are assigned the smallest slot numbers first — closest to the spiral's
//!   centre — so the biggest city in a freshly-built archipelago sits at
//!   its heart rather than wherever the scan happened to list it. This is
//!   deliberately scoped to ONLY brand-new roots in a single call: an
//!   already-placed root's position is never touched by a sibling's size,
//!   because doing so would violate the stability guarantee above — a
//!   repository that grows into the biggest one later does not (and must
//!   not) yank every other island's position to make room for it at the
//!   centre. Where the two goals genuinely conflict, stability wins.
//! - **A big repository gets a big island.** A plot's land size is read
//!   from the repository's own `CityLayout` extent (`layout_city_persisted`
//!   — the exact same layout `city_for` returns, so the sea and the town a
//!   player lands in are provably the same measurement, never two
//!   independent derivations of "how big is this repo").
//! - **This module has the same permanent property test `layout.rs` does,
//!   for the same reason.** `docs/superpowers/phase-0-followups.md` records
//!   that the plot-overlap bug class recurred four times in `layout.rs` and
//!   was missed by hand-written cases every time; a generated random-history
//!   test found a violating seed in a fraction of a second where hand-picked
//!   cases found nothing. `packed_islands_never_overlap_and_a_returning_
//!   island_reclaims_its_position_across_random_histories` below is that
//!   same kind of test, over islands appearing, disappearing, and resizing
//!   instead of districts.
//!
//! ## Honesty: an island's size is a measurement, or it says it isn't one
//!
//! Principle 4 (this codebase's honesty rule) applies to the sea exactly as
//! it does to a town: an island must correspond to a real repository, its
//! size must derive from that repository's real `CityModel`/`CityLayout`,
//! and a repository whose city could not be honestly measured must be
//! VISIBLY unknown rather than silently drawn at some default size that
//! reads as a real one. `docs/superpowers/phase-0-followups.md` §6 records
//! four honesty defects from this exact phase, every one found by a human
//! looking at a rendered image while a green test suite reported success —
//! this module is written with that history in mind, not as an abstract
//! precaution.
//!
//! `CityStatus::Unknown` is the concrete answer: the one real "cannot be
//! measured" case this module detects is a repository root that no longer
//! exists on disk (deleted, moved, a stale scan). `describe_city` checks
//! this BEFORE calling `build_city` — `build_city`'s own fallback path
//! (`RealFiles`'s git-then-walk) degrades a missing/broken repo into an
//! empty-looking `CityModel` (zero districts, zero buildings) that is
//! bit-for-bit indistinguishable from a genuinely empty real repository,
//! which is exactly the failure mode principle 4 forbids: a fabricated
//! "measurement" of zero is not honestly zero. An `Unknown` island still
//! gets a plot in the sea (so a real repository is never silently dropped
//! from the archipelago), but its `CityStatus` tells the frontend, in the
//! data itself, that this is not a to-scale landmass — see `resolve_island`.
//!
//! ## Cost: never build a `CityModel` on every call
//!
//! `build_city` walks `git ls-files` and reads every surviving file to
//! count its lines — on `my-site-next` (1,057 buildings) that took ~0.24s
//! measured cold; across the author's five real repositories it was ~0.9s
//! combined (see the fix report). Rebuilding every repository's `CityModel`
//! on every archipelago fetch would make the sea view exactly the kind of
//! UI-stalling rebuild `city_for`'s own doc comment (and
//! `herdr::events::build_world_off_thread`'s) already exists to prevent one
//! level down.
//!
//! **Where this actually runs, checked directly rather than assumed**
//! (Phase 0.5b perf follow-up): `get_archipelago` is called from exactly
//! three places in `src/useArchipelago.ts` — once on mount, once on every
//! `window` `focus` event, and once from `refetch()` right after
//! `create_project` succeeds. It is deliberately NOT re-run on every
//! `world-updated` push the way an earlier draft of this doc comment
//! worried it might be; `useArchipelago.ts`'s own doc comment says so
//! explicitly, citing the exact `phase-0-followups.md` §5a mistake (~279
//! filesystem scans in 15 seconds from refetching the unsettled list on
//! every world tick) as the thing this hook was written to avoid repeating.
//! So a slow `get_archipelago` is a slow FIRST PAINT and a slow
//! ALT-TAB-BACK-INTO-THE-APP, not a tax on the herdr event loop that detects
//! a stopped agent — that loop's own cost lives entirely in
//! `herdr::events::build_world_off_thread` and `world::repo::RepoResolver`,
//! neither of which this module touches. That does not make 9s/2.2s
//! acceptable (principle 2 draws no exception for "only on first paint and
//! alt-tab"), it just means the fix below is about the sea's own latency,
//! not about protecting a different, more critical loop.
//!
//! The fix: `Island.last_changed_at`'s equivalent here — this module asks
//! `git` directly for each root's own last-commit epoch
//! (`world::repo::GitProbe::last_commit_epoch`, the same call
//! `RepoResolver::last_changed` uses) — IS the natural cache key. A cached
//! summary is reused verbatim, no `build_city` call at all, whenever the
//! repository's last-commit epoch is unchanged from the value recorded when
//! that summary was computed. `None` (no commits yet, not a repository, the
//! git call timed out) is never trusted as "unchanged": a freshness signal
//! this module cannot verify is treated as "always stale" rather than risking
//! a summary that silently stops tracking a repository forever (see
//! `resolve_island`'s doc comment for the one accepted cost of that choice).
//! The whole pipeline — discovery, the per-root git calls, any `build_city`
//! calls this triggers — runs inside one `tauri::async_runtime::
//! spawn_blocking`, exactly the pattern `herdr::events::build_world_off_
//! thread` and `commands::city_for` both already use to keep this off the
//! async runtime's own worker threads.
//!
//! **Phase 0.5b discovery-depth fix, follow-up — fixed:** removing
//! discovery's depth cap raised the author's real island count from 73 to
//! 152, and `build_archipelago_for_roots`'s `for (root, name) in roots` loop
//! used to be strictly sequential — one `git` subprocess spawn per root even
//! when everything was cache-warm, plus a full `build_city` walk per root
//! that was NOT warm. Measured on the author's real 152-repo tree BEFORE
//! this fix (cache cleared to force a genuine cold run): cold ~14.2s, warm
//! (immediate re-fetch, every root's per-root cache already fresh) ~2.0s
//! just from 152 sequential `git` spawns. Two independent changes closed
//! this, both scoped to this function:
//!
//! 1. **The warm-path `git` spawn is gone, not just cached per-root.**
//!    `ArchipelagoCache.computed_at` records when this cache was last fully
//!    computed; a call made within `REVALIDATION_SKIP_WINDOW` of that time
//!    trusts every root's existing `CachedSummary` verbatim
//!    (`resolve_island_from_recent_cache`) with NO `git` call at all, rather
//!    than spawning `git log` per root only to very likely learn nothing
//!    changed. A root with no cached summary yet (brand new, or never
//!    honestly measured) is never eligible for this shortcut — it is still
//!    always measured for real. See `REVALIDATION_SKIP_WINDOW`'s own doc
//!    comment for the exact staleness this accepts (up to the window's
//!    length, bounded and documented, never silent).
//! 2. **What remains (a cold cache, or a call past the window) is
//!    parallelized, bounded.** Per-root resolution is independent work —
//!    nothing one root's `resolve_island`/`describe_city` touches is shared
//!    with another's (`layout_city_persisted`'s own per-repo cache file is
//!    keyed by that repo's own path hash) — so it now runs across
//!    `MAX_CONCURRENT_REPO_WORKERS` worker threads via `std::thread::scope`
//!    instead of one at a time, still entirely inside the same
//!    `spawn_blocking` call.
//!
//! Measured on the same real 152-repo tree AFTER this fix (release build):
//! cold (cache cleared) ~1.5-2.0s; warm inside `REVALIDATION_SKIP_WINDOW`
//! (the mount-then-focus pattern `useArchipelago.ts` actually makes)
//! ~1-5ms; warm PAST the window with every commit epoch unchanged (the more
//! common "re-focused minutes later" case, where the parallelization from
//! point 2 above — not the skip window from point 1 — is what's doing the
//! work) ~200ms. See `archipelago-perf-report.md` for the exact run-by-run
//! numbers, including the debug-build ones.
//!
//! **Honest residual:** cold no longer scales with island COUNT the way it
//! used to, but it still has a floor set by the single SLOWEST individual
//! repository's own `describe_city` walk, because that one walk is not
//! itself parallelized — with several of the author's real repositories
//! (mostly `git worktree`s of active work) now over 1,500-2,500 buildings
//! each, comfortably bigger than the ~1,057-building repo this module's
//! "Cost" section was originally written against, that floor sits close to
//! this fix's own ~1.5-2.0s cold measurement: work-stealing across every
//! OTHER root already finishes while the single biggest one is still
//! walking. Shrinking that floor further would mean parallelizing file
//! reads INSIDE a single `build_city` call, which is `city::model`'s
//! concern, shared with `city_for`'s own click-path cost, and deliberately
//! left out of this fix's scope. `spawn_blocking` still keeps all of this
//! off the async runtime's own worker thread regardless of how long it
//! takes, but that was never the bottleneck this fix addresses — see the
//! "where this actually runs" note above.

use crate::city::layout::layout_city_persisted_from_root;
use crate::city::model::{CitySource, RealFiles, RealGitFiles};
use crate::world::repo::{GitProbe, RealGit};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------
// What the frontend gets
// ---------------------------------------------------------------------

/// One island's position and footprint in the shared sea, in the same kind
/// of abstract grid units `city::layout::Plot` uses for a district — an
/// arbitrary integer coordinate space the frontend scales to world units,
/// not a physical measurement of its own.
///
/// Deliberately the WHOLE reserved cell, water margin included — the same
/// convention `Plot` uses for a district (its `MARGIN` is baked into the
/// plot's own extent, not drawn as a separate ring). The frontend draws the
/// island's actual landmass at `city`'s reported `width`/`depth`, centered
/// inside this plot, exactly as `plan_district` centers a district's
/// buildings inside its own (margin-inclusive) `Plot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IslandPlot {
    pub x: i32,
    pub z: i32,
    pub w: u32,
    pub d: u32,
}

/// Mirrors `city::model::CitySource` without depending on it having
/// `Deserialize` (it deliberately doesn't — `CityModel` is never round-
/// tripped through JSON on this codebase's read side, only ever produced
/// fresh and serialized out to the frontend). This is the one piece of a
/// `CityModel` this module's cache actually persists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceKind {
    Git,
    Walk,
}

impl From<CitySource> for SourceKind {
    fn from(source: CitySource) -> Self {
        match source {
            CitySource::Git => SourceKind::Git,
            CitySource::Walk => SourceKind::Walk,
        }
    }
}

/// A repository's city, compact enough to hand back for EVERY island on
/// EVERY archipelago fetch without ever building a full `CityModel` inline
/// (see the module doc's "Cost" section) — never the full `CityModel`
/// (`my-site-next` alone is 1,057 buildings; `city_for` is still how the
/// frontend gets the real thing once the player actually lands).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CityStatus {
    /// A real measurement: `build_city` ran (or a cached measurement, keyed
    /// on the repo's own last-commit epoch, was reused verbatim — see the
    /// module doc). `width`/`depth` are `layout_city_persisted`'s own
    /// extent for this repo, the exact numbers `city_for` would also
    /// return.
    Known {
        district_count: usize,
        building_count: usize,
        width: u32,
        depth: u32,
        source: SourceKind,
        /// Opus review, IMPORTANT 2: the Unix timestamp (seconds) this
        /// measurement was ACTUALLY taken at — i.e. the last time
        /// `describe_city` really ran for this repo, never advanced just
        /// because a cached summary was reused verbatim (see
        /// `resolve_island`/`known_status_from_cached`).
        ///
        /// This exists because freshness here is keyed on the repo's last
        /// COMMIT epoch (`world::repo::GitProbe::last_commit_epoch`), which
        /// deliberately ignores uncommitted work (see that function's own
        /// doc comment) — correct for a sort key, but it means a repo with
        /// hours of staged-but-uncommitted changes reuses its old summary
        /// indefinitely: the commit epoch never moves, so `resolve_island`
        /// never sees a reason to rebuild. Rather than pretend that
        /// re-measurement is happening when it silently isn't, this field
        /// discloses exactly when the number the player is looking at was
        /// actually true, so a caller (or the frontend) can show "measured
        /// 40 minutes ago" instead of presenting a possibly-stale count as
        /// current. `None` only for a summary persisted before this field
        /// existed (`#[serde(default)]` on `CachedSummary::measured_at`).
        measured_at: Option<i64>,
    },
    /// This repository's city could not be honestly measured — currently,
    /// only because its root no longer exists on disk. The frontend must
    /// render this VISIBLY as unknown (e.g. fog, a question mark) rather
    /// than as a to-scale landmass: its plot's size is a stability
    /// placeholder, not a measurement (see `resolve_island`).
    Unknown { reason: String },
}

/// One island: a real repository, its resolved position in the sea, and
/// enough about its city to draw a plausible landmass without ever loading
/// the full `CityModel` (see `CityStatus`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IslandView {
    /// Canonical repository root (`world::repo::normalize_path`) — the same
    /// identity `Island.root`/`Island.id` already use elsewhere in this
    /// codebase, so the frontend can join this against `WorldState` (for
    /// attention/agent data this command deliberately does not duplicate)
    /// by exact string equality.
    pub root: String,
    pub name: String,
    pub plot: IslandPlot,
    pub city: CityStatus,
    /// The Unix timestamp (seconds) of this repo's most recent commit, per
    /// `world::repo::GitProbe::last_commit_epoch` — `None` when genuinely
    /// unknown, mirroring `Island.last_changed_at`'s own honesty contract:
    /// never a fabricated stand-in.
    pub last_changed_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Archipelago {
    pub islands: Vec<IslandView>,
}

// ---------------------------------------------------------------------
// Sizing and spacing
// ---------------------------------------------------------------------

/// Grid units of open water reserved around EVERY island's landmass, on
/// every side — baked into the plot's own extent (`plan_reserved`), the
/// same way `city::layout::MARGIN` is baked into a district's plot around
/// its buildings. Two plots packed edge-to-edge by `allocate_free_plot`
/// therefore still leave `2 * SEA_MARGIN` grid units of real sea between
/// the two LANDS drawn inside them, which is what makes them read as
/// islands rather than a packed tile floor. **This is the minimum sea gap
/// this module guarantees between any two islands' landmasses: `2 *
/// SEA_MARGIN` = 20 grid units**, whether the two plots ended up
/// edge-to-edge (the tightest case `allocate_free_plot`/`SpatialIndex`
/// allow) or farther apart (the common case on the golden-angle spiral).
///
/// Chosen against the author's own real repositories (see the fix report):
/// their `CityLayout` extents range 18-101 grid units wide, so `10` reads
/// as a real strait at every one of those scales without dwarfing the
/// smallest.
const SEA_MARGIN: u32 = 10;

/// Floor on an island's LAND footprint, in grid units, so a near-empty
/// repository still reads as a visible island rather than a speck — the
/// same reasoning `city::layout` doesn't need (a district's own building
/// count already gives it a sane minimum plot), applied here because a
/// repository's `CityLayout` extent for a handful of files can be as small
/// as single digits.
const MIN_ISLAND_LAND: u32 = 6;

/// The land size given to a brand-new `Unknown` island — one that has never
/// once been measured, so there is no prior plot to preserve. This is a
/// STABILITY placeholder, not a measurement: `CityStatus::Unknown` is what
/// tells the frontend not to trust it as one (see the module doc's honesty
/// section). Deliberately equal to `MIN_ISLAND_LAND` rather than some other
/// value — an unknown island should occupy the smallest honest footprint,
/// not one sized to look like real content.
const UNKNOWN_ISLAND_LAND: u32 = MIN_ISLAND_LAND;

/// The full reserved plot size for a landmass of `land_w` x `land_d`:
/// `SEA_MARGIN` cells of open water on the near side, the land itself, then
/// `SEA_MARGIN` more on the far side — the same "margin then content then
/// margin" shape `city::layout::footprint_extent` uses for a district's
/// plot around its buildings, just with a fixed margin instead of one that
/// scales with a building count.
fn plan_reserved(land_w: u32, land_d: u32) -> (u32, u32) {
    (land_w.max(MIN_ISLAND_LAND) + 2 * SEA_MARGIN, land_d.max(MIN_ISLAND_LAND) + 2 * SEA_MARGIN)
}

/// The inverse of `plan_reserved`, for recovering a previously-cached
/// plot's land size (used only when an `Unknown` island has a prior plot to
/// preserve — see `resolve_island`).
fn land_of_reserved(plot: &IslandPlot) -> (u32, u32) {
    (plot.w.saturating_sub(2 * SEA_MARGIN), plot.d.saturating_sub(2 * SEA_MARGIN))
}

// ---------------------------------------------------------------------
// Persisted cache — `~/.age-of-agents/archipelago.json`
// ---------------------------------------------------------------------

/// Bumped whenever this cache's on-disk shape changes incompatibly, or a
/// change elsewhere means an existing cache no longer honestly describes
/// the sea — the exact same discipline `city::layout::LAYOUT_CACHE_VERSION`
/// enforces, for the exact same reason: a file written by a different
/// version is discarded rather than risked as a silently misinterpreted
/// layout.
///
/// Bumped 1 -> 2 for the shelf-packing -> golden-angle-spiral switch (see
/// the module doc's "a sea reads as a sea" note): `Frontier`'s fields
/// changed shape, and every existing plot was placed by an algorithm this
/// version no longer runs, so an old file's coordinates would mean nothing
/// under the new one. Discarding it means every island moves once, from a
/// diagonal packed strip to its new spiral slot — the intended, unavoidable
/// effect of this fix, not a bug.
const ARCHIPELAGO_CACHE_VERSION: u32 = 2;

/// The golden-angle spiral's placement state for the sea — chosen once from
/// the first non-empty layout and held fixed forever after, the same
/// "frozen at first use" contract `city::layout::Frontier`'s own fields
/// keep for a district frontier (see that type's doc comment), just with
/// only two fields instead of a shelf's five: a spiral needs no row
/// bookkeeping.
///
/// - `next_slot`: the next never-yet-used position in the golden-angle
///   sequence (see `spiral_center`) — only ever grows. A root's OWN slot
///   number is deliberately NOT stored anywhere: once `allocate_free_plot`
///   resolves a slot to concrete `x`/`z`, that coordinate pair (in
///   `cache.plots`) IS the root's position from then on, so a later change
///   to the spiral's math (a different `unit`, a different angle) can never
///   retroactively move an island that already has a plot.
/// - `unit`: the spiral's radial scale in grid units per `√slot` — see
///   `spiral_unit_for`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Frontier {
    next_slot: u32,
    unit: f64,
}

/// A repository's last-measured city, persisted so `resolve_island` can
/// skip `build_city` entirely when `last_changed_at` is unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CachedSummary {
    /// The repo's last-commit epoch AT THE TIME this summary was measured.
    /// `None` is never treated as a match against a fresh `None` (see
    /// `resolve_island`) — it is stored anyway, honestly, rather than
    /// omitted, so a corrupted-cache plausibility check has a real value to
    /// inspect.
    last_changed_at: Option<i64>,
    district_count: usize,
    building_count: usize,
    width: u32,
    depth: u32,
    source: SourceKind,
    /// See `CityStatus::Known::measured_at` — carried verbatim into that
    /// field whenever this summary is reused (`known_status_from_cached`).
    /// `#[serde(default)]` so a cache file written before this field
    /// existed still loads (as `None`, honestly disclosing "we don't know
    /// when this was measured" rather than failing `LayoutCache`-style
    /// plausibility checks or refusing to parse).
    #[serde(default)]
    measured_at: Option<i64>,
}

/// Persisted archipelago memory: every repository's reserved plot (never
/// evicted — an absent repository just leaves its plot as an honest hole, a
/// same-path repository reclaims exactly on return, identical to
/// `LayoutCache.plots`'s contract for districts) and every repository's
/// last real measurement (evicted only by being overwritten with a fresher
/// one — there is no per-repository "release immediately" concept here the
/// way `LayoutCache.cells` has for a deleted FILE, because a repository
/// that stops appearing should keep its last honest measurement rather than
/// having it vanish out from under a plot that is still reserved for it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct ArchipelagoCache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    plots: BTreeMap<String, IslandPlot>,
    #[serde(default)]
    summaries: BTreeMap<String, CachedSummary>,
    #[serde(default)]
    frontier: Frontier,
    /// Unix timestamp (seconds) `build_archipelago_for_roots` last finished
    /// computing this cache — `None` for a cache written before this field
    /// existed, or degraded from a corrupt one, either of which honestly
    /// means "not recently computed" (see `REVALIDATION_SKIP_WINDOW`).
    /// Absent from `plot_is_plausible`/`frontier_is_plausible`'s style of
    /// check on purpose: an implausible value (clock skew, a hand-edited
    /// file) only ever makes the skip-revalidation window's `then <= now`
    /// guard (see `build_archipelago_for_roots`) fail closed into a full
    /// revalidation, never trust a bogus "just computed" claim — there is no
    /// unsafe direction for this field to be wrong in.
    #[serde(default)]
    computed_at: Option<u64>,
}

/// Same generous-but-finite bounds `city::layout` uses to reject a
/// hand-edited or corrupted cache file outright rather than trust its
/// numbers into arithmetic — see `city::layout::MAX_PLAUSIBLE_PLOT_EXTENT`/
/// `MAX_PLAUSIBLE_MAGNITUDE` for the identical reasoning. Not shared code
/// (that module's constants are private) but deliberately the same values.
const MAX_PLAUSIBLE_PLOT_EXTENT: i64 = 100_000;
const MAX_PLAUSIBLE_MAGNITUDE: i64 = 100_000_000;

fn plot_is_plausible(plot: &IslandPlot) -> bool {
    plot.w >= 1
        && plot.d >= 1
        && (plot.w as i64) <= MAX_PLAUSIBLE_PLOT_EXTENT
        && (plot.d as i64) <= MAX_PLAUSIBLE_PLOT_EXTENT
        && (plot.x as i64).abs() <= MAX_PLAUSIBLE_MAGNITUDE
        && (plot.z as i64).abs() <= MAX_PLAUSIBLE_MAGNITUDE
        && plot.x.checked_add(plot.w as i32).is_some()
        && plot.z.checked_add(plot.d as i32).is_some()
}

fn frontier_is_plausible(frontier: &Frontier) -> bool {
    (frontier.next_slot as i64) <= MAX_PLAUSIBLE_MAGNITUDE
        && frontier.unit.is_finite()
        && frontier.unit >= 0.0
        && frontier.unit <= MAX_PLAUSIBLE_MAGNITUDE as f64
}

impl ArchipelagoCache {
    /// Loads the cache at `path`. Missing, unreadable, unparseable, written
    /// by a different `ARCHIPELAGO_CACHE_VERSION`, or holding implausible
    /// geometry: all silently degrade to an empty cache (`Default`), never a
    /// panic — the identical discipline `city::layout::LayoutCache::load`
    /// and `config::Config::load` both already follow.
    fn load(path: &Path) -> ArchipelagoCache {
        let parsed = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<ArchipelagoCache>(&text).ok());
        match parsed {
            Some(cache)
                if cache.version == ARCHIPELAGO_CACHE_VERSION
                    && frontier_is_plausible(&cache.frontier)
                    && cache.plots.values().all(plot_is_plausible) =>
            {
                cache
            }
            _ => ArchipelagoCache::default(),
        }
    }

    /// Best-effort write, mirroring `LayoutCache::save`: a failure here
    /// never invalidates the archipelago this call already computed, it
    /// just won't be remembered for next time.
    ///
    /// Opus review, IMPORTANT 1: writes atomically via `cache_io::
    /// atomic_write` rather than the old plain `std::fs::write` — see that
    /// module's doc comment for why a plain write can produce a torn,
    /// unparsable file under two overlapping `build_archipelago_for_roots`
    /// calls (repacking all 152 islands from a `Default::default()`
    /// degrade). `build_archipelago_for_roots` additionally wraps its whole
    /// load-scan-pack-save cycle in `cache_io::with_cache_lock`, since
    /// atomicity alone stops corruption, not a lost update.
    fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string());
        crate::cache_io::atomic_write(path, json.as_bytes())
    }
}

fn cache_path() -> PathBuf {
    crate::config::data_path("archipelago.json")
}

// ---------------------------------------------------------------------
// Packing — pure, no disk or process I/O (mirrors `layout_with_cache`)
// ---------------------------------------------------------------------

/// One island's resolved LAND size, ready to be packed. `land_w`/`land_d`
/// are already floored at `MIN_ISLAND_LAND` by whoever built this (see
/// `resolve_island`) — `pack_with_cache` itself does no flooring, matching
/// `plan_district`/`layout_with_cache`'s own split (sizing decisions happen
/// before packing, packing only places already-sized things).
struct IslandInput {
    root: String,
    land_w: u32,
    land_d: u32,
}

/// True if `a` and `b`, as axis-aligned grid rectangles, share any cell —
/// identical to `city::layout::plots_overlap`, restated here because that
/// one is private to its module and the two operate on different `Plot`
/// types.
fn plots_overlap(a: &IslandPlot, b: &IslandPlot) -> bool {
    let disjoint = a.x + a.w as i32 <= b.x
        || b.x + b.w as i32 <= a.x
        || a.z + a.d as i32 <= b.z
        || b.z + b.d as i32 <= a.z;
    !disjoint
}

/// Bucket size for `SpatialIndex`, comfortably larger than any single
/// reserved plot this module ever produces in practice (see `SEA_MARGIN`'s
/// doc comment for the real widths this was checked against — the widest,
/// `my-site-next` at 76 grid units plus `2 * SEA_MARGIN`, is still well
/// under this), so a typical plot touches only a handful of buckets and
/// insert/query stay close to O(1) — the same role
/// `city::layout::SPATIAL_BUCKET` plays for district plots.
const SPATIAL_BUCKET: i32 = 2048;

fn bucket_span(coord: i32, extent: u32) -> (i32, i32) {
    let start = coord.div_euclid(SPATIAL_BUCKET);
    let end = (coord + extent as i32 - 1).div_euclid(SPATIAL_BUCKET);
    (start, end)
}

/// A coarse grid index over every plot placed so far in one `pack_with_
/// cache` call — the same fix-round-3 mechanism `city::layout::SpatialIndex`
/// exists for for the same reason (see that type's doc comment): a
/// district/island growing in place does not update the frontier, so a
/// brand-new sibling placed the SAME call could otherwise land exactly
/// where the grown plot now extends. Never removes an entry; see
/// `city::layout::SpatialIndex`'s doc comment for why a stale entry can
/// only ever cause a false "occupied", never a false "free".
#[derive(Default)]
struct SpatialIndex {
    buckets: std::collections::HashMap<(i32, i32), Vec<IslandPlot>>,
}

impl SpatialIndex {
    fn insert(&mut self, plot: &IslandPlot) {
        let (bx0, bx1) = bucket_span(plot.x, plot.w);
        let (bz0, bz1) = bucket_span(plot.z, plot.d);
        for bx in bx0..=bx1 {
            for bz in bz0..=bz1 {
                self.buckets.entry((bx, bz)).or_default().push(plot.clone());
            }
        }
    }

    fn overlaps_excluding(&self, candidate: &IslandPlot, exclude: Option<&IslandPlot>) -> bool {
        let (bx0, bx1) = bucket_span(candidate.x, candidate.w);
        let (bz0, bz1) = bucket_span(candidate.z, candidate.d);
        for bx in bx0..=bx1 {
            for bz in bz0..=bz1 {
                let Some(bucket) = self.buckets.get(&(bx, bz)) else { continue };
                for other in bucket {
                    if Some(other) == exclude {
                        continue;
                    }
                    if plots_overlap(candidate, other) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// The golden angle, in radians: `π · (3 − √5)`, ≈ 137.50776405003785°. The
/// one turn-fraction for which no run of consecutive integer multiples ever
/// nearly closes up into a repeating spoke or ring the way any rational (or
/// merely "nice-looking") angle eventually would — see the module doc's "a
/// sea reads as a sea" note for why that matters here.
const GOLDEN_ANGLE_RADIANS: f64 = 2.399_963_229_728_653;

/// How much extra radial room each spiral slot gets beyond the bare minimum
/// implied by the average reserved plot area (see `spiral_unit_for`).
/// Vogel's phyllotaxis model (`radius = unit · √slot`) evenly tiles the
/// plane with same-size CIRCLES at `unit = 1`; this module's plots are
/// rectangles of wildly different sizes, not uniform circles, so `1.0`
/// collides (falls through to `allocate_free_plot`'s linear fallback
/// search) often in practice. `1.25` was the smallest value that kept that
/// fallback rare across both the property test's random histories and the
/// author's real 73-repository archipelago, while still producing a tight,
/// legible cluster rather than a diffuse sprawl (see the fix report).
const SPIRAL_LOOSENESS: f64 = 1.25;

/// The golden-angle spiral's radial scale for a cold start
/// (`cache.plots.is_empty()`), frozen into `Frontier::unit` from then on —
/// the spiral's equivalent of `city::layout::allocate_free_plot`'s one-time
/// `target_row_width` choice. Sized so that, if every one of `inputs`'
/// reserved plots were an average-area circle, Vogel's `radius = unit · √n`
/// would tile the plane at roughly the right density for that average size;
/// `SPIRAL_LOOSENESS` adds slack on top for the fact that these are
/// unevenly-sized rectangles, not uniform circles.
fn spiral_unit_for(inputs: &[IslandInput]) -> f64 {
    let total_area: f64 = inputs
        .iter()
        .map(|i| {
            let (w, d) = plan_reserved(i.land_w, i.land_d);
            w as f64 * d as f64
        })
        .sum();
    let count = inputs.len().max(1) as f64;
    let avg_area = (total_area / count).max(1.0);
    (avg_area / std::f64::consts::PI).sqrt() * SPIRAL_LOOSENESS
}

/// One slot's centre point on the golden-angle spiral, in real-valued grid
/// units. Slot 0 sits at radius 0 — the exact centre of the sea, which is
/// what lets the biggest island in a fresh call (assigned slot 0 first —
/// see `pack_with_cache`'s "heart of the sea" ordering) land AT the centre
/// rather than merely near it. Radius grows with `√slot` (Vogel's model,
/// the same one a sunflower's seed head follows) so the cluster's density
/// stays even as it spreads outward in two dimensions; the angle advances
/// by the golden angle every slot so consecutive islands never line up.
fn spiral_center(slot: u32, unit: f64) -> (f64, f64) {
    let n = slot as f64;
    let radius = unit * n.sqrt();
    let angle = n * GOLDEN_ANGLE_RADIANS;
    (radius * angle.cos(), radius * angle.sin())
}

/// The reserved plot for `slot`, centred on that slot's spiral point and
/// rounded to the integer grid every other `IslandPlot` in this module uses.
fn spiral_plot(slot: u32, unit: f64, width: u32, depth: u32) -> IslandPlot {
    let (cx, cz) = spiral_center(slot, unit);
    let x = (cx - width as f64 / 2.0).round() as i32;
    let z = (cz - depth as f64 / 2.0).round() as i32;
    IslandPlot { x, z, w: width, d: depth }
}

/// Allocates a fresh `(width, depth)` plot on the golden-angle spiral,
/// advancing `frontier.next_slot` past every slot that would overlap
/// something already placed — the spiral's equivalent of
/// `city::layout::allocate_free_plot`'s row-wrap-on-collision loop. Always
/// terminates: the spiral's radius grows without bound as the slot number
/// advances, while every plot placed so far occupies a bounded region of
/// the plane, so past some finite slot number every remaining candidate
/// necessarily clears all of them. Overlap-freedom therefore holds
/// regardless of how loosely or tightly `frontier.unit` happens to be
/// tuned — see `SpatialIndex`'s doc comment for why a stale bucket entry
/// can only ever cause a false "occupied", never a false "free", which is
/// what makes this loop's collision check trustworthy in the first place.
fn allocate_free_plot(frontier: &mut Frontier, index: &SpatialIndex, width: u32, depth: u32) -> IslandPlot {
    loop {
        let slot = frontier.next_slot;
        frontier.next_slot += 1;
        let candidate = spiral_plot(slot, frontier.unit, width, depth);
        if index.overlaps_excluding(&candidate, None) {
            continue;
        }
        return candidate;
    }
}

/// The packing core: pure, no I/O, fully exercised by the property test
/// below. Mirrors `city::layout::layout_with_cache`'s reuse/grow/relocate
/// rule exactly, applied to whole-repository plots instead of district
/// plots:
///
/// 1. A root already in `cache.plots` whose cached plot still holds its
///    CURRENT requested footprint is reused exactly, unchanged — including
///    when the repository shrank (a plot never compacts down).
/// 2. If it no longer fits, try to grow in place (same top-left corner,
///    larger width/depth) — accepted only if the larger rectangle overlaps
///    nothing else.
/// 3. If growing would overlap something, that ONE root relocates to a
///    fresh plot from the frontier. Every other root — grown, reused, or an
///    innocent neighbour that merely blocked the growth — stays exactly
///    where it was.
/// 4. A root not yet in `cache.plots` is allocated a fresh plot the same
///    way a relocation is.
///
/// `cache.plots` entries for a root NOT present in `inputs` this call are
/// carried forward untouched — an honest hole a same-path root reclaims
/// exactly if it reappears, identical to `LayoutCache.plots`'s contract.
/// `cache.summaries` passes through unchanged; only `resolve_island`
/// (below) updates it, since this function has no concept of a
/// `CityStatus`.
fn pack_with_cache(inputs: &[IslandInput], cache: &ArchipelagoCache) -> (BTreeMap<String, IslandPlot>, ArchipelagoCache) {
    let mut plots = cache.plots.clone();
    let mut frontier = if cache.plots.is_empty() {
        // One-time choice, frozen forever after — see `Frontier`'s doc
        // comment.
        Frontier { next_slot: 0, unit: spiral_unit_for(inputs) }
    } else {
        cache.frontier.clone()
    };

    let mut index = SpatialIndex::default();
    for plot in cache.plots.values() {
        index.insert(plot);
    }

    let mut resolved: BTreeMap<String, IslandPlot> = BTreeMap::new();

    // Phase 1: roots with an existing cached plot — reuse, grow, or relocate.
    for input in inputs {
        let Some(cached_plot) = cache.plots.get(&input.root).cloned() else { continue };
        let (need_w, need_d) = plan_reserved(input.land_w, input.land_d);
        let plot = if cached_plot.w >= need_w && cached_plot.d >= need_d {
            cached_plot
        } else {
            let candidate = IslandPlot {
                x: cached_plot.x,
                z: cached_plot.z,
                w: cached_plot.w.max(need_w),
                d: cached_plot.d.max(need_d),
            };
            if index.overlaps_excluding(&candidate, Some(&cached_plot)) {
                allocate_free_plot(&mut frontier, &index, need_w, need_d)
            } else {
                candidate
            }
        };
        index.insert(&plot);
        plots.insert(input.root.clone(), plot.clone());
        resolved.insert(input.root.clone(), plot);
    }

    // Phase 2: brand-new roots, appended to the spiral — biggest reserved
    // footprint first, so among roots newly appointed a slot THIS call, the
    // biggest one claims the smallest slot number (closest to the spiral's
    // centre — see `spiral_center`). Scoped to only this call's new roots:
    // a root already resolved in Phase 1 keeps its exact prior position no
    // matter how big any sibling is, which is what keeps this purely
    // cosmetic rather than a threat to the stability guarantee (see the
    // module doc's "the sea has a heart" note).
    let mut new_inputs: Vec<&IslandInput> =
        inputs.iter().filter(|i| !resolved.contains_key(&i.root)).collect();
    new_inputs.sort_by(|a, b| {
        let area = |i: &&IslandInput| {
            let (w, d) = plan_reserved(i.land_w, i.land_d);
            w as u64 * d as u64
        };
        // Deterministic tie-break by root name: two equal-area roots must
        // not have their relative order depend on scan/HashMap iteration
        // order.
        area(b).cmp(&area(a)).then_with(|| a.root.cmp(&b.root))
    });
    for input in new_inputs {
        let (need_w, need_d) = plan_reserved(input.land_w, input.land_d);
        let plot = allocate_free_plot(&mut frontier, &index, need_w, need_d);
        index.insert(&plot);
        plots.insert(input.root.clone(), plot.clone());
        resolved.insert(input.root.clone(), plot);
    }

    let updated = ArchipelagoCache {
        version: ARCHIPELAGO_CACHE_VERSION,
        plots,
        summaries: cache.summaries.clone(),
        frontier,
        // `pack_with_cache` is pure packing, with no idea whether THIS call
        // is the one that just measured every root — `build_archipelago_for_
        // roots` is the one that knows that, and sets this explicitly after
        // calling this function. Carried forward here only so a caller that
        // (like the tests below) never touches it doesn't silently reset it.
        computed_at: cache.computed_at,
    };
    (resolved, updated)
}

// ---------------------------------------------------------------------
// Per-repository measurement (the only part that touches disk/git)
// ---------------------------------------------------------------------

/// Measures `root`'s city from scratch: the exact same
/// `layout_city_persisted_from_root` call `city_for` makes, so the sea's
/// reported size and the town a player lands in are provably the same
/// number — and, since this shares the SAME per-repo cache file
/// `city_for` reads and writes, both callers must resolve a directory's
/// split-slot membership (city::layout, "Fix round 6") the same way too:
/// if this one still built its model with the memory-less `build_city`, an
/// archipelago scan would periodically overwrite the persisted membership
/// `city_for` relies on with a freshly, positionally re-derived one.
///
/// Checks `root.is_dir()` FIRST — see the module doc's honesty section for
/// why: `build_city`'s own fallback degrades a missing repository into an
/// empty-looking `CityModel` that reads as a real, honestly-empty
/// repository, which is exactly the fabricated-measurement failure
/// principle 4 forbids.
fn describe_city(root: &Path) -> CityStatus {
    if !root.is_dir() {
        return CityStatus::Unknown {
            reason: "repository root no longer exists on disk".to_string(),
        };
    }
    let (model, layout) =
        layout_city_persisted_from_root(root, &RealFiles::new(Box::new(RealGitFiles::default())));
    let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();
    CityStatus::Known {
        district_count: model.districts.len(),
        building_count,
        width: layout.width,
        depth: layout.depth,
        source: model.source.into(),
        // This IS the moment of measurement — see `CityStatus::Known::
        // measured_at`'s doc comment.
        measured_at: Some(now_epoch_secs()),
    }
}

/// The current wall-clock time as Unix epoch seconds — the shared "now" used
/// both here (`CityStatus::Known::measured_at`, stamped at the moment a real
/// measurement is taken) and by `build_archipelago_for_roots` (`computed_at`,
/// stamped at the moment a whole scan finishes). A clock that cannot be read
/// (essentially never, in practice) honestly falls back to the Unix epoch
/// itself rather than panicking — the same "fail into an obviously-old,
/// never-fresh value" discipline `REVALIDATION_SKIP_WINDOW`'s own
/// `then <= now_secs` guard already relies on.
fn now_epoch_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

/// What `resolve_island` needs to size and place one root's plot, alongside
/// the `CityStatus` the frontend actually renders.
struct Resolved {
    status: CityStatus,
    last_changed_at: Option<i64>,
}

/// Resolves one root's city, reusing the cached summary when honestly still
/// fresh — see the module doc's "Cost" section.
///
/// `None` from `last_commit_epoch` (no commits yet, not a repository, the
/// git call timed out) is NEVER treated as matching a cached `None`: a
/// freshness signal this module cannot verify is treated as "always stale"
/// rather than risking a summary that silently stops tracking a repository
/// forever. The accepted cost, same shape as `city::layout`'s own documented
/// trade-offs: a repository whose `last_commit_epoch` is persistently `None`
/// (most plausibly a freshly-`git init`ed repo with no commits yet) is
/// rebuilt on every single call rather than cached at all. This is judged
/// rare (a real, actively-used repository has commits) and strictly
/// preferable to the alternative of quietly trusting an unverifiable "still
/// the same" forever.
fn resolve_island(root: &Path, git: &dyn GitProbe, cached: Option<&CachedSummary>) -> Resolved {
    let last_changed_at = git.last_commit_epoch(root);
    let fresh = match (cached, last_changed_at) {
        (Some(c), Some(now)) => c.last_changed_at == Some(now),
        _ => false,
    };
    let status = if fresh {
        known_status_from_cached(cached.expect("fresh implies a cached summary"))
    } else {
        describe_city(root)
    };
    Resolved { status, last_changed_at }
}

/// The `CityStatus::Known` a `CachedSummary` describes — shared by
/// `resolve_island`'s own per-root freshness check and
/// `resolve_island_from_recent_cache`'s whole-archipelago one, so there is
/// exactly one place that turns a cached summary into a `CityStatus`.
fn known_status_from_cached(c: &CachedSummary) -> CityStatus {
    CityStatus::Known {
        district_count: c.district_count,
        building_count: c.building_count,
        width: c.width,
        depth: c.depth,
        source: c.source,
        // Reusing a cached summary is NOT a new measurement — carry the
        // ORIGINAL measurement time through unchanged, never `now` (Opus
        // review, IMPORTANT 2). Pretending a reused number is fresh is
        // exactly the honesty failure `measured_at` exists to close.
        measured_at: c.measured_at,
    }
}

/// Resolves one root's city with NO `git` call at all — valid only when the
/// whole archipelago was computed within `REVALIDATION_SKIP_WINDOW` of now
/// (see that constant and `build_archipelago_for_roots`) and `cached` is a
/// real prior measurement for this exact root. Trusts `cached` (status AND
/// `last_changed_at`) verbatim: the window itself, not a fresh commit-epoch
/// probe, is what this call is staking the answer's freshness on.
///
/// Never called for a root with no cached summary — a root that has never
/// once been honestly measured must still be measured at least once
/// regardless of the window, exactly like `resolve_island`'s own "`None` is
/// never treated as fresh" rule above; `build_archipelago_for_roots` enforces
/// this by only taking this path when `cached_summary` is `Some`.
fn resolve_island_from_recent_cache(cached: &CachedSummary) -> Resolved {
    Resolved { status: known_status_from_cached(cached), last_changed_at: cached.last_changed_at }
}

// ---------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------

/// Hard ceiling on `build_archipelago_for_roots`'s per-repository resolution
/// worker count (git probe + `describe_city` where needed) — see the module
/// doc's "Parallel, but bounded" section and `worker_count_for`'s own doc
/// comment for how the ACTUAL count is chosen underneath this ceiling. A
/// many-core machine must never turn "152 sequential `git`/`build_city`
/// calls" into "152 simultaneous" ones — that trade would still be its own
/// kind of the same problem this fix exists to close (a burst of concurrent
/// subprocesses and file reads fighting the same disk). 32 was checked
/// against the author's real 152-repository tree (see
/// `archipelago-perf-report.md`): raising the cap from 16 to 32 measurably
/// helped (this work is I/O-bound — a `git` spawn and a file read both spend
/// most of their time blocked, not using a core — so some oversubscription
/// past the core count is genuinely productive here, unlike CPU-bound work);
/// raising it again to 64 did not help further, so 32 is kept as the smaller
/// number that already captures the benefit.
const MAX_CONCURRENT_REPO_WORKERS: usize = 32;

/// The worker count `build_archipelago_for_roots` actually uses: double the
/// machine's own core count (since this work is I/O-, not CPU-bound — see
/// `MAX_CONCURRENT_REPO_WORKERS`'s doc comment), capped at that constant,
/// and never more than there are roots to resolve. `available_parallelism`
/// failing (rare; a heavily sandboxed environment) falls back to `4`, the
/// same conservative default `RealGitFiles`/`RealGit` style code elsewhere
/// in this codebase uses when a system query might not be answerable.
fn worker_count_for(root_count: usize) -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_mul(2)
        .min(MAX_CONCURRENT_REPO_WORKERS)
        .min(root_count.max(1))
}

/// How long a just-computed archipelago cache is trusted without asking
/// `git` about ANY root again — see the module doc's "Cost" section. Within
/// this window, `build_archipelago_for_roots` skips the per-root commit-
/// epoch probe entirely for every root that already has a cached summary
/// (`resolve_island_from_recent_cache`), rather than spawning `git log` for
/// each one only to very likely learn nothing changed. This is what turns a
/// rapid re-fetch — the window-focus refetch `useArchipelago.ts` makes right
/// after mount, or two calls issued back-to-back in a test — from "152
/// sequential `git` spawns" into "zero `git` spawns, one cache read".
///
/// The accepted staleness: a real commit landing in any of these
/// repositories within this window will not be reflected in the sea until
/// the window elapses and a later call re-probes it — bounded, honestly
/// documented staleness, not a cache that silently stops tracking a
/// repository forever. 5 seconds is deliberately short: long enough to
/// absorb the one re-fetch pattern this module actually sees (mount, then
/// an immediate focus event or an immediate second call in a test), short
/// enough that "a few seconds behind" is the only claim being made, not
/// "stale until something else invalidates it".
const REVALIDATION_SKIP_WINDOW: Duration = Duration::from_secs(5);

/// The real entry point for a caller that already has a canonical root and
/// a display name per repository (the Tauri command below, and the
/// real-repository report test) — loads the persisted cache, resolves each
/// root's city (honestly, cheaply — see `resolve_island`), packs every
/// island into the sea, and best-effort persists the result. A failure to
/// WRITE the cache is swallowed exactly like `layout_city_persisted`'s:
/// the archipelago this call returns is correct regardless, it just won't
/// be remembered for next time.
///
/// `roots` must already be canonical (`world::repo::normalize_path`) —
/// deliberately not re-canonicalized here, for the identical reason
/// `city::layout::cache_path` doesn't re-normalize `model.root`: an
/// independent second normalization of the same path has caused real bugs
/// in this codebase whenever the two disagreed (see `world::repo`'s doc
/// comment).
///
/// **Parallel, but bounded.** Each root's resolution (`resolve_island`/
/// `resolve_island_from_recent_cache`) touches nothing another root's
/// resolution touches — `cache.summaries`/`cache.plots` are read-only until
/// every worker has finished, and `layout_city_persisted`'s own per-repo
/// disk cache is keyed by that repo's own hash, so two different roots
/// resolving at once never contend on the same file. Up to
/// `MAX_CONCURRENT_REPO_WORKERS` worker threads share one atomic
/// work-stealing index (`next_index`) into `deduped` rather than each
/// claiming a static up-front slice — repository cost is wildly uneven (see
/// the module doc's "Cost" section), so a fixed split risks one worker
/// drawing several of the expensive repos while its siblings idle; stealing
/// the next root the instant a worker is free keeps the wall-clock cost
/// close to total-work-divided-by-worker-count instead of whatever the scan
/// happened to place next to each other. All of this runs inside one
/// `std::thread::scope`, so every worker is joined (and any panic inside one
/// is propagated, never silently swallowed) before this function reads any
/// of their results — no reference here ever needs to outlive the scope, so
/// no `Arc` is needed for `git`, `cache`, or `deduped`. `roots` is
/// defensively deduped by canonical path first: discovery is expected to
/// already be duplicate-free, but a duplicate root would otherwise mean two
/// workers writing the SAME repo's `towns/<hash>.json` at once — a hazard
/// the old strictly sequential loop could never actually hit, so it is
/// closed here rather than assumed away.
pub fn build_archipelago_for_roots(roots: &[(PathBuf, String)]) -> Archipelago {
    let path = cache_path();

    let mut seen_roots: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&(PathBuf, String)> = roots
        .iter()
        .filter(|(root, _)| seen_roots.insert(root.to_string_lossy().to_string()))
        .collect();

    // Opus review, IMPORTANT 1: the WHOLE load-scan-pack-save cycle is
    // serialized on this one cache path (see `cache_io::with_cache_lock`'s
    // doc comment) — not just the final `save`. Two overlapping calls (the
    // frontend fires `get_archipelago` on mount AND on every window focus,
    // with no in-flight guard, and Tauri runs commands concurrently) would
    // otherwise each load the same starting cache, scan independently, and
    // the second `save` would silently discard the first's update — a lost
    // update that atomicity alone does not prevent. Only calls racing on
    // THIS SAME path ever wait; nothing here blocks unrelated work.
    let (resolved_plots, mut resolved_by_root) = crate::cache_io::with_cache_lock(&path, || {
        let cache = ArchipelagoCache::load(&path);
        let git = RealGit::default();

        let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        // See `REVALIDATION_SKIP_WINDOW`'s doc comment. `then <= now_secs` also
        // guards against a corrupted/hand-edited `computed_at` claiming a time in
        // the future: that can only ever make this `false` (fail closed into a
        // full revalidation), never wrongly `true`.
        let skip_revalidation = cache
            .computed_at
            .map(|then| then <= now_secs && now_secs - then < REVALIDATION_SKIP_WINDOW.as_secs())
            .unwrap_or(false);

        let worker_count = worker_count_for(deduped.len());

        type ResolvedRoot = (String, Resolved, String, u32, u32);
        let mut all_resolved: Vec<ResolvedRoot> = Vec::with_capacity(deduped.len());
        // Work-stealing via a shared index rather than static up-front chunks:
        // repository cost is wildly uneven (a near-empty repo's `resolve_island`
        // is a single fast `git log`; `my-site-next`'s cold `build_city` walk
        // alone measured ~0.24s — see the module doc's "Cost" section), so
        // splitting `deduped` into N contiguous slices up front risks one worker
        // drawing several of the expensive repos while its siblings finish early
        // and sit idle — the whole call is only as fast as its slowest worker.
        // `next_index` lets every worker keep pulling the next unclaimed root
        // the instant it finishes its current one, so the wall-clock cost tracks
        // the actual total work divided by `worker_count`, not whatever the
        // scan happened to place next to each other.
        let next_index = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let mut handles = Vec::with_capacity(worker_count);
            for _ in 0..worker_count {
                let git = &git;
                let cache = &cache;
                let deduped = &deduped;
                let next_index = &next_index;
                handles.push(scope.spawn(move || {
                    let mut local: Vec<ResolvedRoot> = Vec::new();
                    loop {
                        let i = next_index.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((root, name)) = deduped.get(i) else { break };
                        let key = root.to_string_lossy().to_string();
                        let cached_summary = cache.summaries.get(&key);
                        let resolved = match (skip_revalidation, cached_summary) {
                            (true, Some(c)) => resolve_island_from_recent_cache(c),
                            _ => resolve_island(root, git, cached_summary),
                        };

                        let (land_w, land_d) = match &resolved.status {
                            CityStatus::Known { width, depth, .. } => (*width, *depth),
                            CityStatus::Unknown { .. } => {
                                // Preserve a prior real plot's land size rather
                                // than shrinking a previously-known island down
                                // to the unknown placeholder just because this
                                // one call couldn't measure it — a transient
                                // failure must not visibly move or resize an
                                // island the player already recognises. Only a
                                // root that has NEVER been measured gets the
                                // placeholder.
                                cache
                                    .plots
                                    .get(&key)
                                    .map(land_of_reserved)
                                    .unwrap_or((UNKNOWN_ISLAND_LAND, UNKNOWN_ISLAND_LAND))
                            }
                        };

                        local.push((key, resolved, name.clone(), land_w, land_d));
                    }
                    local
                }));
            }
            for handle in handles {
                all_resolved.extend(
                    handle.join().expect("an archipelago repo-resolution worker thread panicked"),
                );
            }
        });

        let mut inputs = Vec::with_capacity(all_resolved.len());
        let mut resolved_by_root: BTreeMap<String, (Resolved, String)> = BTreeMap::new();
        for (key, resolved, name, land_w, land_d) in all_resolved {
            inputs.push(IslandInput { root: key.clone(), land_w, land_d });
            resolved_by_root.insert(key, (resolved, name));
        }

        let (resolved_plots, mut updated_cache) = pack_with_cache(&inputs, &cache);
        // Opus review, IMPORTANT 3: `computed_at` must only advance when
        // this call actually revalidated something. Advancing it
        // unconditionally (the old bug) let a call that skipped ALL
        // revalidation — `skip_revalidation` true, zero `git` processes run
        // — still renew the trust window, so two focus events a few
        // seconds apart could keep `REVALIDATION_SKIP_WINDOW` perpetually
        // alive: call 2 serves entirely from cache AND stamps `computed_at`
        // to its own `now`, so call 3 is still "within" the window.
        // `next_computed_at` is the extracted, directly-unit-tested rule.
        updated_cache.computed_at = next_computed_at(skip_revalidation, cache.computed_at, now_secs);

        // Summaries are updated ONLY for a root this call actually measured as
        // `Known` — an `Unknown` result leaves whatever was cached (if
        // anything) untouched, so a transient failure never overwrites the last
        // real measurement with nothing. Never evicted for a root outside this
        // call's `roots` either (same "append-only, never compact" contract as
        // `plots`).
        for (key, (resolved, _name)) in &resolved_by_root {
            if let CityStatus::Known { district_count, building_count, width, depth, source, measured_at } =
                &resolved.status
            {
                updated_cache.summaries.insert(
                    key.clone(),
                    CachedSummary {
                        last_changed_at: resolved.last_changed_at,
                        district_count: *district_count,
                        building_count: *building_count,
                        width: *width,
                        depth: *depth,
                        source: *source,
                        measured_at: *measured_at,
                    },
                );
            }
        }

        let _ = updated_cache.save(&path);

        (resolved_plots, resolved_by_root)
    });

    let mut islands: Vec<IslandView> = resolved_plots
        .into_iter()
        .map(|(root, plot)| {
            let (resolved, name) =
                resolved_by_root.remove(&root).expect("every packed root was resolved above");
            IslandView { root, name, plot, city: resolved.status, last_changed_at: resolved.last_changed_at }
        })
        .collect();
    islands.sort_by(|a, b| a.name.cmp(&b.name));

    Archipelago { islands }
}

/// Opus review, IMPORTANT 3: `computed_at` only advances when `!skip_
/// revalidation` — i.e. this call actually asked `git` about at least one
/// root. A fully-skipped call (every root served from
/// `resolve_island_from_recent_cache`, zero `git` processes run) must keep
/// the PREVIOUS stamp, not renew it — otherwise `REVALIDATION_SKIP_WINDOW`'s
/// promised bound on staleness never actually binds anything: two calls a
/// few seconds apart would keep re-stamping "just computed" forever.
/// Extracted as its own pure function so this rule is directly testable
/// without touching `cache_path()`'s real, non-injectable path.
fn next_computed_at(skip_revalidation: bool, previous: Option<u64>, now_secs: u64) -> Option<u64> {
    if skip_revalidation {
        previous
    } else {
        Some(now_secs)
    }
}

/// Discovers every repository under the user's project roots — the same
/// discovery `commands::list_unsettled` uses (`world::unsettled`'s
/// `candidate_roots`/`scan_roots`/`scanned_repos`), which already returns
/// EVERY scanned repo, settled and unsettled alike (see that module's own
/// doc comment) — and builds the archipelago from it.
///
/// Deliberately does not consult `WorldState` for WHICH repositories exist:
/// that is a filesystem/git fact, independent of which of them currently
/// have a live Herdr agent pane. "Needs attention" is layered on top by the
/// frontend, joining this by `root` against the `WorldState` it already
/// holds, the same way `founding.ts`'s `subtractSettled` already joins
/// `list_unsettled`'s output against the live world instead of Rust trying
/// to answer a question only the frontend's already-current world can
/// answer honestly.
///
/// `settled_roots` IS taken from `WorldState`, though, and that is not a
/// contradiction of the paragraph above: `world::unsettled::candidate_roots`
/// only ever uses it as a HINT about which directories to scan (the parent
/// of a repo the user demonstrably already works in), never to decide which
/// repositories exist or are already settled. Before this fix this function
/// was the one caller in the codebase passing `&[]` here instead of the real
/// set `list_unsettled`/`repo_history` use — an unprincipled inconsistency
/// between three call sites answering variations of the same "what should we
/// scan" question, and part of what let IMPORTANT 4's un-discoverable
/// project happen silently: a project founded outside every conventional
/// directory and outside every ALREADY-SETTLED repo's parent never got
/// offered as a candidate root here, even though the exact same project
/// would have been in scope for `list_unsettled`'s scan the moment its
/// workspace existed.
pub fn build_archipelago(
    config: &crate::config::Config,
    home: PathBuf,
    settled_roots: &[String],
) -> Archipelago {
    let roots = crate::world::unsettled::discovery_plan(config, &home, settled_roots);
    let scanned = crate::world::unsettled::scan_roots(&roots);
    let repos = crate::world::unsettled::scanned_repos(&scanned);
    let inputs: Vec<(PathBuf, String)> =
        repos.into_iter().map(|r| (PathBuf::from(r.path), r.name)).collect();
    build_archipelago_for_roots(&inputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::repo::normalize_path;

    // ---- describe_city / honesty ----

    #[test]
    fn a_root_that_does_not_exist_is_reported_as_unknown_not_a_fabricated_empty_city() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("never-existed");
        match describe_city(&missing) {
            CityStatus::Unknown { reason } => {
                assert!(reason.contains("no longer exists"), "got: {reason}");
            }
            CityStatus::Known { .. } => {
                panic!("a missing repository root must never be reported as a real measurement")
            }
        }
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|e| panic!("failed to spawn git {args:?} in {cwd:?}: {e}"));
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    fn init_repo(dir: &Path, files: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        run_git(dir, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test User"]);
        for (name, contents) in files {
            let full = dir.join(name);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, contents).unwrap();
        }
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn a_real_repository_is_measured_as_known_with_a_real_district_and_building_count() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo, &[("src/a.rs", "fn main() {}\n"), ("src/b.rs", "fn b() {}\n")]);

        match describe_city(&repo) {
            CityStatus::Known { district_count, building_count, width, depth, .. } => {
                assert_eq!(district_count, 1, "one directory (src) -> one district");
                assert_eq!(building_count, 2);
                assert!(width >= 1 && depth >= 1);
            }
            CityStatus::Unknown { reason } => panic!("a real repository must be Known, got: {reason}"),
        }
    }

    /// Opus review, IMPORTANT 2: `describe_city` is the one place a real
    /// measurement happens, so it must be the one place `measured_at` gets
    /// stamped with the actual wall-clock time — never left `None`, never
    /// backdated to something else.
    #[test]
    fn describe_city_records_when_it_actually_measured_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo, &[("a.rs", "fn a() {}\n")]);

        let before = now_epoch_secs();
        match describe_city(&repo) {
            CityStatus::Known { measured_at, .. } => {
                let after = now_epoch_secs();
                let measured = measured_at.expect("a real measurement must record when it happened");
                assert!(
                    measured >= before && measured <= after,
                    "measured_at ({measured}) must fall within [{before}, {after}]"
                );
            }
            CityStatus::Unknown { reason } => panic!("a real repository must be Known, got: {reason}"),
        }
    }

    // ---- resolve_island caching ----

    struct FakeGit(Option<i64>);
    impl GitProbe for FakeGit {
        fn toplevel(&self, _cwd: &Path) -> Option<PathBuf> {
            None
        }
        fn common_dir(&self, _cwd: &Path) -> Option<PathBuf> {
            None
        }
        fn last_commit_epoch(&self, _root: &Path) -> Option<i64> {
            self.0
        }
    }

    fn known_summary(epoch: Option<i64>) -> CachedSummary {
        CachedSummary {
            last_changed_at: epoch,
            district_count: 3,
            building_count: 30,
            width: 20,
            depth: 20,
            source: SourceKind::Git,
            measured_at: Some(999),
        }
    }

    #[test]
    fn a_cached_summary_is_reused_verbatim_when_the_last_commit_epoch_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        // A REAL repo whose actual measurement would be very different
        // (0 districts, 0 buildings) from the cached one, so reuse vs.
        // rebuild is unambiguous from the result.
        std::fs::create_dir_all(&repo).unwrap();

        let git = FakeGit(Some(42));
        let cached = known_summary(Some(42));
        let resolved = resolve_island(&repo, &git, Some(&cached));

        assert_eq!(resolved.last_changed_at, Some(42));
        match resolved.status {
            CityStatus::Known { district_count, building_count, .. } => {
                assert_eq!(district_count, 3, "must reuse the CACHED value, not rebuild");
                assert_eq!(building_count, 30);
            }
            CityStatus::Unknown { .. } => panic!("expected the cached Known summary to be reused"),
        }
    }

    /// Opus review, IMPORTANT 2: reusing a cached summary is NOT a new
    /// measurement. `known_summary` stamps `measured_at: Some(999)` — if
    /// `resolve_island`'s cache-hit path pretended that reuse was a fresh
    /// measurement (stamping `now` instead of carrying the original value
    /// through), a caller would have no way to tell "measured moments ago"
    /// apart from "measured whenever this cache was written and never
    /// touched since", which is exactly the dishonesty this field exists to
    /// prevent.
    #[test]
    fn reusing_a_cached_summary_preserves_its_original_measured_at_rather_than_claiming_freshness() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();

        let git = FakeGit(Some(42));
        let cached = known_summary(Some(42));
        let resolved = resolve_island(&repo, &git, Some(&cached));

        match resolved.status {
            CityStatus::Known { measured_at, .. } => {
                assert_eq!(
                    measured_at,
                    Some(999),
                    "reusing a cached summary must carry its ORIGINAL measured_at through, never `now`"
                );
            }
            CityStatus::Unknown { .. } => panic!("expected the cached Known summary to be reused"),
        }
    }

    #[test]
    fn a_changed_last_commit_epoch_forces_a_rebuild_rather_than_trusting_the_stale_cache() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo, &[("a.rs", "fn a() {}\n")]);

        let git = FakeGit(Some(99));
        // Cached under a DIFFERENT epoch -> must not be trusted.
        let cached = known_summary(Some(1));
        let resolved = resolve_island(&repo, &git, Some(&cached));

        match resolved.status {
            CityStatus::Known { district_count, building_count, .. } => {
                // The repo's real content: one root-level file, one district.
                assert_eq!(district_count, 1);
                assert_eq!(building_count, 1);
            }
            CityStatus::Unknown { reason } => panic!("expected a real rebuild, got: {reason}"),
        }
    }

    #[test]
    fn an_unknown_last_commit_epoch_is_never_treated_as_matching_a_cached_unknown_one() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo, &[("a.rs", "fn a() {}\n")]);

        let git = FakeGit(None);
        let cached = known_summary(None);
        let resolved = resolve_island(&repo, &git, Some(&cached));

        // Must rebuild (real content: 1 district, 1 building), not reuse
        // the cached (3, 30) — an unverifiable freshness signal must never
        // be trusted as "unchanged".
        match resolved.status {
            CityStatus::Known { district_count, building_count, .. } => {
                assert_eq!(district_count, 1);
                assert_eq!(building_count, 1);
            }
            CityStatus::Unknown { reason } => panic!("expected a real rebuild, got: {reason}"),
        }
    }

    // ---- pack_with_cache: concrete examples ----

    fn input(root: &str, size: u32) -> IslandInput {
        IslandInput { root: root.to_string(), land_w: size, land_d: size }
    }

    fn assert_no_overlaps(plots: &BTreeMap<String, IslandPlot>) {
        let values: Vec<&IslandPlot> = plots.values().collect();
        for (i, a) in values.iter().enumerate() {
            for b in values.iter().skip(i + 1) {
                assert!(!plots_overlap(a, b), "plots overlap: {:?} vs {:?}", a, b);
            }
        }
    }

    #[test]
    fn a_bigger_repository_gets_a_bigger_island() {
        let inputs = vec![input("/p/small", 10), input("/p/big", 80)];
        let (resolved, _cache) = pack_with_cache(&inputs, &ArchipelagoCache::default());
        let small = &resolved["/p/small"];
        let big = &resolved["/p/big"];
        assert!(big.w > small.w && big.d > small.d);
        // The margin is baked in identically for both.
        assert_eq!(small.w, 10 + 2 * SEA_MARGIN);
        assert_eq!(big.w, 80 + 2 * SEA_MARGIN);
    }

    #[test]
    fn islands_never_overlap_for_several_repositories_at_once() {
        let inputs =
            vec![input("/p/a", 12), input("/p/b", 40), input("/p/c", 8), input("/p/d", 60)];
        let (resolved, _cache) = pack_with_cache(&inputs, &ArchipelagoCache::default());
        assert_eq!(resolved.len(), 4);
        assert_no_overlaps(&resolved);
    }

    #[test]
    fn a_disappearing_island_leaves_its_plot_reserved_and_a_returning_one_reclaims_it_exactly() {
        let first_call = vec![input("/p/a", 10), input("/p/b", 10)];
        let (first, cache) = pack_with_cache(&first_call, &ArchipelagoCache::default());
        let original_a = first["/p/a"].clone();

        // /p/a disappears (repo not scanned this call).
        let second_call = vec![input("/p/b", 10)];
        let (second, cache) = pack_with_cache(&second_call, &cache);
        assert!(!second.contains_key("/p/a"), "a disappeared island is not in the resolved set");
        assert_eq!(
            cache.plots.get("/p/a"),
            Some(&original_a),
            "a disappeared island's plot must still be reserved in the cache"
        );

        // /p/a returns with the SAME size -> reclaims the exact same plot.
        let third_call = vec![input("/p/a", 10), input("/p/b", 10)];
        let (third, _cache) = pack_with_cache(&third_call, &cache);
        assert_eq!(third["/p/a"], original_a, "a returning island must reclaim its exact plot");
    }

    #[test]
    fn a_shrinking_island_does_not_compact_its_plot() {
        let (first, cache) = pack_with_cache(&[input("/p/a", 80)], &ArchipelagoCache::default());
        let big_plot = first["/p/a"].clone();

        let (second, _cache) = pack_with_cache(&[input("/p/a", 5)], &cache);
        assert_eq!(second["/p/a"], big_plot, "shrinking must not compact the plot");
    }

    #[test]
    fn a_growing_island_extends_in_place_when_nothing_blocks_it() {
        let (first, cache) = pack_with_cache(&[input("/p/a", 10)], &ArchipelagoCache::default());
        let original = first["/p/a"].clone();

        let (second, _cache) = pack_with_cache(&[input("/p/a", 50)], &cache);
        let grown = &second["/p/a"];
        assert_eq!(grown.x, original.x, "growth keeps the same top-left corner");
        assert_eq!(grown.z, original.z);
        assert!(grown.w > original.w && grown.d > original.d);
    }

    #[test]
    fn a_growing_island_relocates_rather_than_overlap_a_blocking_neighbour() {
        // Two adjacent islands, then grow the first one far enough that
        // in-place growth would overlap the second.
        let (_first, cache) =
            pack_with_cache(&[input("/p/a", 10), input("/p/b", 10)], &ArchipelagoCache::default());

        let (second, _cache) = pack_with_cache(&[input("/p/a", 500), input("/p/b", 10)], &cache);
        assert_no_overlaps(&second);
        // /p/b must not have moved just because /p/a grew.
        assert_eq!(second["/p/b"], cache.plots["/p/b"]);
    }

    // ---- cache load/save robustness ----

    #[test]
    fn a_missing_cache_file_loads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ArchipelagoCache::load(&dir.path().join("nope.json"));
        assert!(cache.plots.is_empty());
    }

    #[test]
    fn a_cache_written_by_a_different_version_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archipelago.json");
        let mut stale =
            ArchipelagoCache { version: ARCHIPELAGO_CACHE_VERSION + 1, ..Default::default() };
        stale.plots.insert("/p/a".to_string(), IslandPlot { x: 0, z: 0, w: 20, d: 20 });
        stale.save(&path).unwrap();

        let loaded = ArchipelagoCache::load(&path);
        assert!(loaded.plots.is_empty(), "a foreign-version cache must be discarded wholesale");
    }

    #[test]
    fn a_cache_round_trips_through_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archipelago.json");
        let mut cache = ArchipelagoCache { version: ARCHIPELAGO_CACHE_VERSION, ..Default::default() };
        cache.plots.insert("/p/a".to_string(), IslandPlot { x: 3, z: 7, w: 30, d: 40 });
        cache.summaries.insert(
            "/p/a".to_string(),
            CachedSummary {
                last_changed_at: Some(123),
                district_count: 2,
                building_count: 9,
                width: 12,
                depth: 8,
                source: SourceKind::Git,
                measured_at: Some(100),
            },
        );
        cache.save(&path).unwrap();

        let loaded = ArchipelagoCache::load(&path);
        assert_eq!(loaded, cache);
    }

    #[test]
    fn an_implausible_plot_in_an_otherwise_valid_cache_file_is_discarded_wholesale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archipelago.json");
        std::fs::write(
            &path,
            format!(
                r#"{{"version":{ARCHIPELAGO_CACHE_VERSION},"plots":{{"/p/a":{{"x":0,"z":0,"w":0,"d":5}}}},"summaries":{{}},"frontier":{{"next_slot":0,"unit":10.0}}}}"#
            ),
        )
        .unwrap();
        let loaded = ArchipelagoCache::load(&path);
        assert!(loaded.plots.is_empty(), "a plot with w=0 is implausible and must be rejected");
    }

    /// Opus review, IMPORTANT 1: the same torn-write hazard as `city::
    /// layout`'s identical test, for `ArchipelagoCache::save` — a plain
    /// `std::fs::write` truncates then writes as two separate steps, so two
    /// overlapping writers to the SAME `archipelago.json` (the concrete
    /// case: the frontend's mount + window-focus refetches, with no
    /// in-flight guard, hitting Tauri's concurrent command dispatch) can
    /// leave a file that is neither writer's content and often isn't valid
    /// JSON — which `ArchipelagoCache::load` then honestly degrades to
    /// `Default::default()`, repacking every island in the sea. Red against
    /// plain `fs::write`; green once `save()` writes atomically.
    #[test]
    fn concurrent_saves_of_the_archipelago_cache_never_produce_a_torn_unparsable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archipelago.json");

        let mut big = ArchipelagoCache { version: ARCHIPELAGO_CACHE_VERSION, ..Default::default() };
        for i in 0..6000 {
            big.plots.insert(format!("/p/repo{i}"), IslandPlot { x: i, z: i, w: 20, d: 20 });
        }
        let mut small = big.clone();
        for i in 0..2000 {
            small.plots.remove(&format!("/p/repo{i}"));
        }
        let big_json = serde_json::to_string_pretty(&big).unwrap();
        let small_json = serde_json::to_string_pretty(&small).unwrap();
        assert!(big_json.len() > 200_000, "the race needs a payload big enough to matter");

        let stop = std::sync::atomic::AtomicBool::new(false);
        let start = std::sync::Barrier::new(3);
        let torn: std::sync::Mutex<Option<usize>> = std::sync::Mutex::new(None);
        std::thread::scope(|scope| {
            for json in [&big_json, &small_json] {
                let path = &path;
                let stop = &stop;
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    while !stop.load(std::sync::atomic::Ordering::Relaxed)
                        && std::time::Instant::now() < deadline
                    {
                        // The exact I/O primitive `ArchipelagoCache::save`
                        // now uses — was `std::fs::write` before the fix,
                        // which is what made this test red.
                        let _ = crate::cache_io::atomic_write(path, json.as_bytes());
                    }
                });
            }

            let path = &path;
            let stop = &stop;
            let start = &start;
            let torn = &torn;
            scope.spawn(move || {
                start.wait();
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
                while std::time::Instant::now() < deadline {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        if !text.is_empty() && serde_json::from_str::<ArchipelagoCache>(&text).is_err() {
                            *torn.lock().unwrap() = Some(text.len());
                            break;
                        }
                    }
                }
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            });
        });

        let found = *torn.lock().unwrap();
        if let Some(len) = found {
            panic!("a reader observed a torn (unparsable) archipelago cache file: {len} bytes");
        }
    }

    // ---- computed_at / revalidation window (IMPORTANT 3) ----

    #[test]
    fn computed_at_only_advances_when_revalidation_actually_happened() {
        // A real revalidation (skip_revalidation == false) always stamps
        // the fresh `now`, whether or not there was a previous stamp.
        assert_eq!(next_computed_at(false, Some(100), 200), Some(200));
        assert_eq!(next_computed_at(false, None, 200), Some(200));

        // Opus review, IMPORTANT 3: a call that skipped ALL revalidation —
        // zero `git` processes run, everything served from `resolve_
        // island_from_recent_cache` — must NOT renew the trust window. The
        // old bug stamped `now` here too, so two focus events a few seconds
        // apart kept `REVALIDATION_SKIP_WINDOW` perpetually alive: call 2
        // serves entirely from cache AND stamps its own `now`, so call 3 at
        // +8s (comfortably outside the intended 5s window from call 1) was
        // still "within" it.
        assert_eq!(
            next_computed_at(true, Some(100), 104),
            Some(100),
            "a fully-skipped call must preserve the OLD stamp, never renew it"
        );

        // A skipped call with no previous stamp at all (should not really
        // happen — `skip_revalidation` requires a prior `computed_at` — but
        // covered here for completeness) has nothing honest to preserve.
        assert_eq!(next_computed_at(true, None, 104), None);
    }

    // Deliberately no non-ignored test exercises `build_archipelago_for_
    // roots`/`build_archipelago` end-to-end: both persist to the REAL
    // `~/.age-of-agents/archipelago.json` (via `cache_path`, which is not
    // injectable — the same design `city::layout::cache_path` already
    // uses, for the same reason given there: an independent second
    // canonicalization/parameterization of the same path has caused real
    // bugs in this codebase before). `city::layout` follows the identical
    // convention: every one of its non-ignored tests drives the pure,
    // cache-injected `layout_city`/`layout_with_cache`, and ONLY its
    // explicit `#[ignore]`d `real_repos_layout_check` touches the
    // persisted, real-disk path. `pack_with_cache` (pure, cache-injected)
    // and `resolve_island`/`describe_city` (real git/filesystem, but no
    // shared on-disk STATE) above already cover every behaviour the
    // persisted wrapper adds on top; `report_the_real_archipelago_for_the_
    // authors_repositories` below is this module's equivalent of
    // `real_repos_layout_check`.

    // ---- the permanent property test ----

    /// Same tiny deterministic PRNG `city::layout`'s own property test uses
    /// (PCG-style LCG, high bits only — see that module's `Lcg` doc comment
    /// for why: a classic LCG's low bits have a period-4 cycle that makes
    /// `% n` on them produce a near-fixed pattern instead of independent
    /// draws). Restated here rather than shared because `city::layout`'s
    /// copy is private to that module's test mod.
    struct Lcg(u64);
    impl Lcg {
        fn new(seed: u64) -> Self {
            Lcg(seed.wrapping_add(0x9E3779B97F4A7C15))
        }
        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0
        }
        fn next_range(&mut self, n: u64) -> u64 {
            (self.next_u64() >> 32) % n
        }
    }

    /// ADDED PERMANENTLY, same reasoning as `city::layout`'s own random-
    /// history property test (see this module's doc comment, and
    /// `docs/superpowers/phase-0-followups.md`'s account of the plot-overlap
    /// bug class recurring four times in hand-written tests there): over a
    /// generated history of islands appearing, disappearing, and resizing,
    /// no two islands ever overlap, and an island that reappears with a
    /// size its OLD plot still holds reclaims that exact plot.
    ///
    /// The "reclaims exactly" check only asserts when the reappearing
    /// size still fits the old plot (unchanged or shrunk) — a size that
    /// GREW past the old plot is legitimately allowed to grow-in-place or
    /// relocate per `pack_with_cache`'s own rule 2/3, so asserting
    /// byte-identical reuse there would be asserting a false property, not
    /// testing a real one.
    #[test]
    fn packed_islands_never_overlap_and_a_returning_island_reclaims_its_position_across_random_histories(
    ) {
        const ISLANDS: usize = 10;
        const STEPS: usize = 12;
        const SEEDS: u64 = 400;

        for seed in 0..SEEDS {
            let mut rng = Lcg::new(seed);
            let mut sizes = [0u32; ISLANDS]; // 0 == absent this step
            let mut last_plot: [Option<IslandPlot>; ISLANDS] = Default::default();
            let mut cache = ArchipelagoCache::default();

            for step in 0..STEPS {
                // 1-4 independent edits per step, so a single call can both
                // grow an existing island and introduce a brand-new one —
                // the exact shape `city::layout`'s own history shows a
                // single-edit-per-step generator can never produce.
                let edits = 1 + rng.next_range(4);
                for _ in 0..edits {
                    let slot = rng.next_range(ISLANDS as u64) as usize;
                    match rng.next_range(3) {
                        0 => sizes[slot] = 0, // disappears
                        _ => sizes[slot] = 4 + rng.next_range(30) as u32, // appears/resizes
                    }
                }

                let inputs: Vec<IslandInput> = (0..ISLANDS)
                    .filter(|&s| sizes[s] > 0)
                    .map(|s| IslandInput { root: format!("island-{s}"), land_w: sizes[s], land_d: sizes[s] })
                    .collect();

                let (resolved, new_cache) = pack_with_cache(&inputs, &cache);

                let values: Vec<&IslandPlot> = resolved.values().collect();
                for (i, a) in values.iter().enumerate() {
                    for b in values.iter().skip(i + 1) {
                        assert!(
                            !plots_overlap(a, b),
                            "seed {seed} step {step}: resolved islands overlap: {:?} vs {:?}",
                            a,
                            b
                        );
                    }
                }
                let cached_values: Vec<&IslandPlot> = new_cache.plots.values().collect();
                for (i, a) in cached_values.iter().enumerate() {
                    for b in cached_values.iter().skip(i + 1) {
                        assert!(
                            !plots_overlap(a, b),
                            "seed {seed} step {step}: cached plots overlap: {:?} vs {:?}",
                            a,
                            b
                        );
                    }
                }

                for s in 0..ISLANDS {
                    let root = format!("island-{s}");
                    if let Some(plot) = resolved.get(&root) {
                        if let Some(prev) = &last_plot[s] {
                            let (need_w, need_d) = plan_reserved(sizes[s], sizes[s]);
                            if prev.w >= need_w && prev.d >= need_d {
                                assert_eq!(
                                    plot, prev,
                                    "seed {seed} step {step}: island {s} did not reclaim its exact position"
                                );
                            }
                        }
                        last_plot[s] = Some(plot.clone());
                    }
                }

                cache = new_cache;
            }
        }
    }

    // ---- report: the author's real repositories (Read this to see the
    // ---- actual archipelago on this machine) ----

    /// Bounding box (`xmin, zmin, xmax, zmax`) over every plot's full
    /// reserved extent — used only for reporting/plotting how spread out a
    /// resolved archipelago is, never by the packer itself.
    fn plots_bbox(plots: &BTreeMap<String, IslandPlot>) -> (i32, i32, i32, i32) {
        let mut xmin = i32::MAX;
        let mut zmin = i32::MAX;
        let mut xmax = i32::MIN;
        let mut zmax = i32::MIN;
        for p in plots.values() {
            xmin = xmin.min(p.x);
            zmin = zmin.min(p.z);
            xmax = xmax.max(p.x + p.w as i32);
            zmax = zmax.max(p.z + p.d as i32);
        }
        (xmin, zmin, xmax, zmax)
    }

    /// A top-down SVG of every plot in `plots`: a faint outline for the
    /// full reserved footprint (water margin included) and a filled
    /// rectangle for the LAND inside it (via `land_of_reserved`, the same
    /// reverse-of-`plan_reserved` calculation the production code already
    /// uses for an `Unknown` island's stability placeholder) — so open
    /// water between islands is visible as the gap between filled
    /// rectangles, not just asserted in prose. A red ring marks the world
    /// origin (spiral slot 0), so "does the biggest island sit at the
    /// heart of the sea" can be checked by eye. Mirrors
    /// `city::preview::preview_svg`'s role for a single town's SVG, kept
    /// local to this report rather than a shared module since nothing else
    /// in production code needs to draw the whole sea.
    fn plots_svg(plots: &BTreeMap<String, IslandPlot>, title: &str) -> String {
        let (xmin, zmin, xmax, zmax) = plots_bbox(plots);
        let span_x = (xmax - xmin).max(1) as f64;
        let span_z = (zmax - zmin).max(1) as f64;
        // Target ~1400px on the longer side; never blow past 8x zoom on a
        // tiny archipelago, never shrink below 0.02x on a huge one — both
        // ends are informative (a huge one SHOULD look sparse at this
        // scale, that's the point of drawing it).
        let scale = (1400.0 / span_x.max(span_z)).clamp(0.02, 8.0);
        let pad = 40.0;
        let width = span_x * scale + pad * 2.0;
        let height = span_z * scale + pad * 2.0;

        let mut body = String::new();
        for plot in plots.values() {
            let (land_w, land_d) = land_of_reserved(plot);
            let px = (plot.x - xmin) as f64 * scale + pad;
            let pz = (plot.z - zmin) as f64 * scale + pad;
            let pw = (plot.w as f64 * scale).max(0.5);
            let pd = (plot.d as f64 * scale).max(0.5);
            body.push_str(&format!(
                "<rect x=\"{px:.1}\" y=\"{pz:.1}\" width=\"{pw:.1}\" height=\"{pd:.1}\" fill=\"none\" stroke=\"#2a6f6b\" stroke-width=\"0.5\" opacity=\"0.4\" />\n"
            ));
            let lx = px + (plot.w.saturating_sub(land_w)) as f64 / 2.0 * scale;
            let lz = pz + (plot.d.saturating_sub(land_d)) as f64 / 2.0 * scale;
            let lw = (land_w as f64 * scale).max(0.8);
            let ld = (land_d as f64 * scale).max(0.8);
            body.push_str(&format!(
                "<rect x=\"{lx:.1}\" y=\"{lz:.1}\" width=\"{lw:.1}\" height=\"{ld:.1}\" rx=\"1.5\" fill=\"#8fbf6f\" stroke=\"#4d7a3c\" stroke-width=\"0.6\" />\n"
            ));
        }
        let ox = (0 - xmin) as f64 * scale + pad;
        let oz = (0 - zmin) as f64 * scale + pad;
        body.push_str(&format!(
            "<circle cx=\"{ox:.1}\" cy=\"{oz:.1}\" r=\"5\" fill=\"none\" stroke=\"#c0392b\" stroke-width=\"1.6\" />\n"
        ));

        let safe_title = title.replace('&', "&amp;").replace('<', "&lt;");
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {width:.1} {height:.1}\" width=\"{width:.1}\" height=\"{height:.1}\">\n\
<rect x=\"0\" y=\"0\" width=\"{width:.1}\" height=\"{height:.1}\" fill=\"#0f4c4a\" />\n\
<text x=\"10\" y=\"20\" font-family=\"-apple-system, sans-serif\" font-size=\"14\" fill=\"#eef7f3\">{safe_title}</text>\n\
{body}\
</svg>\n"
        )
    }

    fn write_report_svg(file_name: &str, svg: &str) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.superpowers/sdd/2026-09-17-phase-0-5b-first-island");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(file_name);
        let html = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{{margin:0;background:#0f4c4a}}</style></head><body>{svg}</body></html>"
        );
        match std::fs::write(&path, html) {
            Ok(()) => println!("wrote {}", path.display()),
            Err(e) => println!("failed to write {}: {e}", path.display()),
        }
    }

    /// A synthetic archipelago of `n` islands, cycling through `land_sizes`
    /// (real land sizes observed elsewhere in this same report, for N
    /// larger than any real repo count this machine has) so the 10- and
    /// 300-island scale checks below are built from a REAL size
    /// distribution rather than made-up numbers, even though this machine
    /// does not actually have 300 repositories.
    fn synthetic_plots(land_sizes: &[(u32, u32)], n: usize) -> BTreeMap<String, IslandPlot> {
        let inputs: Vec<IslandInput> = (0..n)
            .map(|i| {
                let (w, d) = land_sizes[i % land_sizes.len()];
                IslandInput { root: format!("synthetic-{i:04}"), land_w: w, land_d: d }
            })
            .collect();
        let (resolved, _cache) = pack_with_cache(&inputs, &ArchipelagoCache::default());
        assert_no_overlaps(&resolved);
        resolved
    }

    fn report_scale(label: &str, plots: &BTreeMap<String, IslandPlot>, file_name: &str) {
        let (xmin, zmin, xmax, zmax) = plots_bbox(plots);
        let (w, d) = (xmax - xmin, zmax - zmin);
        let land_area: u64 =
            plots.values().map(|p| { let (lw, ld) = land_of_reserved(p); lw as u64 * ld as u64 }).sum();
        let bbox_area = (w as u64).max(1) * (d as u64).max(1);
        println!(
            "{label}: {} islands, bounding box {w}x{d} grid units (area {bbox_area}), land fill {:.1}%",
            plots.len(),
            100.0 * land_area as f64 / bbox_area as f64
        );
        write_report_svg(file_name, &plots_svg(plots, label));
    }

    /// Not a correctness test — a `--ignored` report, exactly the "small
    /// binary or `#[ignore]`d test" the phase-0.5b brief asks for: prints
    /// the computed archipelago for EVERY one of the author's own real
    /// repositories (the same discovery `build_archipelago` itself uses —
    /// `candidate_roots`/`scan_roots`/`scanned_repos` — rather than a
    /// hand-picked handful, so this report shows the actual shape a player
    /// sees), how long computing it took, and writes an SVG/HTML picture of
    /// the result plus two synthetic scale checks (10 and 300 islands, built
    /// from this machine's own real land-size distribution — see
    /// `synthetic_plots`) so the layout's behaviour at very different scales
    /// can be judged by eye instead of guessed at. Run with:
    /// `cargo test --lib city::archipelago -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn report_the_real_archipelago_for_the_authors_repositories() {
        let home = dirs::home_dir().expect("no home directory");
        let roots_pb = crate::world::unsettled::candidate_roots(&home, &[], &|p| p.is_dir());
        let discovery_start = std::time::Instant::now();
        let scanned = crate::world::unsettled::scan_roots(&roots_pb);
        println!("\ndiscovery scan under {roots_pb:?}: {} repos in {:?}", scanned.len(), discovery_start.elapsed());
        let repos = crate::world::unsettled::scanned_repos(&scanned);
        let roots: Vec<(PathBuf, String)> = repos
            .into_iter()
            .map(|r| (normalize_path(Path::new(&r.path)), r.name))
            .collect();
        assert!(!roots.is_empty(), "expected at least one real repository to report on");

        // First call: cold (no cache yet for any of these roots under this
        // run) or warm (a prior run of this same test already populated
        // ~/.age-of-agents/archipelago.json) — both are reported, since
        // both are real, honest timings a player could actually see.
        let start = std::time::Instant::now();
        let archipelago = build_archipelago_for_roots(&roots);
        let elapsed = start.elapsed();

        println!("\n=== archipelago for the author's real repositories ===");
        println!("computed in {elapsed:?} for {} repositories\n", archipelago.islands.len());
        for island in &archipelago.islands {
            match &island.city {
                CityStatus::Known { district_count, building_count, width, depth, source, measured_at } => {
                    println!(
                        "{:<28} root={} plot=(x={}, z={}, w={}, d={}) districts={district_count} buildings={building_count} city_extent=({width}x{depth}) source={source:?} last_changed_at={:?} measured_at={measured_at:?}",
                        island.name, island.root, island.plot.x, island.plot.z, island.plot.w, island.plot.d, island.last_changed_at
                    );
                }
                CityStatus::Unknown { reason } => {
                    println!(
                        "{:<28} root={} plot=(x={}, z={}, w={}, d={}) UNKNOWN: {reason}",
                        island.name, island.root, island.plot.x, island.plot.z, island.plot.w, island.plot.d
                    );
                }
            }
        }

        // Second call: everything should now be cache-warm (same
        // last-commit epoch), so this measures the "nothing changed since
        // last time" cost the sea view actually pays on a repeat fetch. Made
        // immediately, so it lands inside `REVALIDATION_SKIP_WINDOW` and
        // skips every root's `git` probe entirely — the mount-then-
        // window-focus re-fetch pattern `useArchipelago.ts` actually makes.
        let start = std::time::Instant::now();
        let _again = build_archipelago_for_roots(&roots);
        let elapsed_warm = start.elapsed();
        println!("\nsecond call (cache-warm, immediate re-fetch inside the skip window): {elapsed_warm:?}");

        // Third call: made AFTER the skip window has elapsed, with every
        // root's commit epoch still unchanged — the more common real-world
        // "warm" case (a re-fetch minutes later, not milliseconds later).
        // Every root still needs its own `git log` probe here (the whole-
        // archipelago skip no longer applies), but none needs a `build_city`
        // walk (`resolve_island`'s own per-root cache still matches), and
        // the probes are parallelized — this is what the sequential-loop
        // "warm ~2.0s" baseline actually measured, and what this fix's
        // parallelization (not the skip window) is what fixes for THIS case.
        std::thread::sleep(REVALIDATION_SKIP_WINDOW + std::time::Duration::from_secs(1));
        let start = std::time::Instant::now();
        let _third = build_archipelago_for_roots(&roots);
        let elapsed_past_window = start.elapsed();
        println!(
            "third call (past the skip window, epochs unchanged, git probes parallelized): {elapsed_past_window:?}"
        );

        // ---- scale check: 10 / real-count / 300, side by side ----
        let mut plots_by_root: BTreeMap<String, IslandPlot> = BTreeMap::new();
        for island in &archipelago.islands {
            plots_by_root.insert(island.root.clone(), island.plot.clone());
        }
        let land_sizes: Vec<(u32, u32)> =
            archipelago.islands.iter().map(|isl| land_of_reserved(&isl.plot)).collect();
        // Biggest real islands first, so the synthetic 10-island scenario
        // is a plausible "someone who just started" sample rather than an
        // arbitrary slice.
        let mut sorted_sizes = land_sizes.clone();
        sorted_sizes.sort_by_key(|a| std::cmp::Reverse(a.0 * a.1));

        println!("\n=== scale check (10 / {} real / 300 islands) ===", archipelago.islands.len());
        let ten = synthetic_plots(&sorted_sizes, 10);
        report_scale("10 islands (synthetic, real size distribution)", &ten, "island-scatter-10.html");
        report_scale(
            &format!("{} islands (REAL — this machine's actual archipelago)", plots_by_root.len()),
            &plots_by_root,
            &format!("island-scatter-{}.html", plots_by_root.len()),
        );
        let three_hundred = synthetic_plots(&sorted_sizes, 300);
        report_scale(
            "300 islands (synthetic, real size distribution cycled)",
            &three_hundred,
            "island-scatter-300.html",
        );
    }
}
