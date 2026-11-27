---
name: premiere-edit
description: How to edit an open Adobe Premiere Pro project through the stocker-premiere MCP tools (pr_*). Use when the user asks to read, build, change, color or export a Premiere sequence, place clips, add markers, apply or copy effects, a color grade or LUTs, or run an edit plan in Premiere.
---

# Editing Premiere with stocker-premiere

The `pr_*` tools talk to the "Stocker Premiere" UXP panel inside Premiere Pro (26.3+).

## Before anything

1. Call `pr_status`. If it fails, ask the user to open Premiere and the panel
   (Window › UXP Plugins › Stocker Premiere) and to paste the token shown in
   `~/Library/Application Support/stocker-premiere/token` on first use.
2. Several Claude sessions can share the panel. `pr_status` shows `sessoes`, `papel` and `fila`.
   When `sessoes` is 2 or more, always pass `sequence` (exact name) to every tool that edits,
   including each step of `pr_applyEditPlan`: without it the command would hit the active
   sequence, which may belong to another session, so the server refuses it. Commands from all
   sessions run one at a time, and an edit plan runs whole without another session's commands in
   between, so prefer one `pr_applyEditPlan` over many loose calls.
3. If a command returns `nao_conectado` right after another session closed, the panel is
   reconnecting to the new owner: wait a few seconds, re-read the sequence, then retry.
   `ponte_ocupada` means a session on an old version owns the port; ask the user to restart it.

## Working rules

- Read first: `pr_getProjectState` for bins, items and sequences; `pr_getSequenceState` for tracks, clips and markers.
- Never change a sequence the user built by hand: `pr_duplicateSequence` and work on the copy.
- Batch edits with `pr_applyEditPlan`. It stops at the first step that fails or whose readback does not match (`verificado: false`); report that step instead of retrying blindly.
- After editing, confirm with `pr_getSequenceState`, and show the user a frame with `pr_exportFrame` when the change is visual.
- `pr_exportSequence` renders a file; it needs `confirmado: true`, so ask the user first.
- Times accept seconds or `HH:MM:SS:FF` timecode. Clips are addressed as `{ track: "V1", clip: 1 }` (1-based).
- Effects are matched by matchName (language-independent), e.g. `ADBE Gaussian Blur 2`; use `pr_findEffects` to look one up. Parameters can be addressed by index (`"#0"`).
- To copy a grade, use `pr_copyEffect` with `from: { sequence, track, clip }` (the graded clip, any sequence) and the target `clips`. The default method (`componente`) clones the whole effect, Lumetri LUT, look and curves included, and leaves the source untouched; `metodo: "parametros"` copies only numeric parameters (Blob, LUT, look and curves cannot be read through the API). Default effect is `ADBE Lumetri`.
- Input LUTs: read the LUT id from an already graded clip with `pr_getInputLut`, then apply it with `pr_setInputLut`.
- Save with `pr_saveProject` only when the user wants the change kept.

## Timeline editing (0.4.0)

- Cut and trim: `pr_razor` (cut every track at a time, effects kept), `pr_trimClip` (move an edge; in Premiere 27.1 the
  timeline edge and the source point move together, and linked audio does not follow, so trim each track).
- Remove: `pr_removeRange` takes `[from, to)` out of all (or some) tracks, like In/Out + Extract (`ripple: true`, the
  default, closes the gap and moves later markers) or Lift (`ripple: false`). `pr_removeClips` removes clips;
  `ripple: true` closes the gap only on each clip's own track.
- Move: `pr_shiftClips` (time offset, same track), `pr_moveClip` (another track, same time).
- Sequence: `pr_openSequence`, `pr_closeSequence`, `pr_setPlayhead`, `pr_setSequenceInOut` (in/out for exports).
- Project: `pr_relinkMedia` (`fromDir`/`toDir` relinks a whole folder; run with `dryRun: true` first),
  `pr_setColorLabel`, `pr_rename`, `pr_moveToBin`.
- `pr_addTransition` (video only; `pr_listTransitions` for matchNames), `pr_setTrackMute`, `pr_exportTimeline`
  (FCP XML or OTIO, handy to read a whole cut), `pr_getCaptions` (read-only).
- Cutting needs a free track of the same kind over the clip (the API cannot overlap clips on one track); if there
  is none, the tool says so and the user adds an empty track.
- `pr_inspectApi` lists the live premierepro API when something seems missing; `pr_reloadPanel` reloads the panel.

## ExtendScript bridge (0.5.0)

`pr_esStatus` says whether the Stocker Premiere ES panel is open. It adds `pr_undo`/`pr_redo` (the History is shared
with the user and other sessions: undo only right after your own step), `pr_addTracks`, `pr_removeTrack`,
`pr_importCaptions` (SRT to caption track; to fix caption text, fix the SRT and import again), `pr_unlinkClips`,
`pr_linkClips`, `pr_setSpeed` (multiplier, duration stays), `pr_insertMogrt`, `pr_mogrtText`, `pr_esScript`.
If it is closed: Window › Extensions › Stocker Premiere ES.

## Not available in either API (27.1)

Caption styling (font, size, track style), effects on the track mixer, and deleting sequences or project items
through a named tool (deliberately). Say so instead of improvising; the user can do these by hand.
