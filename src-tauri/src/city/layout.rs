//! Turns a `CityModel` into a `CityLayout`: where every district's plot and
//! every building inside it actually sits.
//!
//! Phase 0.5b's design risk here is the mirror image of Task 3's: a
//! technically-correct layout that reads as a scatter plot (buildings
//! hashed onto a spiral, or a strip 6000 cells wide) fails the product even
//! with every test green. Two rules keep that from happening:
//!
//! - **Districts pack onto a road grid.** Sorted by path, each district
//!   gets a roughly-square plot sized from its own building count, and
//!   plots are shelf-packed left to right into rows bounded to keep the
//!   whole city roughly square (never a single 6000-wide strip) — see
//!   `layout_city`'s row-width target.
//! - **A building's position depends only on its own PERSISTED cell index,
//!   keyed by its path, never on where it falls in a sorted list.**
//!   `gnomon_position` places a cell index `i` by extending an ever-growing
//!   square (the classic "gnomon" growth of the square numbers) rather than
//!   by re-flowing a `row = i / cols` grid whose `cols` would shift under it
//!   as `n` crosses a perfect square — but which index a given FILE gets is
//!   resolved once, by path, and remembered in `LayoutCache` forever after
//!   (see "Fix round 4" below). An earlier version of this module assigned
//!   index `i` from a building's position in the district's sorted-by-path
//!   order instead, which is a different and weaker claim: it makes an
//!   already-placed building's index shift whenever a lower-sorting file is
//!   added or removed. Fix round 4 replaces that.
//!
//! ## Fix round 1: districts reshuffle too, unless cached (spec §4.2)
//!
//! The two rules above only make a *building's* position stable within its
//! own district. They say nothing about a *district's* plot, which
//! `layout_city` re-derives from scratch on every call by sorting ALL
//! current districts by path and re-packing the whole shelf — so inserting
//! a new top-level directory that sorts before an existing one (adding
//! `aaa/` to a repo that already has `src/` and `zzz/`) shifts every
//! district from that point on. That is the ordinary case, not an edge
//! case, so spec §4.2's persisted-cache mechanism is implemented here
//! rather than deferred: `LayoutCache` remembers each district's resolved
//! `Plot` by path, plus the shelf-packing frontier needed to place new
//! districts without disturbing it, and is round-tripped through
//! `~/.age-of-agents/towns/<repo-hash>.json` (see `layout_city_persisted`).
//! `layout_with_cache` is the pure, disk-free core this wraps — it takes a
//! loaded `LayoutCache` in and returns the updated one alongside the
//! layout, the same injection shape as `FileSource`/`GitProbe`/`EnvSource`
//! elsewhere in this codebase — and `layout_city` (unchanged signature)
//! is just that core called with an empty cache and its updated cache
//! thrown away, so every pre-existing test keeps working verbatim.
//!
//! ## Fix round 2: growth-aware — a cached plot can outgrow itself
//!
//! Round 1 reused a cached `Plot` verbatim, position *and* size, forever.
//! That is wrong on the most ordinary edit there is: adding files to an
//! existing directory. Once its building count needed more cells than its
//! cached footprint held, buildings rendered past that plot's boundary —
//! trading a *reshuffle* for something worse, a *visible overlap*, which
//! breaks the harder invariant (`buildings_stay_inside_their_plot`,
//! `districts_do_not_overlap`) to protect the softer one (position
//! stability). The rule is now growth-aware (see `layout_with_cache`):
//!
//! 1. If a cached district's plot still holds its current building count,
//!    reuse it exactly — including when the district SHRANK: a plot never
//!    compacts down, since re-sizing would be indistinguishable from a
//!    reshuffle to anything watching that district.
//! 2. If it no longer fits, try to GROW the plot in place: extend it to
//!    the smallest rectangle, anchored at the *same top-left corner*, that
//!    is at least as large as both the old footprint and the new
//!    requirement — i.e. extend right and/or down together as the
//!    specific transition needs (rather than trying one direction, then
//!    the other, in some arbitrary order — a single "take the max of both
//!    dimensions" candidate is simpler and already minimal). Accepted only
//!    if that larger rectangle doesn't overlap any other district's plot.
//! 3. If it would overlap, that ONE district relocates to a fresh plot
//!    appended to the packing frontier — the same mechanism a brand-new
//!    district uses. Nothing else moves.
//! 4. No two plots may ever overlap and no building may ever render
//!    outside its own plot — these are the hard invariants; position
//!    stability is the one that yields when they conflict.
//!
//! **Headroom, considered and adopted:** a freshly established plot (a
//! brand-new district, or one that just relocated) is sized for one MORE
//! building than it currently has (`plan_district`'s `roomy_width`/
//! `roomy_depth`, vs. the exact `width`/`depth` used for the fits-or-not
//! check). This makes the single most common repo edit — adding one file
//! to a directory — land inside the existing plot rather than triggering
//! growth/relocation at all, without meaningfully changing the "roughly
//! square" sizing property (see the real-repo re-check in the fix report
//! for the actual footprint difference this made). Growth-in-place itself
//! stays exact (no extra padding) once it has already been triggered,
//! since a district that's growing enough to need a resize will keep
//! being re-evaluated on its own terms next time regardless of how much
//! slack it's given now.
//!
//! ## Fix round 3: the "narrow theoretical gap" wasn't narrow
//!
//! Round 2's own doc comment dismissed a "phase-1 growth reaching into
//! phase-2's territory" collision as needing a district "already sitting
//! right at the frontier's leading edge" — reachable, per that reasoning,
//! only in an extreme case. It reproduces with as few as TWO districts:
//! cache `{aa: 1 file}`, then in one call grow `aa` to 9 files (which
//! extends its plot in place, per round 2's rule 2) while ALSO adding a
//! brand-new `bb` — `bb` is allocated from `Frontier`, whose `cur_z`/
//! `row_height` still reflect `aa`'s PRE-growth footprint, because nothing
//! about growing a plot in place ever touched the frontier. Running phase
//! 1 before phase 2 (round 2's stated mitigation) doesn't help: it
//! prevents phase-2-into-phase-1 collisions, which was never the actual
//! hazard, while doing nothing about phase-1-into-phase-2. A repo session
//! that adds a few files to an existing directory AND creates one new
//! directory — an entirely ordinary multi-file edit — reaches this.
//!
//! The fix is a small grid-bucketed `SpatialIndex` (see below) covering
//! every plot placed so far in the current call (seeded from `cache.plots`
//! at the start). Every collision check — the growth-blocked check, a
//! relocation's search for free space, and a brand-new district's frontier
//! candidate — queries this index instead of scanning `plots` (a
//! `BTreeMap`) or trusting the frontier's now-provably-untrustworthy
//! "always ahead of everything" assumption. A query only inspects the
//! handful of buckets near the candidate rectangle, not every plot in the
//! repo, so this closes the correctness gap AND keeps every check cheap —
//! including at the scale ("all districts growing in the same call")
//! where round 2's `BTreeMap`-scanning checks measured as truly
//! quadratic (10ms → 336ms across a 1,500 → 12,000-district doubling
//! series, ~3.7× per doubling) — see the fix report for the re-measured,
//! bounded numbers. Stale entries are never removed from the index within
//! a call (only ever added to): a district's old, pre-growth rectangle is
//! always fully contained in its own grown one, so a stale entry can only
//! ever confirm a real overlap, never hide one — removal would add
//! bookkeeping for no correctness benefit.
//!
//! One gap remained here, out of scope for this round per the controller's
//! ruling: crossing Task 3's `MAX_BUILDINGS_PER_DISTRICT` split boundary
//! renames a directory's model path from `dir` to `dir#1`/`dir#2` (see
//! `model::split_into_plots`), which orphaned that path's cache entry —
//! the whole directory's contents jumped to the frontier as if brand new,
//! since the cache was keyed by path and `dir` and `dir#1` are different
//! keys. Not fixed here — see "Fix round 5" below for the resolution.
//!
//! ## Fix round 4: a building's cell is per-path, not per-sorted-index
//!
//! Rounds 1-3 made a DISTRICT's plot stable across calls but never made a
//! BUILDING's cell stable within its own district: `plan_district` sorted a
//! district's buildings by path and handed `gnomon_position` the SORTED
//! INDEX, so inserting a file that does not sort last renumbers every
//! building after it — `src/{b.rs,c.rs}` at gnomon indices `0,1` become
//! `1,2` the instant `src/a.rs` is added, even though neither existing file
//! changed. This was the "adding a file moves nothing" half of spec §4.2
//! this module never actually delivered (see
//! `docs/superpowers/phase-0-followups.md`); the guarding test only
//! exercised the one case (appending a file that sorts last) where sorted
//! index and stable identity happen to agree.
//!
//! The fix gives `LayoutCache` a second per-district memory alongside its
//! `Plot`: `cells`, a `path -> cell index` map. A file already in the map
//! keeps its cell exactly; a brand-new file takes the lowest cell index not
//! currently occupied in its district (`resolve_cells`'s "next free plot" —
//! the literal reading of spec §4.2's phrase); a deleted file's entry is
//! dropped, releasing its index back to that pool immediately — see the
//! next paragraph for why immediately, rather than held forever the way a
//! district's `Plot` is. A district's OWN cell map, like its `Plot`, is
//! never dropped just because the whole district is absent from the
//! current model — it sits untouched so a same-path directory that comes
//! back later reclaims its files' old cells too, not just its old plot.
//! Renaming a file is a delete of the old path plus an add of the new one;
//! it gets a new cell, honestly, because the path IS the identity being
//! tracked — there is no way to tell a rename from an unrelated
//! delete-and-create without git history this module does not have.
//!
//! **Release immediately, not held forever — considered and decided.** A
//! district's `Plot` is never evicted because a whole directory is rarely
//! deleted and recreated, so holding its one plot forever costs one bounded
//! hole. A building's cell is a different animal: renaming a file — expect
//! it constantly in an actively-edited directory — is a delete plus an add,
//! so holding every vacated cell forever would make a churny directory's
//! highest-ever cell index (and therefore its plot) grow without bound even
//! while its actual file count stays flat — the same permanent-bloat shape
//! the followups doc already flags for the 40-file split boundary, just
//! reached by ordinary renames instead. Releasing a cell the moment its
//! file disappears keeps the district's footprint tracking its CURRENT file
//! count (plus the usual one-file headroom), at the cost of the one thing
//! held-forever would have bought: if some OTHER new file fills the gap
//! before the original file's path reappears, the reappearing file gets a
//! new cell instead of its old one. That is judged an acceptable, rare
//! cost — the common case (a quick revert, an undo) still reclaims the same
//! cell, because nothing else has had the chance to take it yet — for a
//! mechanism that stays honest about what "the district's next free plot"
//! means at every moment, rather than only at the instant a file first
//! leaves.
//!
//! Bumped `LAYOUT_CACHE_VERSION` 3 -> 4: a cache written before this fix has
//! no `cells` entries at all. Without the bump they would silently
//! deserialize as an empty map (`#[serde(default)]`) and every EXISTING
//! city's per-file positions would re-derive from scratch the next time
//! each district happened to be touched — not wrong (the same "every
//! district counts as new" fallback `LayoutCache::default()` already relies
//! on), but gradual and invisible, which reads exactly like the
//! regression this round exists to prevent. Discarding the whole stale
//! cache instead makes that one-time relayout happen for every district up
//! front, deterministically, in one release rather than trickling out
//! later as a mystery.
//!
//! ## Fix round 5: crossing the split boundary no longer orphans a cache entry
//!
//! The gap called out above and in the followups doc, closed. Every cache
//! map in this module (`LayoutCache::plots`, `LayoutCache::cells`) is now
//! keyed on `CityModel::District::cache_key`, not `District::path` —
//! `plan_district`'s `existing_cells` lookup, and every `cache.plots`/
//! `plots` read-or-insert in `layout_with_cache`, switched over together so
//! there is exactly one notion of "this district's cache identity" left in
//! the module.
//!
//! The key insight (see `model::split_into_plots`'s doc comment for the
//! full reasoning) is that a directory is either wholly unsplit (`dir`) or
//! wholly split (`dir#1`, `dir#2`, …) — the two representations of "the
//! directory's first 40-or-fewer files" never coexist — so `cache_key`
//! simply gives slot 1 the SAME key the bare directory has always used,
//! regardless of which of the two names is currently presenting it. Slot 1
//! growing past the threshold, or shrinking back below it, is therefore a
//! cache HIT either way: `dir#1` reuses/grows-in-place/relocates exactly
//! the `Plot` `dir` would have, and every file already in `dir`'s `cells`
//! map keeps its exact cell too. Slot 2 and beyond key on their own
//! numbered name (`dir#2`, `dir#3`, …), same as `path` — they are
//! genuinely new content the first time each appears, so they correctly
//! get a fresh plot from the frontier, same as any other brand-new
//! district; crossing from 2 splits to 3 leaves slots 1 and 2 completely
//! untouched, since neither one's cache key changed.
//!
//! `path` itself is deliberately left alone: it still reads `dir`/`dir#1`/
//! `dir#2` exactly as before, so nothing that displays or matches on it
//! (the frontend, this module's own path-based test helpers) changes at
//! all. `cache_key` is purely an internal identity `city::layout` uses for
//! cache lookups and is never surfaced anywhere else.
//!
//! **The per-building `cells` map had the identical bug, unnoticed.**
//! Before this fix, `cells` was ALSO keyed by `path` — so the moment a
//! directory crossed the split boundary, every one of its files' carefully
//! preserved cells (fix round 4) was abandoned the same way its `Plot` was,
//! and the newly-renamed `dir#1` re-derived every cell from scratch. Since
//! `plan_district`'s headroom already makes a fresh district's plot exactly
//! big enough for its current buildings, a from-scratch cell re-derivation
//! would not have overlapped anything or looked broken in a screenshot —
//! it would just have silently reassigned every building inside the
//! (correctly-positioned, post-fix) plot to a new cell, which is exactly
//! the kind of "not wrong, just not remembered" regression fix round 4
//! itself exists to prevent. Keying `cells` by the same `cache_key` fixes
//! both at once, in one pass, since both maps share the exact same
//! aliasing logic.
//!
//! Bumped `LAYOUT_CACHE_VERSION` 4 -> 5: not because the on-disk TYPES
//! changed (they didn't — `plots`/`cells` are still `BTreeMap<String, _>`),
//! but because their KEYS' meaning did. A cache written before this fix
//! still has `dir#1`'s plot and cells filed under the literal string
//! `"dir#1"`; this version reads that same content under the key `"dir"`
//! instead, so an old file's entries would sit as permanent, unreachable
//! holes (harmless, but exactly the "gradual and invisible" drift the
//! round-4 bump reasoning already rejected) while the directory itself
//! silently re-lays-out once under the new scheme regardless. Bumping the
//! version makes that one-time re-layout happen for every affected
//! directory up front, deterministically, the same as round 4's bump did.
//!
//! ## Fix round 6: split-slot MEMBERSHIP is now stable too
//!
//! Round 5 fixed `city::layout`'s cache from losing a directory's plot and
//! cells the instant it crossed the split boundary — but it deliberately
//! left one thing alone (see round 5's doc comment and
//! `docs/superpowers/phase-0-followups.md`): `model::split_into_plots`
//! itself still decided WHICH file lands in `dir#1` vs `dir#2` by chunking
//! whatever order its caller's `Vec<Building>` happened to be in. For
//! `RealFiles` that's `git ls-files`'s own sorted-by-path order, so adding
//! a file that sorts into the MIDDLE of an already-split directory (not
//! appended at the end) shifted every later file's chunk — the file that
//! was building #40 in `dir#1` could be bumped into `dir#2` purely because
//! an unrelated, earlier-sorting file was added elsewhere in the same
//! directory. Since `dir#1` and `dir#2` are different districts with
//! different plots, that is not a cell shifting by one — it is a building
//! teleporting across the whole city.
//!
//! The fix lives mostly in `model::split_into_plots` and
//! `model::resolve_split_indices` (see that function's doc comment for the
//! full design): every file in an over-full directory gets a stable,
//! persisted global index, and its split slot is that index floor-divided
//! by `MAX_BUILDINGS_PER_DISTRICT` — so a file's slot changes only when
//! its OWN index changes, which only happens when the file itself is added
//! or removed. This module's part is purely custodial, exactly mirroring
//! how `cells` already round-trips a building's stable cell alongside a
//! district's `Plot`:
//!
//! - `LayoutCache` gains `split_membership` (`model::SplitMembership`:
//!   directory path -> file path -> stable index), persisted and reloaded
//!   the same way `cells` is, with the identical "never evicted" contract
//!   (an absent directory's membership sits untouched, ready for a
//!   same-path directory to reclaim it later).
//! - `layout_with_cache` does not compute `split_membership` itself — by
//!   the time it runs, `model::build_city_with_membership` has already
//!   made that decision — so it simply carries `cache.split_membership`
//!   through into `updated_cache` unchanged, the same pass-through
//!   discipline that keeps an old caller (one that still builds its model
//!   with the stateless `build_city`) from ever silently wiping the field.
//! - `layout_city_persisted_from_root` is the new, real entry point,
//!   superseding the `build_city` + `layout_city_persisted` PAIR every
//!   production caller used before this fix: it loads this repo's
//!   `LayoutCache` FIRST — before the model even exists — so
//!   `build_city_with_membership` has the persisted membership available
//!   while it is still deciding how to split each directory. This ordering
//!   is not optional: by the time a `CityModel` exists, its directories are
//!   already partitioned into fixed `District` entries, and nothing
//!   downstream can move a `Building` from one `District` to another after
//!   the fact — `layout_city_persisted`'s old model-first, cache-second
//!   order can only ever fix WHERE an already-decided split renders, never
//!   WHICH file the split put where.
//!
//! **How membership and `cache_key` compose:** `split_membership` decides,
//! per file, which numbered slot (`dir`, `dir#2`, `dir#3`, …) it belongs
//! to; `cache_key` (round 5) then decides, per slot, which persisted
//! `Plot`/`cells` entry that slot reuses. The two are independent and
//! stack cleanly: membership is resolved once, in `model::
//! split_into_plots`, before any `District` (and therefore any
//! `cache_key`) exists; `cache_key` is then computed from the resulting
//! slot number exactly as round 5 already does, unaware that the slot's
//! membership is now stable rather than positional. Fixing membership
//! without a working `cache_key` would still teleport `dir#1` itself
//! across the split boundary (round 5's original bug); fixing `cache_key`
//! without stable membership (this round's fix) leaves a slot's PLOT
//! stable while silently reshuffling WHICH buildings render inside it —
//! the "not wrong, just not remembered" shape both rounds exist to
//! prevent, one level apart.
//!
//! Bumped `LAYOUT_CACHE_VERSION` 5 -> 6: `LayoutCache` gained the
//! `split_membership` field a pre-fix cache file does not have — the same
//! reasoning as every previous field-addition bump (round 4's `cells`,
//! round 5's re-keying): discarding the whole cache makes every
//! previously-split directory re-resolve its membership once, from its
//! current sorted order, up front and deterministically, rather than an
//! absent field silently deserializing empty and drifting differently
//! directory by directory as each is first touched under the new scheme.

