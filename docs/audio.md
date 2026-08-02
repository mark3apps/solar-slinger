# Audio — the sfx engine, the adaptive music director, and the audio grammar

> Deep reference. Read before editing [sfx.js](../src/sfx.js) or [music.js](../src/music.js), or
> before adding a sound to a new event.

## sfx.js — the engine

Owns the AudioContext + the sfx/music buses. EVERY sound is a real CC0 recording
(`assets/audio/sfx/` — Kenney + OpenGameArt, lazily decoded): one-shots via the `BANK` variant
table, continuous state (thrust/beam/heat/scrape/charge) via the `LOOPS` table — loop-authored
samples with game-driven gain/pitch. The synth blips at the bottom are decode-window fallbacks
ONLY — the user explicitly rejected synth as the primary voice; never promote them back.

## music.js — the adaptive director

24 Scott Buckley CC-BY tracks (`assets/audio/music/`, one composer so every mood shares one voice)
in six PLAYLISTS — four picked by the mood vector (calm / world / sun / danger) and two by GAME
STATE, which outranks mood: **title** (splash) and **menu** (paused / shell modal mid-run).
**Exactly one track plays at a time** (they're full mixes, not stems — layering them sounded like
songs on top of each other): the mood vector picks a playlist with enter/exit hysteresis + dwell,
switches crossfade, and a track ending naturally rotates within its playlist. Every playlist needs
≥2 tracks — a one-track list rotates to itself at its natural end and `switchTo` early-outs on
that, so the fallback is a manual replay. Streams via `<audio>` elements (never `decodeAudioData` —
a 7-min track decodes to ~150 MB of PCM). Runs every frame, sim frozen or not.

## Conventions

- **Audio conventions:** world-positioned one-shots (booms, turret fire) pass `sfx.distVol(game, x, y)` so
  far-side belt crunches stay a murmur — never add an unscaled boom for an off-screen event. The music mood
  (`world`/`sun`/`danger`) is computed even with no AudioContext, so headless soaks can assert on it via
  `window.musicState()`; `window.tick` advances it with the sim. The sun channel has a DEADZONE on its outer
  third (spawn sits ~3.3 sun-radii out and the dread bed must not brood over a fresh run — tune in
  `music.computeMood`).

## Licensing (load-bearing)

The settings panel's credit line ("Music: Scott Buckley … Kenney.nl") is REQUIRED by the CC-BY music
licenses — see `assets/audio/CREDITS.md`; don't remove it while those tracks ship. The **CREDITS**
panel carries the full attribution (every track title, both licenses); the settings line stays put
regardless, because `CREDITS.md` names it specifically.

The 24 music beds are **Git LFS-tracked**. Without LFS you get 130-byte pointer files, the `<audio>`
elements fail to decode, and the game runs SILENT with no error pointing at the cause — see
[packaging.md](packaging.md) for the CI-side guard.
