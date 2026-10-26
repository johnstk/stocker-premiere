---
name: premiere-edit
description: How to edit an open Adobe Premiere Pro project through the stocker-premiere MCP tools (pr_*). Use when the user asks to read, build, change, color or export a Premiere sequence, place clips, add markers, apply effects or LUTs, or run an edit plan in Premiere.
---

# Editing Premiere with stocker-premiere

The `pr_*` tools talk to the "Stocker Premiere" UXP panel inside Premiere Pro (26.3+).

## Before anything

1. Call `pr_status`. If it fails, ask the user to open Premiere and the panel
   (Window › UXP Plugins › Stocker Premiere) and to paste the token shown in
   `~/Library/Application Support/stocker-premiere/token` on first use.
2. Only one Claude session can be connected to the panel at a time.

## Working rules

- Read first: `pr_getProjectState` for bins, items and sequences; `pr_getSequenceState` for tracks, clips and markers.
- Never change a sequence the user built by hand: `pr_duplicateSequence` and work on the copy.
- Batch edits with `pr_applyEditPlan`. It stops at the first step that fails or whose readback does not match (`verificado: false`); report that step instead of retrying blindly.
- After editing, confirm with `pr_getSequenceState`, and show the user a frame with `pr_exportFrame` when the change is visual.
- `pr_exportSequence` renders a file; it needs `confirmado: true`, so ask the user first.
- Times accept seconds or `HH:MM:SS:FF` timecode. Clips are addressed as `{ track: "V1", clip: 1 }` (1-based).
- Effects are matched by matchName (language-independent), e.g. `ADBE Gaussian Blur 2`; use `pr_findEffects` to look one up. Parameters can be addressed by index (`"#0"`).
- Input LUTs: read the LUT id from an already graded clip with `pr_getInputLut`, then apply it with `pr_setInputLut`.
- Save with `pr_saveProject` only when the user wants the change kept.

## Not available yet

Razor, trim, moving or removing clips, removing a range, transitions, graphics, captions, creating bins,
opening a sequence and deleting anything. Say so instead of improvising; the user can do these by hand.