use crate::city::model::{
    build_city_with_membership, CityModel, CitySource, FileSource, SplitMembership,
};
use crate::world::repo::normalize_path;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Cells between the plot edge and its outermost buildings, in grid units —
/// one cell of margin on every side, so a plot's boundary reads as a street
/// even though buildings inside it now abut directly (see `SPACING` below).
const MARGIN: i32 = 1;
/// Grid cells between adjacent building columns/rows WITHIN a district.
///
/// Phase 0.5 shipped this at `2`, which reserves an empty cell between every
/// pair of buildings — geometrically fine (no test cared) but the exact
/// thing that made a rendered district read as a scatter of detached
/// objects rather than a Townscaper-style block (see
/// `docs/superpowers/phase-0-followups.md`'s "Plot interiors read sparse"
/// note). `1` makes adjacent buildings occupy adjacent cells — they abut,
/// with no gap cell between them — while `MARGIN` still keeps a cell of
/// street between a plot's outermost buildings and its boundary. This is a
/// look-and-feel change, not a data change: a building's cell is still a
/// pure function of its sorted index (`gnomon_position`) and its district's
/// path, so nothing about *which* files exist or *what* a building
/// represents is fabricated — only how tightly they're packed.
///
/// `pub` so `commands::CityView` (and the `city_fixture` dev binary) can
/// hand the frontend this exact value as `grid_pitch` instead of it
/// hand-copying a second constant that can silently drift out of sync (see
/// the `GRID_PITCH` note in `docs/superpowers/phase-0-followups.md`).
pub const SPACING: i32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plot {
    pub x: i32,
    pub z: i32,
    pub w: u32,
    pub d: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlacedBuilding {
    pub building_index: usize,
    pub x: i32,
    pub z: i32,
    pub height: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlacedDistrict {
    pub district_index: usize,
    pub plot: Plot,
    pub buildings: Vec<PlacedBuilding>,
    pub road_edges: Vec<(i32, i32)>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CityLayout {
    pub districts: Vec<PlacedDistrict>,
    pub width: u32,
    pub depth: u32,
    /// The grid pitch (in grid cells) between one building's index and the
    /// next along either axis — `SPACING`, sourced live rather than
    /// hand-copied a second time. `src/city.ts` used to mirror this as its
    /// own `GRID_PITCH` constant with nothing enforcing the two ever agreed
    /// (see `docs/superpowers/phase-0-followups.md`); the "let buildings
    /// abut" change (`SPACING` `2` -> `1`) is exactly the change that would
    /// have silently sprung that trap, so this field is now the single
    /// source of truth the frontend reads (`gridPitchOf` in `src/city.ts`).
    pub grid_pitch: i32,
}

/// Bumped whenever `LayoutCache`'s on-disk shape changes incompatibly, OR
/// whenever a change elsewhere means an existing cache describes a city
/// that no longer honestly exists. A file written by a different version
/// is discarded rather than risking a misinterpreted (and therefore
/// silently wrong) layout — see `LayoutCache::load`.
///
/// Bumped 1 -> 2 for Task 5b: `city::model` changed which files become
/// buildings (git-ignored files, and a nested git worktree/`.next`
/// duplicate, no longer render at all). A cache written before that fix
/// still reserves plots for districts that are now gone for good — not a
/// legitimate "vacated, might come back" hole, but a permanent void where
/// a phantom half of the city used to be. Bumping the version discards
/// those stale caches so every city re-lays out once, cleanly.
///
/// Bumped 2 -> 3 for the "let buildings abut" fix: `SPACING` changed from
/// `2` to `1`, which changes `plan_district`'s width/depth formula for
/// every building count above one. A cache written under the old pitch
/// still holds plots sized (and positioned, via the shelf-packing
/// frontier) for the old, sparser geometry — reusing it verbatim wouldn't
/// be wrong exactly (the growth-aware reuse/grow/relocate logic still
/// holds), but it would leave every existing city looking like the old,
/// gappy pitch until something happened to trigger a resize, rather than
/// the new packing being visible immediately. Bumping the version discards
/// those stale caches so every city re-lays out once under the new pitch.
///
/// Bumped 3 -> 4 for the per-file stable-cell fix (module doc, "Fix round
/// 4"): `LayoutCache` gained a `cells` field a pre-fix cache file does not
/// have. Discarding those caches makes every city's per-file positions
/// re-resolve once, cleanly and all at once, instead of drifting district by
/// district as each is first touched under the new scheme.
///
/// Bumped 4 -> 5 for the split-boundary cache-key fix (module doc, "Fix
/// round 5"): `plots`/`cells` are now keyed by `District::cache_key`
/// rather than `District::path`, so a pre-fix cache's `dir#1`/`dir#2`-keyed
/// entries are no longer the keys this version ever looks up (it looks up
/// `dir` for slot 1 instead). The on-disk shape is unchanged, but reusing
/// those old entries verbatim would leave them as silent, unreachable
/// holes rather than the plot a split directory should actually reclaim.
/// Discarding the whole cache makes every previously-split directory
/// re-derive its now-correctly-aliased cache entry once, immediately,
/// instead of that only becoming visible the next time each happens to be
/// touched.
const LAYOUT_CACHE_VERSION: u32 = 6;

/// The shelf-packing frontier: where the next brand-new district goes.
/// `target_row_width` is chosen once (from the very first layout a repo
/// ever gets) and held fixed forever after, so later districts keep
/// packing consistently with the ones already placed instead of drifting
/// under a moving target.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Frontier {
    target_row_width: u32,
    cur_x: i32,
    cur_z: i32,
    row_height: u32,
    row_has_item: bool,
}

/// Persisted per-repo layout memory, spec §4.2: "New files land in their
/// district's next free plot. Deleted files leave a plot that the player
/// can rebuild on." A district's `plots` entry, once written, is never
/// removed — a district absent from the current model just has no
/// `PlacedDistrict` in the output, while its cached `Plot` sits untouched
/// as an honest hole a returning district of the same path can reclaim.
/// Same for `cells`' outer, per-district map: an absent district's file
/// cells are kept, not dropped, so a same-path directory that returns later
/// reclaims its files' old cells too.
///
/// `cells` is the per-file half of that promise (fix round 4, module doc):
/// `cells[district_path][file_path]` is that file's stable, gnomon-order
/// cell index within its district — resolved once by path and never
/// re-derived from a sorted position again. Unlike a district's `Plot`, an
/// individual file's entry inside the inner map IS dropped the moment that
/// file disappears, releasing its index for reuse — see the module doc's
/// "release immediately, not held forever" note for why the two differ.
///
/// `split_membership` is the one-level-up analogue of `cells` (fix round 6,
/// module doc): `split_membership[directory_path][file_path]` is that
/// file's stable global index within its (possibly over-full) directory,
/// used by `model::split_into_plots` to decide WHICH numbered slot the
/// file belongs to. Same shape, same "never evicted at the outer level,
/// released immediately at the inner level" contract as `cells` — this
/// module never computes it (that decision is made in `model::
/// build_city_with_membership`, before any `District`/`cache_key` exists),
/// only carries it through unchanged from `cache` into `updated_cache`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LayoutCache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    plots: BTreeMap<String, Plot>,
    #[serde(default)]
    frontier: Frontier,
    #[serde(default)]
    cells: BTreeMap<String, BTreeMap<String, usize>>,
    #[serde(default)]
    split_membership: SplitMembership,
}

impl LayoutCache {
    /// Loads the cache at `path`. A missing file, an unreadable file, a
    /// file that fails to parse, one written by a different
    /// `LAYOUT_CACHE_VERSION`, or one with IMPLAUSIBLE geometry (a
    /// hand-edited or otherwise corrupted `Plot`/`Frontier` — a torn write
    /// yields invalid JSON, already caught above, so this specifically
    /// guards against a syntactically valid file with nonsense numbers)
    /// all silently degrade to an empty cache (`Default::default()`, which
    /// makes `layout_with_cache` treat every district as new — i.e. a
    /// fresh layout) — never a panic, mirroring `Config::load`'s
    /// discipline elsewhere in this codebase. Without this check, an
    /// implausible coordinate could overflow `i32` arithmetic in
    /// `boundary_cells` (a panic in a debug build, silently wrong geometry
    /// in release) or make it loop for an unreasonable amount of time.
    pub fn load(path: &Path) -> LayoutCache {
        let parsed = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<LayoutCache>(&text).ok());
        match parsed {
            Some(cache)
                if cache.version == LAYOUT_CACHE_VERSION
                    && frontier_is_plausible(&cache.frontier)
                    && cache.plots.values().all(plot_is_plausible)
                    && cells_are_plausible(&cache.cells)
                    // `SplitMembership` is the exact same shape as `cells`
                    // (directory -> file -> index), so it gets the same
                    // corrupted-cache guard, reused rather than duplicated.
                    && cells_are_plausible(&cache.split_membership)
                    // Opus review, MINOR 5: magnitude bounds alone don't
                    // protect the UNIQUENESS `resolve_cells` depends on. A
                    // hand-edited or torn cache mapping two paths to the
                    // SAME index within one directory would make
                    // `plan_district` place two buildings at identical
                    // coordinates — one real file silently missing from the
                    // rendered city. Reject wholesale, same as any other
                    // implausible cache.
                    && cells_are_unique(&cache.cells)
                    && cells_are_unique(&cache.split_membership) =>
            {
                cache
            }
            _ => LayoutCache::default(),
        }
    }

    /// Writes this cache to `path`, creating the parent directory if
    /// needed. Fallible (unlike `load`) — callers that persist best-effort
    /// (see `layout_city_persisted`) simply ignore a write failure, since
    /// the layout already computed is correct either way; it just won't
    /// be remembered for next time.
    ///
    /// Opus review, IMPORTANT 1: writes atomically (temp file + rename) via
    /// `cache_io::atomic_write` rather than the old plain `std::fs::write`,
    /// which truncates then writes as two separate, non-atomic steps — see
    /// that module's doc comment for the concrete torn-write failure this
    /// closes. Callers must additionally wrap their whole load-compute-save
    /// cycle in `cache_io::with_cache_lock` (see `layout_city_persisted`/
    /// `layout_city_persisted_from_root`) — atomicity alone stops
    /// corruption, not a lost update from two overlapping cycles.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string());
        crate::cache_io::atomic_write(path, json.as_bytes())
    }
}

/// See `cells_are_plausible`'s doc comment — this is the uniqueness half of
/// the same invariant: `resolve_cells` treats every index within one
/// directory as identifying exactly one file, so two paths sharing an index
/// is exactly as implausible as an out-of-range one.
fn cells_are_unique(cells: &BTreeMap<String, BTreeMap<String, usize>>) -> bool {
    cells.values().all(|by_path| {
        let mut seen = std::collections::HashSet::new();
        by_path.values().all(|&index| seen.insert(index))
    })
}

/// A generous but finite bound on any single plot's width/depth or
/// x/z-magnitude a legitimate layout could ever produce (a real plot is
/// capped by `MAX_BUILDINGS_PER_DISTRICT`'s roomy footprint — tens of grid
/// cells, not thousands), used only to reject a corrupted/hand-edited cache
/// file (see `LayoutCache::load`) — far short of `i32::MAX` so arithmetic
/// on it can never overflow, and far short of a value that would make
/// `boundary_cells` iterate for an unreasonable amount of time.
const MAX_PLAUSIBLE_PLOT_EXTENT: i64 = 100_000;
/// Same idea, but for aggregate frontier/city-wide quantities, which
/// legitimately scale with a repo's total size rather than one district's —
/// still generous, still far short of anywhere arithmetic could overflow.
const MAX_PLAUSIBLE_MAGNITUDE: i64 = 100_000_000;

fn plot_is_plausible(plot: &Plot) -> bool {
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
    (frontier.target_row_width as i64) <= MAX_PLAUSIBLE_MAGNITUDE
        && (frontier.row_height as i64) <= MAX_PLAUSIBLE_MAGNITUDE
        && (frontier.cur_x as i64).abs() <= MAX_PLAUSIBLE_MAGNITUDE
        && (frontier.cur_z as i64).abs() <= MAX_PLAUSIBLE_MAGNITUDE
}

/// A cell index feeds `gnomon_position` the same way a plot's extent does,
/// so it gets the same corrupted-cache guard as `plot_is_plausible`: a
/// hand-edited or otherwise corrupted index far outside anything a real
/// layout could ever produce (bounded by `MAX_BUILDINGS_PER_DISTRICT`) is
/// rejected wholesale rather than trusted into arithmetic.
fn cells_are_plausible(cells: &BTreeMap<String, BTreeMap<String, usize>>) -> bool {
    cells
        .values()
        .all(|by_path| by_path.values().all(|&index| (index as i64) <= MAX_PLAUSIBLE_PLOT_EXTENT))
}

/// Integer square root via a float estimate corrected by at most one step
/// in either direction — exact for every `n` this module ever calls it
/// with (building counts are capped at `MAX_BUILDINGS_PER_DISTRICT` = 40 by
/// Task 3, and `n` here never exceeds that).
fn isqrt(n: u32) -> u32 {
    let mut r = (n as f64).sqrt() as u32;
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    while r * r > n {
        r -= 1;
    }
    r
}

/// Places building index `i` (0-based, within its district, in sorted
/// order) at a `(col, row)` grid cell using gnomon growth: the classic
/// construction of a square number as nested L-shaped shells. Index `i`'s
/// position depends only on `i` itself — never on how many buildings the
/// district currently has — so appending building `n` (giving the
/// district `n + 1` buildings) never moves any of buildings `0..n`. The
/// bounding box of indices `0..n` is always within one cell of
/// `ceil(sqrt(n))` square, which is what keeps a district's plot "roughly
/// square" as it grows rather than degenerating into a strip.
fn gnomon_position(i: usize) -> (u32, u32) {
    let i = i as u32;
    let s = isqrt(i);
    let offset = i - s * s;
    if offset < s {
        (s, offset)
    } else {
        (offset - s, s)
    }
}

/// The plot extent, in grid cells, needed to hold `count` building
/// columns (or rows): `MARGIN` cells of street on the near side, then
/// `count` building cells each `SPACING` apart, then `MARGIN` cells of
/// street on the far side.
///
/// Derived rather than hardcoded (as `2 * count + 1` used to be, back when
/// `MARGIN == SPACING == 1`'s coincidental overlap made that formula look
/// simpler than it was) so a future change to either constant — `MARGIN`
/// for wider streets, `SPACING` for a different building pitch — cannot
/// silently desync the extent from the position formula
/// (`MARGIN + col * SPACING`) that `plan_district` uses for each building:
/// the last building column sits at `MARGIN + (count - 1) * SPACING` and
/// occupies one cell, so the extent needed is that plus one (the
/// building's own cell) plus `MARGIN` more (the far street).
fn footprint_extent(count: u32) -> u32 {
    2 * MARGIN as u32 + count.saturating_sub(1) * SPACING as u32 + 1
}

/// For a set of already-resolved cell indices, returns `(cols, rows,
/// positions)`: the bounding grid footprint that contains every given
/// index's `gnomon_position`, and each index's own `(col, row)`, parallel to
/// `indices`' input order. Unlike the old `0..n` scheme this replaces, the
/// indices need not be contiguous — a district can (briefly) hold a gap left
/// by a just-released cell — so the footprint is sized from the actual
/// indices present, not from a plain count.
fn grid_of_indices(indices: &[usize]) -> (u32, u32, Vec<(u32, u32)>) {
    let mut max_col = 0u32;
    let mut max_row = 0u32;
    let mut positions = Vec::with_capacity(indices.len());
    for &i in indices {
        let (col, row) = gnomon_position(i);
        max_col = max_col.max(col);
        max_row = max_row.max(row);
        positions.push((col, row));
    }
    let cols = if indices.is_empty() { 0 } else { max_col + 1 };
    let rows = if indices.is_empty() { 0 } else { max_row + 1 };
    (cols, rows, positions)
}

