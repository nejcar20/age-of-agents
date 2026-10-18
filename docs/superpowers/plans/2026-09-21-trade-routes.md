# Trade Routes Implementation Plan

**Goal:** Let a user give an agent another local project as context and retain a visible project connection.

**Architecture:** A pure prompt/storage module and shared React provider connect the workspace, terminal toolbar, and world. Existing Herdr submission remains the sole send path. Saved records describe acknowledged submissions.

**Tech stack:** Existing React, TypeScript, Three.js/drei, Tauri invoke, Vitest.

**Spec:** ../specs/2026-09-21-trade-routes.md

## Tasks

- [x] Add tested route types, validated persistence, and deterministic prompt composition.
- [x] Build the route composer with source/destination/agent selection, modes, editable prompt, focus ownership, and explicit single submission.
- [x] Add a saved-routes workspace view, terminal and island entry points, and directional world connections.
- [x] Verify failures, stale agents, reload persistence, and modal keyboard handling; inspect the browser UI and run the full suite/build.

## Verification

- 685 tests across 50 files pass; production TypeScript/Vite build passes (existing large-chunk warning).
- Browser inspection: saved route cards, directional connections in the production World tree, editable handoff preview, desktop and 390px composer layout.
- Code review fixed deletion resurrection after failed persistence and saved receiver kind checks; regression tests cover both.
- No live prompts sent. Browser fixtures use an isolated memory store. Live native submission remains an integration check for the desktop app.

## Constraints

No real prompts during development verification. Preserve exact destination-root validation and never claim integration completed. Reference projects stay read-only in generated briefs. New dialogs must block underlying terminal input. No new dependencies.