/// The smallest cell index not present in `occupied` — a district's "next
/// free plot" (spec §4.2), and the index a brand-new file is given.
/// `occupied` is a `BTreeSet`, so this is a single linear scan of its sorted
/// values looking for the first gap (or, if there is none, the value one
/// past the end) — proportional to how many cells are occupied, not to the
/// size of any individual index.
fn lowest_free(occupied: &std::collections::BTreeSet<usize>) -> usize {
    let mut expected = 0usize;
    for &value in occupied {
        if value != expected {
            break;
        }
        expected += 1;
    }
    expected
}

/// Resolves one district's `path -> cell index` map for its CURRENT files
/// (`sorted_paths`, already sorted by path), given what `LayoutCache`
/// remembered last time (`existing`) — the heart of fix round 4 (module
/// doc). A path still present keeps its old index exactly, regardless of
/// where it now falls in sorted order. A path no longer present is simply
/// left out of the returned map — its index is released immediately, not
/// carried forward (see the module doc's "release immediately" note). A
/// brand-new path is assigned the lowest free index, processed in sorted-
/// path order so that when several files appear in the same call the
/// assignment is still deterministic.
fn resolve_cells(existing: &BTreeMap<String, usize>, sorted_paths: &[&String]) -> BTreeMap<String, usize> {
    let mut cells: BTreeMap<String, usize> = BTreeMap::new();
    let mut occupied: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();

    // Every still-present path keeps its existing cell exactly.
    for &path in sorted_paths {
        if let Some(&cell) = existing.get(path) {
            cells.insert(path.clone(), cell);
            occupied.insert(cell);
        }
    }
    // Every brand-new path takes the lowest cell not already occupied,
    // in sorted-path order.
    for &path in sorted_paths {
        if !cells.contains_key(path) {
            let cell = lowest_free(&occupied);
            occupied.insert(cell);
            cells.insert(path.clone(), cell);
        }
    }
    cells
}

/// One district's plot, fully sized and with every building's position
/// relative to the plot's own origin — computed before any packing, so a
/// district's shape depends only on its own resolved cell assignments.
struct DistrictPlan {
    /// The EXACT minimum footprint for the district's current cell
    /// assignments — used to decide whether a cached plot still fits (fix
    /// round 2). Deliberately not padded: the fits-or-not check must
    /// reflect real, current demand.
    width: u32,
    depth: u32,
    /// The footprint a FRESHLY established plot (a brand-new district, or
    /// one relocating after outgrowing its old one) is actually given —
    /// sized as if one more file had already claimed the district's next
    /// free cell. See the module doc's "headroom" note: this is what makes
    /// adding a single file the common case that never needs another
    /// resize, without padding the fits-or-not check itself.
    roomy_width: u32,
    roomy_depth: u32,
    /// Parallel to the district's buildings in ASCENDING cell-index order:
    /// original building index (into `model.districts[i].buildings`)
    /// paired with its position relative to the plot origin.
    buildings: Vec<(usize, i32, i32)>,
    /// This district's resolved `path -> cell index` map — every currently
    /// present file, released files already dropped, new files already
    /// assigned — threaded back into the returned `LayoutCache` by
    /// `layout_with_cache`.
    cells: BTreeMap<String, usize>,
}

fn plan_district(district_index: usize, model: &CityModel, existing_cells: &BTreeMap<String, usize>) -> DistrictPlan {
    let district = &model.districts[district_index];

    // Sorted only to give deterministic order to BRAND-NEW cell
    // assignments (see `resolve_cells`) — a building's actual cell, once
    // assigned, never depends on this order again.
    let mut order: Vec<usize> = (0..district.buildings.len()).collect();
    order.sort_by(|&a, &b| district.buildings[a].path.cmp(&district.buildings[b].path));
    let sorted_paths: Vec<&String> = order.iter().map(|&i| &district.buildings[i].path).collect();

    let cells = resolve_cells(existing_cells, &sorted_paths);

    // The next free cell after `cells` is resolved: what a hypothetical
    // additional file would get right now. Used only for `roomy_*`
    // headroom below.
    let occupied: std::collections::BTreeSet<usize> = cells.values().copied().collect();
    let next_free = lowest_free(&occupied);

    let mut order_by_cell: Vec<usize> = (0..district.buildings.len()).collect();
    order_by_cell.sort_by_key(|&i| cells[&district.buildings[i].path]);
    let indices: Vec<usize> =
        order_by_cell.iter().map(|&i| cells[&district.buildings[i].path]).collect();

    let (cols, rows, grid) = grid_of_indices(&indices);
    let width = footprint_extent(cols);
    let depth = footprint_extent(rows);

    let mut headroom_indices = indices.clone();
    headroom_indices.push(next_free);
    let (headroom_cols, headroom_rows, _) = grid_of_indices(&headroom_indices);
    let roomy_width = footprint_extent(headroom_cols);
    let roomy_depth = footprint_extent(headroom_rows);

    let buildings = order_by_cell
        .into_iter()
        .zip(grid)
        .map(|(building_index, (col, row))| {
            let x = MARGIN + col as i32 * SPACING;
            let z = MARGIN + row as i32 * SPACING;
            (building_index, x, z)
        })
        .collect();

    DistrictPlan {
        width,
        depth,
        roomy_width,
        roomy_depth,
        buildings,
        cells,
    }
}

/// The plot's boundary cells (its perimeter, one cell thick), for the
/// renderer to draw as streets.
fn boundary_cells(plot: &Plot) -> Vec<(i32, i32)> {
    let x0 = plot.x;
    let x1 = plot.x + plot.w as i32 - 1;
    let z0 = plot.z;
    let z1 = plot.z + plot.d as i32 - 1;

    let mut cells = Vec::new();
    for x in x0..=x1 {
        cells.push((x, z0));
        if z1 != z0 {
            cells.push((x, z1));
        }
    }
    // Corners already emitted above; only the strictly-interior edge cells
    // remain for the vertical sides.
    for z in (z0 + 1)..z1 {
        cells.push((x0, z));
        if x1 != x0 {
            cells.push((x1, z));
        }
    }
    cells
}

/// NOT the real entry point — see `layout_city_persisted` below for that.
/// This lays out `model` onto a road grid with NO memory of any previous
/// call: districts sorted by path, each a rectangular plot sized from its
/// own building count, shelf-packed left to right into rows bounded wide
/// enough to keep the whole city roughly square. See the module docs for
/// why a building's position is stable across model growth even here —
/// but note a DISTRICT's plot is not: this recomputes every plot from
/// scratch on every call, so inserting a district that sorts before an
/// existing one reshuffles everything after it.
///
/// This exists (rather than being folded away entirely) so every test that
/// only cares about the pure packing algorithm — determinism, no overlap,
/// buildings-stay-inside-their-plot, bigger-district-bigger-plot — can call
/// it directly with no cache and no disk I/O. Production code, and Task
/// 5/6's renderer, should call `layout_city_persisted` instead.
///
/// `#[cfg(test)]` rather than merely documented (fix round 4, SMALL 2):
/// this plainer name is the reshuffling one and is easy to reach for by
/// mistake, so it does not exist at all outside test builds — a compiler
/// error is a stronger guarantee than a doc comment that Task 5/6 cannot
/// wire in the wrong function.
#[cfg(test)]
pub(crate) fn layout_city(model: &CityModel) -> CityLayout {
    layout_with_cache(model, &LayoutCache::default()).0
}

/// True if `a` and `b`, as axis-aligned grid rectangles, share any cell.
fn plots_overlap(a: &Plot, b: &Plot) -> bool {
    let disjoint = a.x + a.w as i32 <= b.x
        || b.x + b.w as i32 <= a.x
        || a.z + a.d as i32 <= b.z
        || b.z + b.d as i32 <= a.z;
    !disjoint
}

/// Bucket size for `SpatialIndex`: comfortably larger than the largest
/// footprint a real plot ever gets (`MAX_BUILDINGS_PER_DISTRICT` caps a
/// roomy plot well under this many cells per side), so a typical plot
/// touches only one or a few buckets, keeping insert/query near O(1).
const SPATIAL_BUCKET: i32 = 32;

fn bucket_span(coord: i32, extent: u32) -> (i32, i32) {
    let start = coord.div_euclid(SPATIAL_BUCKET);
    let end = (coord + extent as i32 - 1).div_euclid(SPATIAL_BUCKET);
    (start, end)
}

/// A coarse grid index over every plot placed so far in one
/// `layout_with_cache` call, so "does this candidate overlap anything"
/// stays close to O(1) regardless of how many districts the repo has or
/// how many of them need the check in the same call (fix round 3 — see the
/// module doc's account of why round 2's `BTreeMap`-scanning checks were
/// both incorrect AND quadratic). Never removes an entry.
///
/// For a GROWTH, the stale pre-growth rectangle is always fully contained
/// in that district's own grown one, so leaving it in the index can only
/// ever agree with a real overlap, never miss one. For a RELOCATION,
/// that's not true — the vacated rectangle is NOT contained in the new
/// one, so it stays in the index as an uncontained stale entry. This is
/// still safe, for a different reason: a stale entry can only ever cause
/// `overlaps_excluding` to reject a candidate that would otherwise be
/// accepted (a false "occupied"), never accept one that's actually
/// occupied (a false "free") — and `Frontier.cur_z` only ever increases
/// within a call, so a vacated rectangle behind the frontier is never
/// re-proposed as a candidate in the first place. At worst, a stale
/// relocation entry makes some later allocation pessimistically skip a
/// technically-free cell; it can never let two plots overlap.
#[derive(Default)]
struct SpatialIndex {
    buckets: std::collections::HashMap<(i32, i32), Vec<Plot>>,
}

impl SpatialIndex {
    fn insert(&mut self, plot: &Plot) {
        let (bx0, bx1) = bucket_span(plot.x, plot.w);
        let (bz0, bz1) = bucket_span(plot.z, plot.d);
        for bx in bx0..=bx1 {
            for bz in bz0..=bz1 {
                self.buckets.entry((bx, bz)).or_default().push(plot.clone());
            }
        }
    }

    /// True if `candidate` overlaps anything indexed, ignoring at most one
    /// value-equal entry (`exclude`) — used by the growth check to skip a
    /// district's own pre-growth plot (which the grown candidate always
    /// contains, and so would always "overlap") without needing plot
    /// identity.
    fn overlaps_excluding(&self, candidate: &Plot, exclude: Option<&Plot>) -> bool {
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

    /// Every plot ever inserted, including stale entries a growth or
    /// relocation superseded — used only to compute the reported city
    /// extent (fix round 4, SMALL 3), where a relocation's now-vacated
    /// rectangle should still count: it's real, previously-reported
    /// footprint, and letting it silently shrink out of `CityLayout`'s
    /// extent would be the same "the box shrank even though nothing you
    /// can see moved" bug the cached-extent fix (round 3) exists to
    /// prevent. May yield the same value more than once (a plot spanning
    /// several buckets, or a district's stale-and-current entries both
    /// present) — harmless for a max-based fold.
    fn all_plots(&self) -> impl Iterator<Item = &Plot> {
        self.buckets.values().flatten()
    }
}

/// Allocates a fresh `(width, depth)` plot: proposes the frontier's next
/// slot, and if `index` says that collides with anything placed so far,
/// forces a further row wrap and tries again (termination is guaranteed
/// since `z` strictly increases on every forced wrap and any repo is
/// finite). Used uniformly for both a brand-new district and a district
/// relocating after outgrowing its cached plot — the `SpatialIndex` check
/// is what makes both cases safe to run unconditionally without
/// reintroducing round 2's O(districts²) blowup (see the module doc).
fn allocate_free_plot(frontier: &mut Frontier, index: &SpatialIndex, width: u32, depth: u32) -> Plot {
    loop {
        if frontier.row_has_item && (frontier.cur_x as u32 + width) > frontier.target_row_width {
            frontier.cur_z += frontier.row_height as i32;
            frontier.cur_x = 0;
            frontier.row_height = 0;
            frontier.row_has_item = false;
        }
        let candidate = Plot { x: frontier.cur_x, z: frontier.cur_z, w: width, d: depth };
        if index.overlaps_excluding(&candidate, None) {
            frontier.cur_z += frontier.row_height.max(depth) as i32;
            frontier.cur_x = 0;
            frontier.row_height = 0;
            frontier.row_has_item = false;
            continue;
        }
        frontier.cur_x += width as i32;
        frontier.row_height = frontier.row_height.max(depth);
        frontier.row_has_item = true;
        return candidate;
    }
}

/// Builds the `PlacedDistrict` for `district_index`, given its `plan` and
/// resolved `plot`.
fn build_placed_district(
    district_index: usize,
    plan: &DistrictPlan,
    plot: Plot,
    model: &CityModel,
) -> PlacedDistrict {
    let buildings: Vec<PlacedBuilding> = plan
        .buildings
        .iter()
        .map(|&(building_index, lx, lz)| {
            let height = model.districts[district_index].buildings[building_index].height;
            PlacedBuilding { building_index, x: plot.x + lx, z: plot.z + lz, height }
        })
        .collect();
    let road_edges = boundary_cells(&plot);
    PlacedDistrict { district_index, plot, buildings, road_edges }
}

/// The cache-aware core. For a district still present in `cache`:
/// - if its cached plot still holds its current building count (grew a
///   little within existing slack, stayed the same, or shrank), reuse it
///   exactly, unchanged;
/// - if it no longer fits, try to grow the plot in place (same top-left
///   corner, larger width/depth) — accepted only if the larger rectangle
///   doesn't overlap any other district's plot;
/// - if growing in place would overlap something, relocate that ONE
///   district to a fresh plot appended to the packing frontier. Every
///   other district — grown, reused, or an innocent neighbor that merely
///   blocked the growth — stays exactly where it was.
///
/// A brand-new district (not in `cache`) is allocated a fresh plot from
/// the frontier the same way a relocation is — both go through
/// `allocate_free_plot`, which checks against a `SpatialIndex` covering
/// every plot placed so far this call (fix round 3: the frontier's own
/// "always ahead of everything" assumption doesn't survive a phase-1
/// growth, so every allocation is now index-checked, not just the ones
/// round 2 guessed needed it). A district's cached plot that no longer
/// appears in `model` is left untouched in the returned cache — an honest
/// hole, not compacted away, so a same-path district reappearing later
/// reclaims it exactly.
///
/// Pure aside from taking the cache as data: no disk I/O happens here (see
/// `layout_city_persisted` for that). With an empty cache
/// (`LayoutCache::default()`), every district counts as "new" and this
/// reduces to one pass of frontier allocation in sorted-by-path order —
/// exactly what `layout_city` has always computed.
pub fn layout_with_cache(model: &CityModel, cache: &LayoutCache) -> (CityLayout, LayoutCache) {
    let mut plans: Vec<(usize, DistrictPlan)> = (0..model.districts.len())
        .map(|i| {
            let key = &model.districts[i].cache_key;
            let existing_cells = cache.cells.get(key).cloned().unwrap_or_default();
            (i, plan_district(i, model, &existing_cells))
        })
        .collect();
    plans.sort_by(|(a, _), (b, _)| model.districts[*a].path.cmp(&model.districts[*b].path));

    // Every district's resolved cell map — including a district absent
    // from `model` this call, carried over untouched from `cache`, the same
    // "never evicted" treatment its `Plot` gets (see the module doc's fix
    // round 4). Keyed by `cache_key`, not `path` (fix round 5): this is what
    // lets `dir#1` inherit `dir`'s per-file cells across a split boundary
    // crossing — see `model::split_into_plots`'s doc comment.
    let mut cells_map = cache.cells.clone();
    for (i, plan) in &plans {
        cells_map.insert(model.districts[*i].cache_key.clone(), plan.cells.clone());
    }

    let mut plots = cache.plots.clone();
    let mut frontier = if cache.plots.is_empty() {
        // Bound row width so the city stays roughly square: a perfectly
        // packed square holding all plots' combined (roomy, headroom-
        // included) area is the target, floored at the widest single plot
        // so that plot always fits somewhere. Chosen once, here, and never
        // recomputed afterwards — see the `Frontier` doc comment for why.
        let total_area: u64 =
            plans.iter().map(|(_, p)| p.roomy_width as u64 * p.roomy_depth as u64).sum();
        let max_width = plans.iter().map(|(_, p)| p.roomy_width).max().unwrap_or(1);
        let target_row_width = ((total_area as f64).sqrt().ceil() as u32).max(max_width).max(1);
        Frontier { target_row_width, ..Frontier::default() }
    } else {
        cache.frontier.clone()
    };

    // Seeded with every plot the cache already knows about, then kept
    // current as each district is resolved below — see the `SpatialIndex`
    // doc comment for why every collision check in this function queries
    // this instead of scanning `plots` directly.
    let mut index = SpatialIndex::default();
    for plot in cache.plots.values() {
        index.insert(plot);
    }

    let mut resolved: Vec<Option<PlacedDistrict>> = (0..plans.len()).map(|_| None).collect();

    // Phase 1: districts with an existing cached plot — reuse, grow in
    // place, or relocate. Looked up (and re-inserted) by `cache_key`, not
    // `path` (fix round 5) — see `model::split_into_plots`'s doc comment:
    // this is what makes `dir#1` reuse/grow/relocate `dir`'s own cached
    // plot instead of being treated as brand-new the instant a directory
    // crosses `MAX_BUILDINGS_PER_DISTRICT`.
    for (slot, (district_index, plan)) in plans.iter().enumerate() {
        let key = &model.districts[*district_index].cache_key;
        let Some(cached_plot) = cache.plots.get(key) else { continue };

        let plot = if cached_plot.w >= plan.width && cached_plot.d >= plan.depth {
            cached_plot.clone()
        } else {
            // Outgrew its cached footprint: the smallest rectangle,
            // anchored at the same top-left corner, that contains both the
            // old footprint and the new requirement.
            let candidate = Plot {
                x: cached_plot.x,
                z: cached_plot.z,
                w: cached_plot.w.max(plan.width),
                d: cached_plot.d.max(plan.depth),
            };
            let blocked = index.overlaps_excluding(&candidate, Some(cached_plot));
            if blocked {
                allocate_free_plot(&mut frontier, &index, plan.roomy_width, plan.roomy_depth)
            } else {
                candidate
            }
        };

        index.insert(&plot);
        plots.insert(key.clone(), plot.clone());
        resolved[slot] = Some(build_placed_district(*district_index, plan, plot, model));
    }

    // Phase 2: brand-new districts, appended to the frontier — same
    // index-checked allocator as a relocation. Cheap even at thousands of
    // districts per call (a from-scratch layout of a large repo) because
    // `SpatialIndex` queries are near-O(1), not a scan of every plot.
    for (slot, (district_index, plan)) in plans.iter().enumerate() {
        let key = &model.districts[*district_index].cache_key;
        if cache.plots.contains_key(key) {
            continue;
        }
        let plot = allocate_free_plot(&mut frontier, &index, plan.roomy_width, plan.roomy_depth);
        index.insert(&plot);
        plots.insert(key.clone(), plot.clone());
        resolved[slot] = Some(build_placed_district(*district_index, plan, plot, model));
    }

    let districts: Vec<PlacedDistrict> =
        resolved.into_iter().map(|d| d.expect("every district resolved in phase 1 or 2")).collect();

    // The reported extent is the CACHED footprint — including a vanished
    // district's hole AND a relocated district's now-vacated old
    // rectangle (fix round 4, SMALL 3: `plots` alone loses the vacated
    // rectangle the moment `plots.insert` overwrites that path with its
    // new location, so this reads from `index` instead, which never drops
    // anything) — not just the presently-visible districts. Otherwise
    // deleting or relocating whatever district happens to sit at the
    // city's far edge would shrink `width`/`depth`, and a fit-to-view
    // camera in Task 5/6 would visibly rescale the entire city even though
    // every remaining plot stayed exactly put — the opposite of "it never
    // rearranges."
    let mut city_width: u32 = 0;
    let mut city_depth: u32 = 0;
    for plot in index.all_plots() {
        city_width = city_width.max((plot.x + plot.w as i32).max(0) as u32);
        city_depth = city_depth.max((plot.z + plot.d as i32).max(0) as u32);
    }

    // `split_membership` is not this function's to compute (fix round 6,
    // module doc): by the time `model: &CityModel` exists, every
    // directory's split-slot membership has already been decided by
    // `model::build_city_with_membership`. Carried through unchanged so a
    // caller that still builds its model with the stateless `build_city`
    // (every existing test, and any not-yet-migrated caller) can never
    // silently wipe a persisted repo's membership just by calling this
    // function.
    let updated_cache = LayoutCache {
        version: LAYOUT_CACHE_VERSION,
        plots,
        frontier,
        cells: cells_map,
        split_membership: cache.split_membership.clone(),
    };
    let layout = CityLayout { districts, width: city_width, depth: city_depth, grid_pitch: SPACING };
    (layout, updated_cache)
}

/// A small, fully-specified 64-bit hash (FNV-1a) for filesystem-facing
/// identifiers that must survive a Rust toolchain upgrade unchanged.
///
/// Minor 4 (Phase 0.5b final-fix review): `std::collections::hash_map::
/// DefaultHasher` used to be hashed here instead. Its docs are explicit
/// that its algorithm is an implementation detail with NO stability
/// guarantee across Rust releases — a toolchain upgrade could silently
/// change every digest it produces, which for `cache_path` means orphaning
/// every cached town layout and reshuffling every open city at once, with
/// no visible cause and no version to bump (`LAYOUT_CACHE_VERSION` guards
/// against a MODEL-shape change, not a hash-algorithm change out from
/// under it). FNV-1a is instead fully specified right here: same input,
/// same digest, on any Rust version, forever — a dependency was
/// deliberately not added for this; the whole algorithm is nine lines.
fn stable_hash(bytes: &[u8]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Path to `root_norm`'s persisted layout cache, spec §4.2:
/// `~/.age-of-agents/towns/<repo-hash>.json`. Split out from `cache_path`
/// (fix round 6) so `layout_city_persisted_from_root` can resolve the cache
/// file BEFORE a `CityModel` exists at all — see that function's doc
/// comment for why the ordering matters. `root_norm` must already be
/// normalized (`world::repo::normalize_path`); deliberately not
/// canonicalizing a second time here: an independent second normalization
/// of the same root has caused real bugs elsewhere in this codebase (see
/// `world::repo`) whenever the two disagreed.
fn cache_path_for_root(root_norm: &Path) -> PathBuf {
    let hash = stable_hash(root_norm.to_string_lossy().as_bytes());
    crate::config::data_path("towns").join(format!("{hash:016x}.json"))
}

/// Path to `model`'s persisted layout cache — see `cache_path_for_root`.
/// `model.root` is already normalized (`build_city` does that), so this is
/// just that function applied to it.
fn cache_path(model: &CityModel) -> PathBuf {
    cache_path_for_root(Path::new(&model.root))
}

/// Lays out `model` with spec §4.2's persisted memory: loads this repo's
/// cache from `~/.age-of-agents/towns/<repo-hash>.json` (degrading to a
/// fresh layout on any missing/corrupt/implausible/foreign-version file —
/// see `LayoutCache::load`), lays out via `layout_with_cache`, and
/// best-effort writes the updated cache back. A failure to WRITE the cache
/// is swallowed: the layout this call returns is correct regardless, it
/// just won't be remembered for next time. `layout_city` (no persistence)
/// exists only for tests that want the pure packing algorithm with no disk
/// I/O; it reshuffles on every call by design and must never be wired into
/// the actual app.
///
/// **Superseded by `layout_city_persisted_from_root` for anything that
/// still needs to BUILD a model (fix round 6, module doc):** this function
/// only lays out a `CityModel` that already exists, which means whoever
/// built it (via the stateless `build_city`) already decided — positionally
/// — which numbered slot each of its over-full directories' files landed
/// in, with no persisted membership available at that point. This function
/// cannot retroactively fix that: a `District`'s buildings are fixed by the
/// time it runs. Kept for callers that only ever lay out (never rebuild)
/// a model, and for every test in this module that wants the growth/
/// relocation machinery without a real `FileSource`/disk round-trip.
///
/// Important 3 (Phase 0.5b final-fix review): the cache is only ever
/// WRITTEN when `model.source == CitySource::Git` — i.e. `RealFiles` got
/// git's own honest file list. `CitySource::Walk` means this run is a
/// degraded, best-effort filesystem guess (no git repo, `git` missing, an
/// `RealGitFiles` timeout), which can see a materially different set of
/// districts (gitignored build output, `.env` files, generated sources)
/// than a healthy run ever would. The cache is append-only and keyed by
/// path — a district absent from a LATER model just leaves its cached
/// `Plot` behind as an honest "might come back" hole (see `LayoutCache`'s
/// own doc comment) — so writing a degraded run's phantom districts into
/// it would bake permanent, un-vacatable holes into every subsequent
/// HEALTHY run's reported extent, exactly the condition
/// `LAYOUT_CACHE_VERSION` was bumped 1 -> 2 to clear once already, now
/// reachable again at runtime with no version left to bump this time.
/// Simply never persisting a degraded run is the obvious fix: the layout
/// this call returns is still correct for THIS render either way (read-
/// only cache use is unaffected), it just isn't remembered — exactly the
/// same "best-effort, not guaranteed" contract a plain save failure
/// already has, just triggered by the source instead of an I/O error.
pub fn layout_city_persisted(model: &CityModel) -> CityLayout {
    let path = cache_path(model);
    // Opus review, IMPORTANT 1: the WHOLE load-compute-save cycle is
    // serialized per cache path (see `cache_io::with_cache_lock`'s doc
    // comment), not just the final write — otherwise two overlapping calls
    // for the same repo could each load a stale cache, compute in memory,
    // and the second save would silently discard the first's update even
    // though each write is individually atomic.
    crate::cache_io::with_cache_lock(&path, || {
        let cache = LayoutCache::load(&path);
        let (layout, updated_cache) = layout_with_cache(model, &cache);
        if should_persist(model) {
            let _ = updated_cache.save(&path);
        }
        layout
    })
}

/// THE REAL ENTRY POINT (fix round 6) — call this, not the `build_city` +
/// `layout_city_persisted` pair, from anywhere that builds a city from a
/// live `FileSource` (Task 5/6's renderer, the archipelago sea view, the
/// dev preview binaries). Loads this repo's `LayoutCache` FIRST — before
/// the model is even built — so `model::build_city_with_membership` has
/// the persisted split-slot membership available while it is still
/// deciding how to divide each over-full directory, the same memory
/// `cells`/`plots` already give the layout half of this problem. See the
/// module doc's "Fix round 6" section for why this ordering is not
/// optional: once a `CityModel` exists, its directories are already
/// partitioned into fixed `District` entries, and nothing downstream can
/// move a `Building` from one `District` to another after the fact.
///
/// Returns the built `CityModel` alongside its `CityLayout` — everything a
/// caller needs, since building the model was previously a separate call
/// callers made themselves.
pub fn layout_city_persisted_from_root(root: &Path, walker: &dyn FileSource) -> (CityModel, CityLayout) {
    let root_norm = normalize_path(root);
    let path = cache_path_for_root(&root_norm);
    // Opus review, IMPORTANT 1: see `layout_city_persisted`'s identical
    // comment — the whole load-compute-save cycle is serialized per cache
    // path, not just the final write, so two overlapping resolutions of the
    // SAME repo (e.g. two overlapping archipelago scans) can never lose one
    // update to the other.
    crate::cache_io::with_cache_lock(&path, || {
        let cache = LayoutCache::load(&path);
        let (model, split_membership) = build_city_with_membership(root, walker, &cache.split_membership);
        let (layout, mut updated_cache) = layout_with_cache(&model, &cache);
        updated_cache.split_membership = split_membership;
        if should_persist(&model) {
            let _ = updated_cache.save(&path);
        }
        (model, layout)
    })
}

/// Whether `layout_city_persisted` should write its updated cache back to
/// disk for `model` — see that function's doc comment (Important 3) for
/// why a degraded (`CitySource::Walk`) run must not. Pulled out as its own
/// pure function (rather than an inline condition) specifically so this
/// decision is testable with a bare `CityModel` value and no filesystem
/// involved at all — `cache_path` always resolves against the user's real
/// `~/.age-of-agents`, which a unit test should not need to touch just to
/// prove this one gate is correct.
fn should_persist(model: &CityModel) -> bool {
    model.source == CitySource::Git
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::model::{build_city, CityModel, FileSource};
    use std::path::{Path, PathBuf};

    struct FakeFiles(Vec<(String, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0
                .iter()
                .map(|(p, n)| (PathBuf::from(p), Some(*n)))
                .collect()
        }
    }

    fn model_of(paths: &[(&str, u32)]) -> CityModel {
        let files = FakeFiles(paths.iter().map(|(p, n)| (p.to_string(), *n)).collect());
        build_city(Path::new("/p/api"), &files)
    }

    /// Important 3 (Phase 0.5b final-fix review): `should_persist` is the
    /// gate that stops a degraded (`CitySource::Walk`) build's phantom
    /// districts from being written into a healthy repo's permanent
    /// layout cache. `FakeFiles`'s default `FileSource::source` is `Git`
    /// (see `model::FileSource::source`'s doc comment), so `model_of`'s
    /// output already covers the healthy case honestly.
    #[test]
    fn should_persist_is_true_for_a_healthy_git_sourced_model_and_false_for_a_degraded_walk_one() {
        let git_model = model_of(&[("/p/api/src/a.rs", 10)]);
        assert_eq!(git_model.source, CitySource::Git);
        assert!(should_persist(&git_model), "a healthy git-sourced model must be persisted");

        let mut walk_model = git_model;
        walk_model.source = CitySource::Walk;
        assert!(
            !should_persist(&walk_model),
            "a degraded filesystem-walk model must never be persisted — it could poison the \
             cache with districts a healthy run would never have produced"
        );
    }

    /// Minor 4 (Phase 0.5b final-fix review): `stable_hash` replaced
    /// `DefaultHasher` specifically because its output must never change
    /// across a Rust toolchain upgrade. This pins the actual digest for a
    /// representative input — if this ever fails, `stable_hash` was
    /// changed in a way that breaks that promise (a real regression, not a
    /// stale test), which is exactly what a plain "hash twice, compare"
    /// test would fail to catch.
    #[test]
    fn stable_hash_is_deterministic_and_pinned_to_a_known_digest() {
        assert_eq!(stable_hash(b"/p/api"), stable_hash(b"/p/api"));
        assert_ne!(
            stable_hash(b"/p/api"),
            stable_hash(b"/p/apx"),
            "different inputs should (overwhelmingly likely) hash differently"
        );
        // FNV-1a of b"/p/api", computed independently of this
        // implementation, pinned so an accidental algorithm change is
        // caught even though it would still be "deterministic".
        assert_eq!(stable_hash(b"/p/api"), 0x1eea_0be7_2908_f6b5);
    }

    #[test]
    fn the_same_model_always_lays_out_identically() {
        let model = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10)]);
        let first = layout_city(&model);
        let second = layout_city(&model);
        assert_eq!(first, second);
    }

    /// Reviewer note on the original determinism test: calling `layout_city`
    /// twice on the SAME `CityModel` value wouldn't catch a per-process-fixed
    /// random seed, since both calls would inherit it identically. Not a
    /// live bug here (`layout_city` uses no seed at all), but this pins
    /// determinism across two INDEPENDENTLY constructed inputs instead, so
    /// the test actually exercises what it claims to.
    #[test]
    fn determinism_holds_across_independently_built_equal_models() {
        let spec: &[(&str, u32)] = &[("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10)];
        let model_a = model_of(spec);
        let model_b = model_of(spec);
        assert_eq!(layout_city(&model_a), layout_city(&model_b));
    }

    #[test]
    fn districts_do_not_overlap() {
        let model = model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/web/b.ts", 10),
            ("/p/api/docs/c.md", 10),
            ("/p/api/infra/d.tf", 10),
        ]);
        let layout = layout_city(&model);
        for (i, a) in layout.districts.iter().enumerate() {
            for b in layout.districts.iter().skip(i + 1) {
                let disjoint = a.plot.x + a.plot.w as i32 <= b.plot.x
                    || b.plot.x + b.plot.w as i32 <= a.plot.x
                    || a.plot.z + a.plot.d as i32 <= b.plot.z
                    || b.plot.z + b.plot.d as i32 <= a.plot.z;
                assert!(disjoint, "plots overlap: {:?} vs {:?}", a.plot, b.plot);
            }
        }
    }

    /// THE point of this whole change: two buildings that are adjacent in
    /// gnomon order (indices 0 and 1, which `gnomon_position` always places
    /// at `(0,0)` and `(1,0)` — same row, next column) must sit exactly one
    /// grid cell apart, not two. Two cells apart is the old, sparse `SPACING
    /// = 2` pitch this change exists to remove — a district built from that
    /// pitch reads as detached objects with a permanently empty street
    /// between every pair of buildings rather than as one solid block. This
    /// asserts the actual coordinates, not just "no overlap", because two
    /// buildings can fail to overlap (they're both 1x1 points) at any
    /// spacing at all — only the exact gap distinguishes "abutting" from
    /// "scattered".
    #[test]
    fn adjacent_buildings_in_a_district_abut_with_no_gap_cell_between_them() {
        let model = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 10)]);
        let layout = layout_city(&model);
        let buildings = &layout.districts[0].buildings;
        assert_eq!(buildings.len(), 2);
        let (a, b) = (&buildings[0], &buildings[1]);
        assert_eq!(a.z, b.z, "gnomon indices 0 and 1 share a row");
        assert_eq!(
            (b.x - a.x).abs(),
            SPACING,
            "adjacent buildings must be exactly SPACING cells apart, with no empty cell between them"
        );
    }

    /// Weaker version, kept only as a sanity check on the trivial append
    /// case: with NO shared cache, appending a file that sorts LAST doesn't
    /// even need fix round 4 to pass, because sorted position and stable
    /// identity happen to agree when nothing earlier-sorting is involved.
    /// See `an_early_sorting_file_added_to_a_cached_district_does_not_move_existing_buildings`
    /// below for the actual regression test — this one alone is exactly the
    /// guarding test the followups doc called out as testing only the case
    /// that already worked.
    #[test]
    fn adding_a_file_never_moves_an_existing_building() {
        let before = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/src/b.rs", 10),
        ]));
        let after = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/src/b.rs", 10),
            ("/p/api/src/c.rs", 10),
        ]));

        // a.rs and b.rs must sit exactly where they did.
        let first_two = |l: &CityLayout| -> Vec<(i32, i32)> {
            l.districts[0]
                .buildings
                .iter()
                .take(2)
                .map(|b| (b.x, b.z))
                .collect()
        };
        assert_eq!(first_two(&before), first_two(&after));
    }

    /// THE regression test for fix round 4: adding a file that sorts BEFORE
    /// existing files in its district — through the real, cache-threaded
    /// entry point a returning user's city actually uses — must not move
    /// either existing building. Fails against the pre-fix code exactly as
    /// the module doc and the followups entry describe: with
    /// `src/{b.rs,c.rs}` cached at gnomon indices `0,1`, adding `src/a.rs`
    /// used to renumber both of them to `1,2`.
    #[test]
    fn an_early_sorting_file_added_to_a_cached_district_does_not_move_existing_buildings() {
        fn position_of(model: &CityModel, layout: &CityLayout, suffix: &str) -> (i32, i32) {
            let district = &layout.districts[0];
            district
                .buildings
                .iter()
                .find(|pb| model.districts[0].buildings[pb.building_index].path.ends_with(suffix))
                .map(|pb| (pb.x, pb.z))
                .unwrap_or_else(|| panic!("no building ending with {suffix:?}"))
        }

        let before = model_of(&[("/p/api/src/b.rs", 10), ("/p/api/src/c.rs", 10)]);
        let (layout_before, cache) = layout_with_cache(&before, &LayoutCache::default());
        let b_before = position_of(&before, &layout_before, "b.rs");
        let c_before = position_of(&before, &layout_before, "c.rs");

        // src/a.rs sorts before both existing files.
        let after = model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/src/b.rs", 10),
            ("/p/api/src/c.rs", 10),
        ]);
        let (layout_after, _cache_after) = layout_with_cache(&after, &cache);
        let b_after = position_of(&after, &layout_after, "b.rs");
        let c_after = position_of(&after, &layout_after, "c.rs");

        assert_eq!(b_before, b_after, "b.rs must not move when an earlier-sorting file is added");
        assert_eq!(c_before, c_after, "c.rs must not move when an earlier-sorting file is added");
    }

    #[test]
    fn adding_a_district_never_moves_an_existing_one() {
        let before = layout_city(&model_of(&[("/p/api/src/a.rs", 10)]));
        let after = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/zzz/b.rs", 10),
        ]));
        assert_eq!(before.districts[0].plot, after.districts[0].plot);
    }

    #[test]
    fn buildings_stay_inside_their_plot() {
        let model = model_of(&[
            ("/p/api/src/a.rs", 10),
            ("/p/api/src/b.rs", 10),
            ("/p/api/src/c.rs", 10),
        ]);
        let layout = layout_city(&model);
        for district in &layout.districts {
            for b in &district.buildings {
                assert!(b.x >= district.plot.x && b.x < district.plot.x + district.plot.w as i32);
                assert!(b.z >= district.plot.z && b.z < district.plot.z + district.plot.d as i32);
            }
        }
    }

    #[test]
    fn a_bigger_district_gets_a_bigger_plot() {
        let small = model_of(&[("/p/api/src/a.rs", 10)]);
        // Distinct paths, not the same path repeated: cells are keyed by
        // path (fix round 4), so 20 buildings sharing one path would
        // collapse to a single cell instead of exercising a genuinely
        // bigger district.
        let big: Vec<(String, u32)> = (0..20).map(|i| (format!("/p/api/src/f{i}.rs"), 10)).collect();
        let small_plot = layout_city(&small).districts[0].plot.clone();
        let big_plot = layout_city(&model_of_strings(&big)).districts[0].plot.clone();
        assert!(big_plot.w * big_plot.d > small_plot.w * small_plot.d);
    }

    /// Stronger version of the invariant the brief's own test only checks
    /// at one transition (2 -> 3 buildings): a building's grid position
    /// must depend only on its own index, never on how many buildings the
    /// district ends up with. If this ever regresses to a naive
    /// `row = i / ceil(sqrt(n))` scheme, this test catches the cases the
    /// brief's narrower one would miss (e.g. 4 -> 5, which crosses a
    /// perfect-square boundary).
    #[test]
    fn every_prefix_of_buildings_keeps_its_positions_as_more_are_added() {
        let max_n = 40;
        // Distinct, zero-padded paths (not one path repeated `n` times):
        // cells are keyed by path (fix round 4), so duplicate paths would
        // collapse to a single cell. Threaded through a real cache, one
        // file at a time, the way a repo actually grows.
        let mut cache = LayoutCache::default();
        let mut previous_positions: Vec<(i32, i32)> = Vec::new();
        for n in 1..=max_n {
            let files: Vec<(String, u32)> =
                (0..n).map(|i| (format!("/p/api/src/f{i:03}.rs"), 10)).collect();
            let (layout, new_cache) = layout_with_cache(&model_of_strings(&files), &cache);
            let positions: Vec<(i32, i32)> = layout.districts[0]
                .buildings
                .iter()
                .map(|b| (b.x, b.z))
                .collect();
            assert_eq!(
                positions[..previous_positions.len()],
                previous_positions[..],
                "adding building #{n} moved an earlier one"
            );
            previous_positions = positions;
            cache = new_cache;
        }
    }

    /// Helper: the plot of the district whose path ends with `suffix`, in
    /// `layout` (as produced by `model`). Looks up by path rather than by
    /// list position because caching can (correctly) reorder the output.
    fn plot_of(model: &CityModel, layout: &CityLayout, suffix: &str) -> Plot {
        layout
            .districts
            .iter()
            .find(|d| model.districts[d.district_index].path.ends_with(suffix))
            .unwrap_or_else(|| panic!("no district ending with {suffix:?} in layout"))
            .plot
            .clone()
    }

    /// Fix round 1, Important, the reviewer's exact reproduction: without a
    /// cache, `layout_city` sorts and re-packs ALL current districts on
    /// every call, so inserting `aaa/` (which sorts before `src/`) into a
    /// repo that already has `{src, zzz}` shifts `src` from its original
    /// plot. `layout_with_cache`, fed the cache `layout_with_cache` itself
    /// returned for `{src, zzz}`, must keep `src` and `zzz` exactly where
    /// they were and give only the new `aaa` a fresh plot.
    #[test]
    fn a_new_district_that_sorts_before_existing_ones_does_not_reshuffle_them() {
        let before = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/zzz/b.rs", 10)]);
        let (layout_before, cache) = layout_with_cache(&before, &LayoutCache::default());
        let src_before = plot_of(&before, &layout_before, "/src");
        let zzz_before = plot_of(&before, &layout_before, "/zzz");

        let after = model_of(&[
            ("/p/api/aaa/c.rs", 10),
            ("/p/api/src/a.rs", 10),
            ("/p/api/zzz/b.rs", 10),
        ]);
        let (layout_after, _cache_after) = layout_with_cache(&after, &cache);

        assert_eq!(
            plot_of(&after, &layout_after, "/src"),
            src_before,
            "src must not move"
        );
        assert_eq!(
            plot_of(&after, &layout_after, "/zzz"),
            zzz_before,
            "zzz must not move"
        );
        // aaa gets ITS OWN plot, distinct from both (and not overlapping —
        // `districts_do_not_overlap`-style check, scoped to this case).
        let aaa = plot_of(&after, &layout_after, "/aaa");
        assert_ne!(aaa, src_before);
        assert_ne!(aaa, zzz_before);
    }

    /// Fix round 1, test 2: a district removed and later re-added at the
    /// same path returns to its OLD plot, not a new one — the controller's
    /// deliberate choice ("stable, and I lean this way"). This falls out
    /// of never pruning `LayoutCache::plots`: a vanished district's entry
    /// just sits there as a hole only its own path can reclaim.
    #[test]
    fn a_removed_then_readded_district_reclaims_its_old_plot() {
        let with_both = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/zzz/b.rs", 10)]);
        let (layout1, cache1) = layout_with_cache(&with_both, &LayoutCache::default());
        let src_original = plot_of(&with_both, &layout1, "/src");

        // src's file is deleted; only zzz remains.
        let without_src = model_of(&[("/p/api/zzz/b.rs", 10)]);
        let (_layout2, cache2) = layout_with_cache(&without_src, &cache1);

        // src comes back (e.g. the file is restored).
        let (layout3, _cache3) = layout_with_cache(&with_both, &cache2);
        assert_eq!(
            plot_of(&with_both, &layout3, "/src"),
            src_original,
            "src must reclaim its old plot"
        );
    }

    /// Fix round 1, test 3: a vanished district's plot is left as an
    /// unused hole — its former neighbor keeps its own plot exactly, and
    /// the vanished district simply has no `PlacedDistrict` in the output.
    #[test]
    fn a_vanished_district_leaves_an_unused_hole_and_does_not_shift_its_neighbor() {
        let with_both = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/zzz/b.rs", 10)]);
        let (layout1, cache1) = layout_with_cache(&with_both, &LayoutCache::default());
        let zzz_original = plot_of(&with_both, &layout1, "/zzz");

        let without_src = model_of(&[("/p/api/zzz/b.rs", 10)]);
        let (layout2, _cache2) = layout_with_cache(&without_src, &cache1);

        assert_eq!(
            layout2.districts.len(),
            1,
            "vanished src must not appear in the output"
        );
        assert_eq!(
            plot_of(&without_src, &layout2, "/zzz"),
            zzz_original,
            "zzz must not shift just because its neighbor vanished"
        );
    }

    /// Fix round 1, test 4: an absent or corrupt cache file must degrade to
    /// a fresh layout, never panic — `LayoutCache::load` is the only way
    /// `layout_city_persisted` ever sees a cache, so this exercises it
    /// directly rather than going through disk-dependent plumbing.
    #[test]
    fn absent_or_corrupt_cache_degrades_to_a_fresh_layout_without_panicking() {
        let dir = tempfile::tempdir().unwrap();

        let missing = LayoutCache::load(&dir.path().join("nope.json"));
        assert_eq!(missing, LayoutCache::default());

        let corrupt_path = dir.path().join("corrupt.json");
        std::fs::write(&corrupt_path, "{ not json at all").unwrap();
        let corrupt = LayoutCache::load(&corrupt_path);
        assert_eq!(corrupt, LayoutCache::default());

        let wrong_version_path = dir.path().join("old.json");
        std::fs::write(
            &wrong_version_path,
            r#"{"version":999,"plots":{},"frontier":{}}"#,
        )
        .unwrap();
        let wrong_version = LayoutCache::load(&wrong_version_path);
        assert_eq!(wrong_version, LayoutCache::default());

        // And the degraded cache produces the same layout a fresh one would.
        let model = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10)]);
        let (from_missing, _) = layout_with_cache(&model, &missing);
        assert_eq!(from_missing, layout_city(&model));
    }

    /// Opus review, IMPORTANT 1: two overlapping scans of the SAME repo
    /// (the frontend fires `get_archipelago` on mount and on every window
    /// focus with no in-flight guard, and Tauri runs commands concurrently)
    /// both call `LayoutCache::save` for the same `towns/<hash>.json`. Under
    /// the old plain `std::fs::write` — which truncates then writes as two
    /// separate steps — one writer's truncate can land after another
    /// writer's write, or their write syscalls can interleave, leaving a
    /// file that matches NEITHER writer's content and often is not even
    /// valid JSON. `LayoutCache::load` then honestly degrades that torn
    /// file to `Default::default()`, which is exactly the "every district
    /// gets a new plot, and the reshuffle is persisted" failure the review
    /// worked out concretely (a 340,100-byte run racing a 338,069-byte
    /// run).
    ///
    /// Two threads race `save()` on the SAME path with differently-sized
    /// caches (mirroring that concrete example) while a third thread
    /// continuously reads the file; every read that observes a non-empty
    /// file must parse as a complete, valid `LayoutCache` — one writer's
    /// content or the other's, never a torn mix. Red against plain
    /// `fs::write`; green once `save()` writes atomically.
    #[test]
    fn concurrent_saves_of_the_same_cache_path_never_produce_a_torn_unparsable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("towns").join("race.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        // Two distinguishable, non-trivially-sized caches (a couple hundred
        // KB of plots each) so a write spans multiple internal write()
        // syscalls, giving the OS real scheduling opportunities to
        // interleave under a non-atomic write.
        let mut big = LayoutCache {
            version: LAYOUT_CACHE_VERSION,
            plots: BTreeMap::new(),
            frontier: Frontier::default(),
            cells: BTreeMap::new(),
            split_membership: BTreeMap::new(),
        };
        for i in 0..6000 {
            big.plots.insert(format!("/p/api/src/dir{i}/file.rs"), Plot { x: i, z: i, w: 1, d: 1 });
        }
        let mut small = big.clone();
        for i in 0..2000 {
            small.plots.remove(&format!("/p/api/src/dir{i}/file.rs"));
        }
        // Serialized ONCE up front, outside the racing loop: `LayoutCache`'s
        // own `save()` re-serializes on every call, and that (CPU-bound)
        // work dwarfs the actual (I/O-bound) write in wall-clock time,
        // which starves this test of the very overlap it needs to catch.
        // What's being exercised here is `save()`'s I/O primitive itself —
        // exactly the `std::fs::write` call this test is red against, and
        // the `atomic_write` call it must be green against once fixed.
        let big_json = serde_json::to_string_pretty(&big).unwrap();
        let small_json = serde_json::to_string_pretty(&small).unwrap();
        assert!(big_json.len() > 200_000, "the race needs a payload big enough to matter");

        let stop = std::sync::atomic::AtomicBool::new(false);
        let start = std::sync::Barrier::new(3);
        // Recorded rather than asserted from inside the reader thread: an
        // `assert!` panicking there, before it reaches `stop.store`, would
        // leave the writer threads spinning on `while !stop.load(..)`
        // forever (a `thread::scope` waits for every spawned thread to
        // finish before propagating a panic) — a hang, not a red test.
        let torn: std::sync::Mutex<Option<usize>> = std::sync::Mutex::new(None);
        std::thread::scope(|scope| {
            for json in [&big_json, &small_json] {
                let path = &path;
                let stop = &stop;
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    // A hard safety cap independent of the reader signaling
                    // `stop`, so a bug in this test can never hang the suite.
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    while !stop.load(std::sync::atomic::Ordering::Relaxed)
                        && std::time::Instant::now() < deadline
                    {
                        // The exact I/O primitive `LayoutCache::save` now
                        // uses (see that method) — this was `std::fs::write`
                        // before the fix, which is what made this test red.
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
                // Time-bounded, not iteration-bounded: a fixed small
                // iteration count can finish before the writer threads even
                // get scheduled, making the race look falsely clean. 400ms
                // of a tight read loop reliably overlaps thousands of the
                // writers' write() calls.
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
                while std::time::Instant::now() < deadline {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        if !text.is_empty() && serde_json::from_str::<LayoutCache>(&text).is_err() {
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
            panic!("a reader observed a torn (unparsable) layout cache file: {len} bytes");
        }
    }

    /// Opus review, MINOR 5: `cells_are_plausible` bounds magnitude but not
    /// the UNIQUENESS `resolve_cells` depends on. A hand-edited or torn
    /// cache mapping two paths to the SAME cell index makes `plan_district`
    /// place two buildings at identical coordinates — one real file
    /// silently vanishes from the rendered city. `LayoutCache::load` must
    /// discard such a cache (degrade to `default()`) rather than trust it,
    /// exactly like any other implausible cache.
    #[test]
    fn a_cache_with_duplicate_cell_indices_in_one_directory_is_discarded_wholesale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duplicate_cells.json");

        // A structurally valid, otherwise-plausible cache — the only thing
        // wrong with it is that "a.rs" and "b.rs" share cell index 0, an
        // invariant `resolve_cells` depends on but `cells_are_plausible`
        // (magnitude-only) never checked.
        let mut corrupt = LayoutCache {
            version: LAYOUT_CACHE_VERSION,
            plots: BTreeMap::new(),
            frontier: Frontier::default(),
            cells: BTreeMap::new(),
            split_membership: BTreeMap::new(),
        };
        corrupt
            .cells
            .insert("/p/api/src".to_string(), BTreeMap::from([("a.rs".to_string(), 0), ("b.rs".to_string(), 0)]));
        std::fs::write(&path, serde_json::to_string(&corrupt).unwrap()).unwrap();

        let loaded = LayoutCache::load(&path);
        assert_eq!(
            loaded,
            LayoutCache::default(),
            "two files sharing one cell index must never be trusted — one would render invisible"
        );
    }

    /// Builds a `LayoutCache` directly from hand-picked plots, bypassing
    /// `layout_with_cache` — lets these fix-round-2 tests set up exact
    /// spatial arrangements (a district hemmed in by specific neighbors)
    /// that would be awkward to coax out of the packing algorithm itself.
    /// `LayoutCache`'s fields are private but this module's own `tests`
    /// submodule has access to them like any other descendant.
    fn cache_of(plots: &[(&str, Plot)], frontier: Frontier) -> LayoutCache {
        LayoutCache {
            version: LAYOUT_CACHE_VERSION,
            plots: plots.iter().map(|(p, plot)| (p.to_string(), plot.clone())).collect(),
            frontier,
            cells: BTreeMap::new(),
            split_membership: BTreeMap::new(),
        }
    }

    fn far_frontier() -> Frontier {
        // A generous, empty area far from any hand-placed plot above, so a
        // relocation in these tests always lands somewhere obviously clean.
        Frontier { target_row_width: 100, cur_x: 0, cur_z: 100, row_height: 0, row_has_item: false }
    }

    /// Fix round 2, Important: round 1 reused a cached plot's SIZE
    /// verbatim forever, so a district that gained enough files to outgrow
    /// its cached footprint rendered buildings past its own plot boundary
    /// — breaking the harder invariant to protect the softer one. Red
    /// first against round 1 (see the fix report for the captured
    /// failure). Growing in place must keep the district's position AND
    /// must not move its neighbor.
    #[test]
    fn a_cached_district_that_outgrows_its_plot_grows_in_place() {
        let cache = cache_of(
            &[("/p/api/a", Plot { x: 0, z: 0, w: 3, d: 3 }), ("/p/api/b", Plot { x: 20, z: 0, w: 3, d: 3 })],
            far_frontier(),
        );
        // Distinct paths within `a` (fix round 4 keys cells by path, so
        // repeating one path 20 times would collapse to a single cell
        // instead of actually outgrowing the cached plot).
        let mut files: Vec<(String, u32)> = (0..20).map(|i| (format!("/p/api/a/f{i}.rs"), 10)).collect();
        files.push(("/p/api/b/f.rs".to_string(), 10));
        let model = model_of_strings(&files);

        let (layout, _cache) = layout_with_cache(&model, &cache);

        let a = plot_of(&model, &layout, "/a");
        let b = plot_of(&model, &layout, "/b");
        assert_eq!((a.x, a.z), (0, 0), "a must grow in place, not move");
        assert!(a.w * a.d > 9, "a's plot must have actually grown to fit 20 buildings");
        assert_eq!(b, Plot { x: 20, z: 0, w: 3, d: 3 }, "b must not move just because a grew");
        assert!(!plots_overlap(&a, &b), "grown plot must not overlap its neighbor");

        for district in &layout.districts {
            for building in &district.buildings {
                assert!(
                    building.x >= district.plot.x && building.x < district.plot.x + district.plot.w as i32
                );
                assert!(
                    building.z >= district.plot.z && building.z < district.plot.z + district.plot.d as i32
                );
            }
        }
    }

    /// Fix round 2, test 2: when growing in place would overlap a
    /// neighbor on every side that growth needs, the district relocates —
    /// alone. The neighbors that hemmed it in must not move, and the
    /// relocated district's buildings must be fully inside its new plot
    /// with no overlap anywhere.
    #[test]
    fn a_hemmed_in_cached_district_relocates_without_moving_its_neighbors() {
        let cache = cache_of(
            &[
                ("/p/api/a", Plot { x: 0, z: 0, w: 3, d: 3 }),
                ("/p/api/right", Plot { x: 3, z: 0, w: 3, d: 3 }),
                ("/p/api/below", Plot { x: 0, z: 3, w: 3, d: 3 }),
            ],
            far_frontier(),
        );
        let model = model_of(&[
            ("/p/api/a/f1.rs", 10),
            ("/p/api/a/f2.rs", 10),
            ("/p/api/right/f.rs", 10),
            ("/p/api/below/f.rs", 10),
        ]);

        let (layout, _cache) = layout_with_cache(&model, &cache);

        let a = plot_of(&model, &layout, "/a");
        let right = plot_of(&model, &layout, "/right");
        let below = plot_of(&model, &layout, "/below");

        assert_ne!((a.x, a.z), (0, 0), "a must relocate — it cannot grow without overlapping a neighbor");
        assert_eq!(right, Plot { x: 3, z: 0, w: 3, d: 3 }, "right neighbor must not move");
        assert_eq!(below, Plot { x: 0, z: 3, w: 3, d: 3 }, "below neighbor must not move");
        assert!(!plots_overlap(&a, &right));
        assert!(!plots_overlap(&a, &below));

        let a_district = layout.districts.iter().find(|d| model.districts[d.district_index].path.ends_with("/a")).unwrap();
        for building in &a_district.buildings {
            assert!(building.x >= a.x && building.x < a.x + a.w as i32);
            assert!(building.z >= a.z && building.z < a.z + a.d as i32);
        }
    }

    /// Fix round 2, test 3: a district that shrinks keeps its larger,
    /// already-cached plot rather than compacting down to fit its new,
    /// smaller building count — compacting would be indistinguishable from
    /// a reshuffle to anything watching that district's position or size.
    #[test]
    fn a_shrinking_cached_district_keeps_its_larger_plot() {
        let big_plot = Plot { x: 0, z: 0, w: 9, d: 7 };
        let cache = cache_of(&[("/p/api/a", big_plot.clone())], far_frontier());
        let model = model_of(&[("/p/api/a/only_file_left.rs", 10)]);

        let (layout, _cache) = layout_with_cache(&model, &cache);

        assert_eq!(plot_of(&model, &layout, "/a"), big_plot, "shrinking must not compact the plot");
    }

    /// Asserts the two hard invariants — no two plots overlap, every
    /// building sits inside its own plot — across every district in
    /// `layout`. Shared by the fix-round-3 tests below, which care about
    /// the invariant holding, not about specific coordinates.
    fn assert_no_overlaps_and_all_buildings_contained(layout: &CityLayout) {
        for (i, a) in layout.districts.iter().enumerate() {
            for b in layout.districts.iter().skip(i + 1) {
                assert!(
                    !plots_overlap(&a.plot, &b.plot),
                    "plots overlap: {:?} vs {:?}",
                    a.plot,
                    b.plot
                );
            }
        }
        for d in &layout.districts {
            for b in &d.buildings {
                assert!(
                    b.x >= d.plot.x && b.x < d.plot.x + d.plot.w as i32,
                    "building x={} outside plot {:?}",
                    b.x,
                    d.plot
                );
                assert!(
                    b.z >= d.plot.z && b.z < d.plot.z + d.plot.d as i32,
                    "building z={} outside plot {:?}",
                    b.z,
                    d.plot
                );
            }
        }
    }

    /// Fix round 3, CRITICAL, the reviewer's exact repro 1: a cached
    /// district growing in place (phase 1) does not update `Frontier`, so
    /// a brand-new sibling placed the same call (phase 2) could land
    /// exactly where the grown plot now extends. Round 2's "phase 1 runs
    /// before phase 2" reasoning only prevented the reverse (and
    /// nonexistent) hazard. Red first against round 2 (commit `7e06661`;
    /// see the fix report for the captured failure).
    #[test]
    fn a_growing_cached_district_does_not_collide_with_a_new_sibling_placed_the_same_call() {
        let initial = model_of(&[("/p/api/aa/f.rs", 10)]);
        let (_layout, cache) = layout_with_cache(&initial, &LayoutCache::default());

        // Distinct paths within `aa` (see the fix-round-2 growth test above
        // for why a repeated path no longer exercises real growth).
        let mut files: Vec<(String, u32)> = (0..9).map(|i| (format!("/p/api/aa/f{i}.rs"), 10)).collect();
        files.push(("/p/api/bb/f.rs".to_string(), 10));
        let model = model_of_strings(&files);

        let (layout, _cache) = layout_with_cache(&model, &cache);
        assert_no_overlaps_and_all_buildings_contained(&layout);
    }

    /// Fix round 3, repro 2: the same hazard with three pre-existing
    /// districts — growing `cc` while adding a brand-new `dd` in the same
    /// call must not collide, regardless of which existing district grows
    /// or where the frontier happens to be.
    #[test]
    fn a_growing_cached_district_does_not_collide_with_a_new_district_appended_later() {
        let initial =
            model_of(&[("/p/api/aa/f.rs", 10), ("/p/api/bb/f.rs", 10), ("/p/api/cc/f.rs", 10)]);
        let (_layout, cache) = layout_with_cache(&initial, &LayoutCache::default());

        // Distinct paths within `cc` (see the fix-round-2 growth test above
        // for why a repeated path no longer exercises real growth).
        let mut files: Vec<(String, u32)> =
            vec![("/p/api/aa/f.rs".to_string(), 10), ("/p/api/bb/f.rs".to_string(), 10)];
        files.extend((0..4).map(|i| (format!("/p/api/cc/f{i}.rs"), 10)));
        files.push(("/p/api/dd/f.rs".to_string(), 10));
        let model = model_of_strings(&files);

        let (layout, _cache) = layout_with_cache(&model, &cache);
        assert_no_overlaps_and_all_buildings_contained(&layout);
    }

    /// A tiny deterministic PRNG (PCG-style LCG) — no `rand` dependency
    /// needed for a test that only needs a varied, reproducible sequence
    /// per seed, not cryptographic quality.
    struct Lcg(u64);
    impl Lcg {
        fn new(seed: u64) -> Self {
            Lcg(seed.wrapping_add(0x9E3779B97F4A7C15))
        }
        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0
        }
        /// Fix round 4: a classic LCG's LOW bits have a much shorter
        /// effective period than its high bits (a well-known weakness of
        /// this construction), so `next_u64() % n` for small `n` was
        /// producing a near-fixed cyclic pattern instead of independent
        /// draws — confirmed directly: instrumenting the property test's
        /// action sequence showed it cycling through the same few values
        /// in lockstep, which silently made the grow-plus-new-district
        /// shape structurally unreachable (0 occurrences in 4,800 sampled
        /// steps) regardless of how the generator itself was strengthened.
        /// Drawing from the high bits instead fixed it immediately (662 of
        /// 4,800 in the same instrumentation) — this is why `next_range`
        /// shifts right by 32 before reducing mod `n`.
        fn next_range(&mut self, n: u64) -> u64 {
            (self.next_u64() >> 32) % n
        }
    }

    fn model_of_strings(paths: &[(String, u32)]) -> CityModel {
        build_city(Path::new("/p/api"), &FakeFiles(paths.to_vec()))
    }

    /// Fix round 3, ADDED PERMANENTLY per the controller's ruling; fix
    /// round 4, STRENGTHENED after the reviewer proved it didn't cover the
    /// bug it was added for. Round 3's version mutated exactly ONE district
    /// per step, so a single `layout_with_cache` call could never contain
    /// both a GROWTH and a BRAND-NEW district — the round-3 bug's exact
    /// shape — and mutation-testing confirmed it: deleting `index.insert`
    /// after resolving a district (the actual round-3 fix) left the round-3
    /// version green. Each step now applies 1-4 independent edits before
    /// laying out, so a single call can grow one district while adding
    /// another; the reviewer's equivalent variant hit that shape 8,739
    /// times across 4,000 seeds and was red on round 2 at seed 0, step 10.
    /// 10 districts, 12 steps per seed, a fixed seed range (`SEEDS`) kept
    /// small enough to stay fast in a debug build while still reliably
    /// producing the shape (reported in the fix report, along with the
    /// mutation-test confirmation that THIS version goes red without the
    /// round-3/round-4 fixes). Asserts, after every step: neither hard
    /// invariant (no overlap, no building outside its plot) breaks in the
    /// returned layout, AND the RETURNED CACHE's own plots don't overlap
    /// each other — corruption that wouldn't show up in `layout.districts`
    /// until a LATER call reused the bad entry, per the reviewer's finding.
    /// Opus review, COVERAGE HOLE: this is the most valuable test in the
    /// module — 400 seeds, a high-bit PRNG, asserting the RETURNED cache's
    /// plots too — but until this fix it built every model with the
    /// stateless `build_city`/`model_of_strings`, so `split_membership` was
    /// ALWAYS empty and round 6's stability fix (and the membership +
    /// `cache_key` composition it depends on) sat entirely outside this
    /// test's coverage, even though a district here routinely exceeds
    /// `MAX_BUILDINGS_PER_DISTRICT` (40) — `counts[slot]` grows by 1-5 per
    /// edit, up to 4 edits a step, for 12 steps, so crossing the split
    /// boundary is the ordinary case here, not a rare one.
    ///
    /// Now threads `SplitMembership` across steps exactly like `LayoutCache`
    /// already is (`model_of_strings_with_membership` /
    /// `build_city_with_membership`, the same real, persisted-membership
    /// path `layout_city_persisted_from_root` gives production callers —
    /// see that function's own doc comment), so every invariant this test
    /// already checks (no overlap in the returned layout, no building
    /// escapes its plot, the RETURNED cache's own plots don't overlap
    /// either) now also holds across states where one or more districts are
    /// split. `split_shape_occurrences` confirms this isn't accidental: it
    /// counts how many of the 4,800 (seed, step) pairs actually produced at
    /// least one split district (`cache_key` containing `#`), asserted `> 0`
    /// so a future change that silently stops exercising this path fails
    /// loudly instead of the coverage quietly regressing again.
    #[test]
    fn cached_layout_never_overlaps_or_escapes_its_plot_across_random_histories() {
        const DISTRICTS: usize = 10;
        const STEPS: usize = 12;
        const SEEDS: u64 = 400;

        let mut grow_plus_new_shape_occurrences: u32 = 0;
        let mut split_shape_occurrences: u32 = 0;
        let mut membership_populated_occurrences: u32 = 0;

        for seed in 0..SEEDS {
            let mut rng = Lcg::new(seed);
            let mut counts = [0usize; DISTRICTS];
            let mut ever_existed = [false; DISTRICTS];
            let mut cache = LayoutCache::default();
            let mut membership = SplitMembership::new();

            for step in 0..STEPS {
                let count_before = counts;
                let existed_before = ever_existed;

                // 1-4 independent edits this step, so a single call can
                // both grow an existing district and add a brand-new one —
                // the shape round 3's single-edit-per-step version could
                // never produce.
                let edits_this_step = 1 + rng.next_range(4);
                for _ in 0..edits_this_step {
                    let slot = rng.next_range(DISTRICTS as u64) as usize;
                    match rng.next_range(4) {
                        // Add (if empty) or grow (if not) by a random amount.
                        // Opus review, COVERAGE HOLE: widened from 1-5 to
                        // 1-20 so a district routinely crosses
                        // `MAX_BUILDINGS_PER_DISTRICT` (40) and this test's
                        // threaded `SplitMembership` actually participates
                        // (see `split_shape_occurrences` below) — 1-5 alone
                        // essentially never got a slot there across 12 steps.
                        0 | 2 => counts[slot] += 1 + rng.next_range(20) as usize,
                        // Remove entirely.
                        1 => counts[slot] = 0,
                        // Shrink by a random amount, floored at "removed".
                        _ => {
                            let shrink_by = 1 + rng.next_range(counts[slot] as u64 + 1) as usize;
                            counts[slot] = counts[slot].saturating_sub(shrink_by);
                        }
                    }
                }

                // Instrumentation only (not a correctness check): did this
                // step both grow an already-cached district AND introduce
                // one that was never cached before? That's the exact shape
                // the round-3 bug needed and round-3's property test
                // couldn't produce.
                let grew_existing =
                    (0..DISTRICTS).any(|s| existed_before[s] && counts[s] > count_before[s]);
                let added_new = (0..DISTRICTS).any(|s| !existed_before[s] && counts[s] > 0);
                if grew_existing && added_new {
                    grow_plus_new_shape_occurrences += 1;
                }
                for s in 0..DISTRICTS {
                    ever_existed[s] |= counts[s] > 0;
                }

                let mut files: Vec<(String, u32)> = Vec::new();
                for (slot_idx, &count) in counts.iter().enumerate() {
                    for i in 0..count {
                        files.push((format!("/p/api/d{slot_idx}/f{i}.rs"), 10));
                    }
                }
                let (model, new_membership) = model_of_strings_with_membership(&files, &membership);
                let (layout, new_cache) = layout_with_cache(&model, &cache);

                // Two distinct signals, both required: a split district
                // structurally exists (true even under the OLD stateless
                // `build_city`), AND the STATEFUL `SplitMembership` map this
                // fix threads through is actually non-empty — i.e. real
                // persisted membership, not just an incidentally-split
                // model.
                if model.districts.iter().any(|d| d.cache_key.contains('#')) {
                    split_shape_occurrences += 1;
                }
                if !new_membership.is_empty() {
                    membership_populated_occurrences += 1;
                }

                for (i, a) in layout.districts.iter().enumerate() {
                    for b in layout.districts.iter().skip(i + 1) {
                        assert!(
                            !plots_overlap(&a.plot, &b.plot),
                            "seed {seed} step {step}: plots overlap: {:?} vs {:?}",
                            a.plot,
                            b.plot
                        );
                    }
                }
                for d in &layout.districts {
                    for b in &d.buildings {
                        assert!(
                            b.x >= d.plot.x && b.x < d.plot.x + d.plot.w as i32,
                            "seed {seed} step {step}: building escaped its plot"
                        );
                        assert!(
                            b.z >= d.plot.z && b.z < d.plot.z + d.plot.d as i32,
                            "seed {seed} step {step}: building escaped its plot"
                        );
                    }
                }
                // The RETURNED cache must be internally consistent too —
                // an overlap here wouldn't show up until a later call
                // reused the bad entry.
                let cached_plots: Vec<&Plot> = new_cache.plots.values().collect();
                for (i, a) in cached_plots.iter().enumerate() {
                    for b in cached_plots.iter().skip(i + 1) {
                        assert!(
                            !plots_overlap(a, b),
                            "seed {seed} step {step}: RETURNED CACHE has overlapping plots: {:?} vs {:?}",
                            a,
                            b
                        );
                    }
                }

                cache = new_cache;
                membership = new_membership;
            }
        }

        println!(
            "grow-plus-new-district shape occurred in {grow_plus_new_shape_occurrences} of {} step(s) across {SEEDS} seeds",
            STEPS as u64 * SEEDS
        );
        println!(
            "split-district shape occurred in {split_shape_occurrences} of {} step(s) across {SEEDS} seeds",
            STEPS as u64 * SEEDS
        );
        println!(
            "non-empty split_membership occurred in {membership_populated_occurrences} of {} step(s) across {SEEDS} seeds",
            STEPS as u64 * SEEDS
        );
        assert!(
            split_shape_occurrences > 0,
            "this property test must actually exercise a split district at least once, or \
             `split_membership` (fix round 6) is silently outside its coverage again"
        );
        assert!(
            membership_populated_occurrences > 0,
            "this property test must actually thread a non-empty, persisted SplitMembership \
             through the same random history the no-overlap invariants are checked against — \
             the Opus review's COVERAGE HOLE this test now closes"
        );
    }

    /// Fix round 4's own property test, in the same spirit as the
    /// plot-overlap one above: over a generated history of file adds and
    /// deletes, a building that is present in two states, with no deletion
    /// of it in between, must occupy the same CELL (its position relative
    /// to its own district's plot origin, so a whole-district relocation —
    /// already covered by the invariants above — doesn't count as the
    /// building itself moving) in both. Tracks each currently-present
    /// path's last-recorded local position and drops it from tracking the
    /// instant the path disappears, so a later reappearance starts a fresh
    /// chain rather than being (wrongly) compared across the gap — matching
    /// the "release immediately" design this round chose (module doc).
    #[test]
    fn a_present_buildings_cell_never_changes_while_it_stays_present_across_random_histories() {
        const DISTRICTS: usize = 6;
        const FILES_PER_DISTRICT: usize = 6;
        const STEPS: usize = 15;
        const SEEDS: u64 = 300;

        for seed in 0..SEEDS {
            let mut rng = Lcg::new(seed);
            let mut present = [[false; FILES_PER_DISTRICT]; DISTRICTS];
            let mut cache = LayoutCache::default();
            // path -> its last-recorded position relative to its
            // district's plot origin.
            let mut active: std::collections::HashMap<String, (i32, i32)> =
                std::collections::HashMap::new();

            for step in 0..STEPS {
                let flips = 1 + rng.next_range(4);
                for _ in 0..flips {
                    let d = rng.next_range(DISTRICTS as u64) as usize;
                    let f = rng.next_range(FILES_PER_DISTRICT as u64) as usize;
                    present[d][f] = !present[d][f];
                }

                let mut files: Vec<(String, u32)> = Vec::new();
                for (d, row) in present.iter().enumerate() {
                    for (f, &is_present) in row.iter().enumerate() {
                        if is_present {
                            files.push((format!("/p/api/d{d}/f{f}.rs"), 10));
                        }
                    }
                }
                let model = model_of_strings(&files);
                let (layout, new_cache) = layout_with_cache(&model, &cache);

                let mut still_present: std::collections::HashSet<String> = std::collections::HashSet::new();
                for district in &layout.districts {
                    for b in &district.buildings {
                        let path = model.districts[district.district_index].buildings[b.building_index]
                            .path
                            .clone();
                        let local = (b.x - district.plot.x, b.z - district.plot.z);
                        still_present.insert(path.clone());
                        if let Some(&previous) = active.get(&path) {
                            assert_eq!(
                                previous, local,
                                "seed {seed} step {step}: {path} moved cell while continuously present"
                            );
                        }
                        active.insert(path, local);
                    }
                }
                // A path absent this step is released (fix round 4): drop
                // it from tracking so a future reappearance is allowed to
                // land anywhere, rather than asserted against a stale
                // value from before it was deleted.
                active.retain(|path, _| still_present.contains(path));

                cache = new_cache;
            }
        }
    }

    /// Test-only mirror of the aliasing rule fix round 5 gives
    /// `District::cache_key` (see `model::split_into_plots`'s doc comment),
    /// recomputed HERE from `path` alone — deliberately independent of the
    /// production `cache_key` field, so tests built on this helper are true
    /// black-box checks: they would catch the split-boundary bug even if
    /// `cache_key` didn't exist or were wired up wrong, rather than
    /// tautologically agreeing with whatever the field under test says.
    /// Only an EXACT trailing `#1` is collapsed to its base — `#2`, `#3`, …
    /// are left alone, matching the production rule exactly.
    fn canonical_slot_key(path: &str) -> String {
        path.strip_suffix("#1").unwrap_or(path).to_string()
    }

    /// Helper: the absolute `(x, z)` position of the building whose FILE
    /// path ends with `suffix`, searched across every district currently in
    /// `layout` — needed once a directory may have split, since which
    /// `PlacedDistrict` holds a given file can differ from call to call.
    fn building_position(model: &CityModel, layout: &CityLayout, suffix: &str) -> (i32, i32) {
        for district in &layout.districts {
            for b in &district.buildings {
                let path = &model.districts[district.district_index].buildings[b.building_index].path;
                if path.ends_with(suffix) {
                    return (b.x, b.z);
                }
            }
        }
        panic!("no building ending with {suffix:?} found in layout");
    }

    /// **THE regression test for the split-boundary cache-key bug**
    /// (`docs/superpowers/phase-0-followups.md`, "Crossing the 40-file
    /// split boundary orphans a cache entry" — the single largest
    /// remaining city-stability hole as of fix round 4). A directory
    /// growing from 39 to 41 files crosses `MAX_BUILDINGS_PER_DISTRICT`
    /// (40, `model::MAX_BUILDINGS_PER_DISTRICT`) and `model::
    /// split_into_plots` renames it from the bare `big` to `big#1`/`big#2`
    /// — the persisted cache must recognise `big#1` as the district `big`
    /// already was, not a brand-new one, or it jumps to the packing
    /// frontier. Fails against pre-fix code exactly as the followups doc
    /// describes (confirmed red before the fix — see the fix report).
    ///
    /// Files are zero-padded and added in ascending order (39, then 41,
    /// never reshuffled) so every file added later sorts strictly AFTER
    /// every earlier one: this isolates the cache-key bug from
    /// `split_into_plots`'s separate, NOT-fixed-here positional-chunking
    /// behavior (see `building_position`'s sibling test below for the one
    /// place that distinction matters).
    #[test]
    fn crossing_the_split_boundary_growing_inherits_slot_ones_plot() {
        let before_files: Vec<(String, u32)> =
            (0..39).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let before_model = model_of_strings(&before_files);
        let (before_layout, cache) = layout_with_cache(&before_model, &LayoutCache::default());
        assert_eq!(before_layout.districts.len(), 1, "39 files must not split yet");
        let plot_before = plot_of(&before_model, &before_layout, "/big");

        // Two more files push the total to 41 — one over the threshold —
        // so the directory splits into `big#1` (40 files) and `big#2` (1).
        let after_files: Vec<(String, u32)> =
            (0..41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let after_model = model_of_strings(&after_files);
        let (after_layout, _cache) = layout_with_cache(&after_model, &cache);
        assert_eq!(after_layout.districts.len(), 2, "41 files must split into two sub-plots");

        assert_eq!(
            plot_of(&after_model, &after_layout, "/big#1"),
            plot_before,
            "big#1 must inherit big's exact plot, not jump to the frontier"
        );
    }

    /// The reverse direction: shrinking back below the split threshold must
    /// be equally stable, not merely growth past it — a fix that only
    /// handles growth trades one teleport for another. `big#1`/`big#2`
    /// dropping back to a single unsplit `big` must reclaim `big#1`'s exact
    /// plot.
    ///
    /// Deliberately starts DIRECTLY at 41 files (never having gone through
    /// an unsplit state first): if the history visited 39 files before ever
    /// splitting, the bare `big` key would already have its OWN real cache
    /// entry from that visit, and shrinking back to it would trivially
    /// "work" via the PRE-EXISTING "a vanished district reappears at its
    /// old plot" mechanism (fix round 1) regardless of whether THIS round's
    /// aliasing fix exists at all — a false pass that would prove nothing.
    /// Starting at 41 means the bare `big` key has never been cached before
    /// shrinking asks for it, so a correct answer can only come from
    /// `big`'s aliased identity with `big#1`, not from that unrelated
    /// mechanism.
    #[test]
    fn shrinking_back_below_the_split_boundary_returns_to_the_same_plot() {
        let at_41: Vec<(String, u32)> =
            (0..41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let model_41 = model_of_strings(&at_41);
        let (layout_41, cache) = layout_with_cache(&model_41, &LayoutCache::default());
        assert_eq!(layout_41.districts.len(), 2, "41 files must start out split");
        let slot1_plot = plot_of(&model_41, &layout_41, "/big#1");

        // Drop to 39 files: the directory un-splits to a single `big`.
        let at_39: Vec<(String, u32)> =
            (0..39).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let model_39 = model_of_strings(&at_39);
        let (layout_39, _cache) = layout_with_cache(&model_39, &cache);
        assert_eq!(layout_39.districts.len(), 1, "39 files must be unsplit");

        assert_eq!(
            plot_of(&model_39, &layout_39, "/big"),
            slot1_plot,
            "shrinking back below the split threshold must reclaim big#1's exact plot"
        );
    }

    /// Crossing from 2 splits to 3 must not disturb `#1` or `#2` — only
    /// `#3` is genuinely new. `#1` never changes size once established (it
    /// always holds exactly 40 buildings once split), so its plot must be
    /// byte-identical; `#2` legitimately GROWS here (from 1 file to 40, in
    /// this specific transition) so only its ORIGIN, not its full extent,
    /// is asserted — growing in place while keeping the same top-left
    /// corner is the correct, designed behavior (fix round 2), not a bug.
    ///
    /// Unlike the other tests in this round, this one passes even against
    /// pre-fix code (confirmed directly) — a between-numbered-slots
    /// transition (`#2` -> `#3`) never crosses the unsplit/split boundary
    /// the aliasing bug lives at, since neither `#1` nor `#2`'s cache key
    /// ever changes here (`#2`'s key was always `dir#2`, before and after
    /// this round's fix). Kept anyway as a non-regression guard: it is
    /// exactly the scenario the followups doc names as one this fix must
    /// get right, and the growth-aware reuse/grow-in-place machinery it
    /// exercises (fix round 2) is independent enough from this round's
    /// change that it deserves its own direct check.
    #[test]
    fn growing_from_two_splits_to_three_leaves_the_first_two_splits_undisturbed() {
        // 41 files: `big#1` (40) + `big#2` (1) — two splits.
        let at_41: Vec<(String, u32)> =
            (0..41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let model_41 = model_of_strings(&at_41);
        let (layout_41, cache) = layout_with_cache(&model_41, &LayoutCache::default());
        assert_eq!(layout_41.districts.len(), 2);
        let slot1_before = plot_of(&model_41, &layout_41, "/big#1");
        let slot2_before = plot_of(&model_41, &layout_41, "/big#2");

        // 81 files: `big#1` (40) + `big#2` (40) + `big#3` (1) — three splits.
        let at_81: Vec<(String, u32)> =
            (0..81).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let model_81 = model_of_strings(&at_81);
        let (layout_81, _cache) = layout_with_cache(&model_81, &cache);
        assert_eq!(layout_81.districts.len(), 3);

        assert_eq!(
            plot_of(&model_81, &layout_81, "/big#1"),
            slot1_before,
            "big#1 never changes size once split — its plot must be untouched"
        );
        let slot2_after = plot_of(&model_81, &layout_81, "/big#2");
        assert_eq!(
            (slot2_after.x, slot2_after.z),
            (slot2_before.x, slot2_before.z),
            "big#2 must not move (it may legitimately grow in place, filling from 1 to 40 files)"
        );
    }

    /// The second instance of the same bug, checked directly: fix round 4
    /// keys a building's stable CELL by district path, the same identity
    /// `LayoutCache::plots` used before this round's fix — so crossing the
    /// split boundary orphaned a file's cell exactly the way it orphaned
    /// the district's plot, silently reassigning every building in the
    /// newly-renamed `dir#1` to a fresh cell even though the plot itself
    /// (once also fixed) would have looked correctly positioned in a
    /// screenshot. Picks a file present before AND after the split
    /// (`f005.rs`, which stays in slot 1) and asserts its ABSOLUTE position
    /// — both its cell (relative to its plot) and its plot's origin — is
    /// bit-for-bit identical across the crossing.
    #[test]
    fn a_buildings_cell_survives_its_district_crossing_the_split_boundary() {
        let before_files: Vec<(String, u32)> =
            (0..39).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let before_model = model_of_strings(&before_files);
        let (before_layout, cache) = layout_with_cache(&before_model, &LayoutCache::default());
        let position_before = building_position(&before_model, &before_layout, "f005.rs");

        let after_files: Vec<(String, u32)> =
            (0..41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let after_model = model_of_strings(&after_files);
        let (after_layout, _cache) = layout_with_cache(&after_model, &cache);
        assert_eq!(after_layout.districts.len(), 2, "41 files must split");
        let position_after = building_position(&after_model, &after_layout, "f005.rs");

        assert_eq!(
            position_before, position_after,
            "f005.rs's cell must survive its district crossing the split boundary"
        );
    }

    /// Fix round 5's own property test, in the same spirit as the
    /// plot-overlap and per-building-cell ones above: over a GENERATED
    /// history of a single, isolated directory's file count growing and
    /// shrinking — repeatedly crossing `MAX_BUILDINGS_PER_DISTRICT` (40) in
    /// both directions, so the directory is renamed `big` ->
    /// `big#1`/`big#2`/… and back by `model::split_into_plots` many times
    /// over a run — no cache-key-identified slot may ever change its PLOT
    /// ORIGIN once first placed.
    ///
    /// The directory is kept completely isolated (no sibling TOP-LEVEL
    /// district ever exists) and seeded with an enormous
    /// `Frontier::target_row_width` so every allocation this test ever
    /// makes stays in a single packing row (see the seeding below) — which
    /// makes collisions among this ONE family's own numbered sub-plots
    /// geometrically impossible: same-row plots are placed strictly
    /// left-to-right in allocation order, so a plot growing in place
    /// (rightward/downward from its own anchor) can only move further away
    /// from an earlier, further-left sibling, never into it, and phase 1
    /// always resolves lower-numbered slots before higher ones so a later
    /// slot is always placed to avoid whatever an earlier one just became.
    /// With every legitimate reason to relocate engineered away, "never
    /// moves" is not merely "usually stable" here but an absolute
    /// invariant — exactly what makes this a decisive test for the
    /// artificial relocation the split-boundary cache-key bug caused.
    ///
    /// Positions are tracked under `canonical_slot_key(path)`, computed
    /// HERE, independently of `District::cache_key` — a true black-box
    /// check. Grouping by the production `cache_key` field directly would
    /// only ever compare a key's plot against ITS OWN later history, and a
    /// pre-fix `cache_key` (before this round's fix, plain `path`) never
    /// reuses `dir`'s key for `dir#1` in the first place — so the exact
    /// crossing this test exists to catch would silently never be compared
    /// against anything, passing green for the wrong reason (confirmed:
    /// this was the actual gap when this test was first drafted against
    /// `cache_key` directly — see the fix report).
    ///
    /// Files are always the sorted PREFIX `f0000..f(count-1)` of a
    /// monotonically-growing name space (adding always appends the next
    /// name; removing always drops the most-recently-added ones still
    /// present) rather than fully arbitrary paths — deliberate, not a
    /// simplification of convenience: `split_into_plots` chunks a
    /// directory's buildings by POSITIONAL insertion order, not by a
    /// stable per-file identity, so a name that sorts into the MIDDLE of an
    /// already-large directory can shift which files fall into which
    /// numbered sub-plot — a real, separate instability in
    /// `split_into_plots` itself (not fixed here — out of this round's
    /// scope) that would otherwise be conflated with the cache-key bug this
    /// property test exists to catch. Keeping the file set always a
    /// growing/shrinking prefix isolates the one property this round's fix
    /// actually claims.
    #[test]
    fn a_districts_plot_never_moves_across_a_random_split_crossing_history() {
        const SEEDS: u64 = 500;
        const STEPS: usize = 25;

        for seed in 0..SEEDS {
            let mut rng = Lcg::new(seed);
            let mut count: usize = 0;

            // A far-away placeholder plot, never matched by any real
            // district in this test's model, exists purely so
            // `cache.plots.is_empty()` is false — which makes
            // `layout_with_cache` keep OUR seeded `Frontier` (huge
            // `target_row_width`) instead of recomputing one from scratch
            // off whatever tiny footprint this history's first real
            // district happens to have (see the doc comment above for why
            // a single packing row matters here).
            let mut cache = cache_of(
                &[("/__frontier_seed__", Plot { x: 5_000_000, z: 0, w: 1, d: 1 })],
                Frontier { target_row_width: 10_000_000, cur_x: 0, cur_z: 0, row_height: 0, row_has_item: false },
            );

            // cache_key -> the (x, z) it had the first time this history
            // ever saw it.
            let mut origins: std::collections::HashMap<String, (i32, i32)> =
                std::collections::HashMap::new();

            for step in 0..STEPS {
                if rng.next_range(2) == 0 {
                    count += rng.next_range(9) as usize;
                } else {
                    count = count.saturating_sub(rng.next_range(9) as usize);
                }

                let files: Vec<(String, u32)> =
                    (0..count).map(|i| (format!("/p/api/big/f{i:04}.rs"), 10)).collect();
                let model = model_of_strings(&files);
                let (layout, new_cache) = layout_with_cache(&model, &cache);

                for district in &layout.districts {
                    let path = &model.districts[district.district_index].path;
                    let key = canonical_slot_key(path);
                    let origin = (district.plot.x, district.plot.z);
                    match origins.get(&key) {
                        Some(&first_seen) => assert_eq!(
                            origin, first_seen,
                            "seed {seed} step {step} (count={count}): district {key:?} moved \
                             from {first_seen:?} to {origin:?}"
                        ),
                        None => {
                            origins.insert(key, origin);
                        }
                    }
                }

                cache = new_cache;
            }
        }
    }

    /// Builds a model with `membership` threaded in via
    /// `build_city_with_membership` — the stateful sibling of
    /// `model_of_strings`, needed for fix round 6's tests, which must
    /// thread BOTH `LayoutCache` (already-established practice in this
    /// module) AND `SplitMembership` (new this round) across calls to
    /// exercise the real, persisted-membership behavior
    /// `layout_city_persisted_from_root` gives production callers.
    fn model_of_strings_with_membership(
        paths: &[(String, u32)],
        membership: &SplitMembership,
    ) -> (CityModel, SplitMembership) {
        build_city_with_membership(Path::new("/p/api"), &FakeFiles(paths.to_vec()), membership)
    }

    /// **THE failing-test-first regression test for fix round 6** (see the
    /// module doc's "Fix round 6" section and
    /// `docs/superpowers/phase-0-followups.md`). A directory at 41 files
    /// splits into `big#1` (40) + `big#2` (1); adding ONE early-sorting file
    /// must move nothing that was already there — neither its DISTRICT
    /// (`cache_key`) nor its absolute PLOT position — only the new arrival
    /// may land wherever it lands. Confirmed red against pre-fix code
    /// before writing the real fix (see the fix report): a positional
    /// `buildings.chunks(40)` re-sort bumped `f040.rs` from `big#1` into
    /// `big#2` purely because `f000.rs` sorts before it, even though
    /// `f040.rs`'s own path never changed.
    #[test]
    fn adding_an_early_sorting_file_to_a_split_directory_moves_nothing_but_the_new_arrival() {
        let before: Vec<(String, u32)> =
            (1..=41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let (before_model, membership) = model_of_strings_with_membership(&before, &SplitMembership::new());
        let (before_layout, cache) = layout_with_cache(&before_model, &LayoutCache::default());
        assert_eq!(before_layout.districts.len(), 2, "41 files must split into two sub-plots");

        // Every pre-existing building's district identity (`cache_key`)
        // and absolute position, keyed by its own file path.
        let mut before_state: std::collections::HashMap<String, (String, (i32, i32))> =
            std::collections::HashMap::new();
        for district in &before_layout.districts {
            let model_district = &before_model.districts[district.district_index];
            for b in &district.buildings {
                let path = model_district.buildings[b.building_index].path.clone();
                before_state.insert(path, (model_district.cache_key.clone(), (b.x, b.z)));
            }
        }
        assert_eq!(before_state.len(), 41);

        // Add f000.rs — sorts BEFORE every existing file — and re-sort the
        // whole listing by path, mirroring `git ls-files`'s own sorted
        // order (see `adding_an_earlier_sorting_file_does_not_move_
        // existing_files_between_split_slots` in `city::model` for why this
        // matters: an unsorted `Vec::push` wouldn't exercise the bug at
        // all).
        let mut after = before;
        after.push(("/p/api/big/f000.rs".to_string(), 10));
        after.sort_by(|a, b| a.0.cmp(&b.0));
        let (after_model, _membership) = model_of_strings_with_membership(&after, &membership);
        let (after_layout, _cache) = layout_with_cache(&after_model, &cache);
        assert_eq!(after_layout.districts.len(), 2, "42 files must still be exactly two sub-plots");

        let mut checked = 0;
        for district in &after_layout.districts {
            let model_district = &after_model.districts[district.district_index];
            for b in &district.buildings {
                let path = &model_district.buildings[b.building_index].path;
                if path == "/p/api/big/f000.rs" {
                    continue; // the new arrival may land anywhere.
                }
                let (prev_key, prev_pos) = before_state.get(path).unwrap_or_else(|| {
                    panic!("{path} existed before and must still exist after")
                });
                assert_eq!(
                    &model_district.cache_key, prev_key,
                    "{path} changed district from {prev_key:?} to {:?}",
                    model_district.cache_key
                );
                assert_eq!((b.x, b.z), *prev_pos, "{path} moved from {prev_pos:?}");
                checked += 1;
            }
        }
        assert_eq!(checked, 41, "every one of the 41 pre-existing buildings must have been checked");
    }

    /// Fix round 6's own property test — the STRENGTHENED successor to
    /// `a_districts_plot_never_moves_across_a_random_split_crossing_history`
    /// above, which deliberately restricted itself to a monotonically
    /// growing/shrinking PREFIX specifically because membership was, at the
    /// time, still positional (see that test's doc comment). Now that
    /// `model::build_city_with_membership` resolves membership per-path,
    /// this test lifts that restriction: an arbitrary subset of a fixed
    /// name pool of files may be present or absent at each step (any file
    /// can be added or removed in any order, not just the most-recently-
    /// added ones), repeatedly crossing `MAX_BUILDINGS_PER_DISTRICT` (40)
    /// in both directions.
    ///
    /// Two invariants, checked every step:
    ///
    /// 1. **A file's own persisted split index never changes while it
    ///    remains present** — the exception-free, always-true guarantee
    ///    this round's fix actually provides (`resolve_split_indices`
    ///    resolves EVERY file's index regardless of whether the directory
    ///    is currently split, exactly so this holds even across a dip
    ///    below the threshold).
    /// 2. **A file's district (`cache_key`) never changes across two
    ///    observations where the directory was SPLIT in both** — i.e. no
    ///    building ever changes district unless it was itself removed, AS
    ///    LONG AS the comparison is between two genuinely split states.
    ///    This is deliberately NOT checked across a dip to a single
    ///    unsplit district: when a directory's total count drops to
    ///    `MAX_BUILDINGS_PER_DISTRICT` or below, `model::split_into_plots`
    ///    correctly (and unavoidably) merges every surviving file — slot 1
    ///    AND slot 2+ alike — into the one remaining district, exactly the
    ///    "shrinking below the threshold must collapse back to a single
    ///    district cleanly" behavior the task requires. That merge is a
    ///    real, structural consequence of there being only one district
    ///    once unsplit, not a positional reshuffle — comparing across it
    ///    would make this test fail on CORRECT code. Re-splitting later
    ///    resumes comparing against the LAST split observation, not the
    ///    intervening merged one, so a file that survives split -> unsplit
    ///    -> split still lands back in its original slot (invariant 1
    ///    guarantees this; invariant 2 confirms it renders that way too).
    #[test]
    fn a_files_district_never_changes_while_it_stays_present_across_arbitrary_split_crossing_histories() {
        const FILES: usize = 70; // comfortably more than one split boundary's worth
        const STEPS: usize = 40;
        const SEEDS: u64 = 300;

        for seed in 0..SEEDS {
            let mut rng = Lcg::new(seed);
            let mut present = [false; FILES];
            let mut cache = LayoutCache::default();
            let mut membership = SplitMembership::new();
            // file path -> its last-resolved persisted split index.
            let mut index_of: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
            // file path -> the district `cache_key` it last resolved to
            // AT A SPLIT OBSERVATION (see invariant 2 above) — never
            // updated from an unsplit (single-district) observation.
            let mut last_split_cache_key: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();

            for step in 0..STEPS {
                let flips = 1 + rng.next_range(8);
                for _ in 0..flips {
                    let f = rng.next_range(FILES as u64) as usize;
                    present[f] = !present[f];
                }

                let files: Vec<(String, u32)> = (0..FILES)
                    .filter(|&f| present[f])
                    .map(|f| (format!("/p/api/big/f{f:03}.rs"), 10))
                    .collect();
                let (model, new_membership) = model_of_strings_with_membership(&files, &membership);
                let (_layout, new_cache) = layout_with_cache(&model, &cache);

                let is_split = model.districts.len() > 1;
                let current_indices = new_membership.get("/p/api/big").cloned().unwrap_or_default();

                let mut still_present: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for district in &model.districts {
                    for building in &district.buildings {
                        still_present.insert(building.path.clone());

                        // Invariant 1: the file's own persisted index never
                        // changes while it stays present, split or not.
                        let index = current_indices[&building.path];
                        if let Some(&prev_index) = index_of.get(&building.path) {
                            assert_eq!(
                                prev_index, index,
                                "seed {seed} step {step}: {}'s split index changed from {prev_index} to {index}",
                                building.path
                            );
                        }
                        index_of.insert(building.path.clone(), index);

                        // Invariant 2: only meaningful (and only checked)
                        // across two SPLIT observations — see the doc
                        // comment for why a dip to a single unsplit
                        // district must not be compared against.
                        if is_split {
                            if let Some(prev_key) = last_split_cache_key.get(&building.path) {
                                assert_eq!(
                                    prev_key, &district.cache_key,
                                    "seed {seed} step {step}: {} changed district from {prev_key} to {} \
                                     while the directory stayed split both times",
                                    building.path, district.cache_key
                                );
                            }
                            last_split_cache_key.insert(building.path.clone(), district.cache_key.clone());
                        }
                    }
                }
                // A path absent this step is released everywhere (same
                // "release immediately" policy as cells/split-membership):
                // drop it from tracking so a future reappearance is
                // allowed to land anywhere new, not compared against a
                // stale value from before it was deleted.
                index_of.retain(|path, _| still_present.contains(path));
                last_split_cache_key.retain(|path, _| still_present.contains(path));

                cache = new_cache;
                membership = new_membership;
            }
        }
    }

    /// Fix round 3, MINOR: a syntactically valid but geometrically
    /// implausible cache file (e.g. hand-edited, or a future bug writing
    /// nonsense) must be rejected wholesale, not trusted into arithmetic
    /// that can overflow (`boundary_cells`) or loop for an unreasonable
    /// time. `version` alone was checked before this fix; now the plot and
    /// frontier numbers are too.
    #[test]
    fn implausible_cache_geometry_is_rejected_without_panicking() {
        let dir = tempfile::tempdir().unwrap();

        // Interpolate the real `LAYOUT_CACHE_VERSION` rather than hardcoding
        // a number: these fixtures exist to test the GEOMETRY check
        // specifically, and a stale hardcoded version would make the
        // version check reject them first, leaving the geometry check
        // unexercised.
        let huge_x_path = dir.path().join("huge_x.json");
        std::fs::write(
            &huge_x_path,
            format!(
                r#"{{"version":{LAYOUT_CACHE_VERSION},"plots":{{"/p/api/a":{{"x":2147483600,"z":0,"w":100,"d":100}}}},"frontier":{{"target_row_width":10,"cur_x":0,"cur_z":0,"row_height":0,"row_has_item":false}}}}"#
            ),
        )
        .unwrap();
        let huge_x = LayoutCache::load(&huge_x_path);
        assert_eq!(huge_x, LayoutCache::default(), "an overflow-prone x must be rejected");

        let zero_size_path = dir.path().join("zero_size.json");
        std::fs::write(
            &zero_size_path,
            format!(
                r#"{{"version":{LAYOUT_CACHE_VERSION},"plots":{{"/p/api/a":{{"x":0,"z":0,"w":0,"d":3}}}},"frontier":{{"target_row_width":10,"cur_x":0,"cur_z":0,"row_height":0,"row_has_item":false}}}}"#
            ),
        )
        .unwrap();
        let zero_size = LayoutCache::load(&zero_size_path);
        assert_eq!(zero_size, LayoutCache::default(), "a zero-width plot must be rejected");

        let huge_frontier_path = dir.path().join("huge_frontier.json");
        std::fs::write(
            &huge_frontier_path,
            format!(
                r#"{{"version":{LAYOUT_CACHE_VERSION},"plots":{{}},"frontier":{{"target_row_width":10,"cur_x":2147483600,"cur_z":0,"row_height":0,"row_has_item":false}}}}"#
            ),
        )
        .unwrap();
        let huge_frontier = LayoutCache::load(&huge_frontier_path);
        assert_eq!(huge_frontier, LayoutCache::default(), "an overflow-prone frontier must be rejected");

        let huge_cell_path = dir.path().join("huge_cell.json");
        std::fs::write(
            &huge_cell_path,
            format!(
                r#"{{"version":{LAYOUT_CACHE_VERSION},"plots":{{}},"frontier":{{}},"cells":{{"/p/api/a":{{"/p/api/a/f.rs":99999999999}}}}}}"#
            ),
        )
        .unwrap();
        let huge_cell = LayoutCache::load(&huge_cell_path);
        assert_eq!(huge_cell, LayoutCache::default(), "an overflow-prone cell index must be rejected");

        // And laying out with the degraded cache never panics and matches
        // a fresh layout, exactly like any other rejected cache.
        let model = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10)]);
        let (from_degraded, _) = layout_with_cache(&model, &huge_x);
        assert_eq!(from_degraded, layout_city(&model));
    }

    /// Fix round 3, ALSO FIX: `CityLayout.width`/`depth` must reflect the
    /// full CACHED extent (including a vanished district's hole), not just
    /// presently-visible districts — otherwise deleting whatever district
    /// sits at the city's far edge shrinks the reported box, and a
    /// fit-to-view camera would visibly rescale the entire (otherwise
    /// unmoved) city.
    #[test]
    fn city_extent_does_not_shrink_when_the_far_edge_district_vanishes() {
        let with_both = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/zzz/b.rs", 10)]);
        let (layout1, cache1) = layout_with_cache(&with_both, &LayoutCache::default());

        let without_zzz = model_of(&[("/p/api/src/a.rs", 10)]);
        let (layout2, _cache2) = layout_with_cache(&without_zzz, &cache1);

        assert_eq!(
            (layout2.width, layout2.depth),
            (layout1.width, layout1.depth),
            "deleting the far-edge district must not shrink the reported city extent"
        );
    }

    /// Fix round 3, IMPORTANT re-check: round 2's growth-blocked and
    /// relocation checks scanned every existing plot (`BTreeMap`), which
    /// measured as genuinely quadratic when a large fraction of a repo's
    /// districts all grow in the same call (a branch switch, a codegen
    /// run, or any cache predating a broad refactor) — 1,500→10.0ms,
    /// 3,000→24.5ms, 6,000→90.7ms, 12,000→336ms, ~3.7x per doubling.
    /// Builds a cache of N single-file districts, then lays out a model
    /// where EVERY one of them has grown, and reports the wall-clock time
    /// at N = 1500/3000/6000/12000 so growth in the doubling factor can be
    /// judged directly. `#[ignore]`d for the same reason as the timing
    /// tests below — it's a benchmark, not a correctness check — run with:
    ///   cargo test city::layout::tests::all_districts_growing_stays_roughly_linear -- --ignored --nocapture
    #[test]
    #[ignore]
    fn all_districts_growing_stays_roughly_linear() {
        use std::time::Instant;

        for &n in &[1500usize, 3000, 6000, 12000] {
            let initial: Vec<(String, u32)> =
                (0..n).map(|i| (format!("/p/api/d{i}/f.rs"), 10)).collect();
            let initial_model = model_of_strings(&initial);
            let (_layout, cache) = layout_with_cache(&initial_model, &LayoutCache::default());

            let mut grown: Vec<(String, u32)> = Vec::with_capacity(n * 4);
            for i in 0..n {
                for f in 0..4 {
                    grown.push((format!("/p/api/d{i}/f{f}.rs"), 10));
                }
            }
            let grown_model = model_of_strings(&grown);

            let start = Instant::now();
            let (layout, _cache) = layout_with_cache(&grown_model, &cache);
            let elapsed = start.elapsed();
            println!("n={n}: all districts grown, {} districts placed, layout time: {elapsed:?}", layout.districts.len());
        }
    }

    /// Step 5 (verification beyond the unit tests): lays out this repo and
    /// two other real repositories on this machine, printing the numbers a
    /// human should judge for "does this look like a city" — total
    /// footprint, district count, largest plot, and timing — for both the
    /// pure in-memory `layout_city` and the disk-persisted
    /// `layout_city_persisted` (fix round 1), so a human can see whether
    /// the cache changes either. `#[ignore]`d because it depends on the
    /// developer's `~/Projects` layout AND writes this run's town caches to
    /// the real `~/.age-of-agents/towns/`; run explicitly with:
    ///   cargo test city::layout::real_repos_layout_check -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_repos_layout_check() {
        use crate::city::model::{build_city, RealFiles, RealGitFiles};
        use std::path::PathBuf;
        use std::time::Instant;

        let home = std::env::var("HOME").expect("HOME must be set");
        let candidates = [
            format!("{home}/Projects/AgeOfAgents"),
            format!("{home}/Projects/my-site-next"),
            format!("{home}/Projects/Old"),
        ];

        for root in candidates {
            let root = PathBuf::from(root);
            if !root.exists() {
                println!("=== {} === SKIPPED (not present)", root.display());
                continue;
            }
            let model = build_city(&root, &RealFiles::new(Box::new(RealGitFiles::default())));
            let start = Instant::now();
            let layout = layout_city(&model);
            let elapsed = start.elapsed();

            let largest = layout
                .districts
                .iter()
                .max_by_key(|d| d.plot.w * d.plot.d)
                .map(|d| (d.plot.w, d.plot.d, d.buildings.len()));

            println!("=== {} ===", model.root);
            println!(
                "fresh (uncached) layout: districts: {}, buildings: {}, city size: {}x{} (aspect {:.2}), largest plot: {:?}, layout time: {:?}",
                layout.districts.len(),
                layout.districts.iter().map(|d| d.buildings.len()).sum::<usize>(),
                layout.width,
                layout.depth,
                layout.width as f64 / layout.depth.max(1) as f64,
                largest,
                elapsed
            );

            let cache_path_for_repo = cache_path(&model);
            let cache_existed_before = cache_path_for_repo.exists();
            let start_persisted = Instant::now();
            let persisted_layout = layout_city_persisted(&model);
            let persisted_elapsed = start_persisted.elapsed();

            println!(
                "persisted layout ({}): districts: {}, city size: {}x{}, layout+cache-IO time: {:?}{}",
                if cache_existed_before { "warm cache" } else { "cold cache, first write" },
                persisted_layout.districts.len(),
                persisted_layout.width,
                persisted_layout.depth,
                persisted_elapsed,
                if !cache_existed_before
                    && (persisted_layout.width, persisted_layout.depth)
                        == (layout.width, layout.depth)
                {
                    " — matches the fresh, uncached layout exactly, as expected on a cold cache"
                } else {
                    ""
                }
            );
        }
    }
}
