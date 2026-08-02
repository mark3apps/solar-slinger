---
name: playtest
description: Drive the live Solar Slinger game in the browser preview to see a change actually working — park the ship at the right place, force the event, and screenshot it. Use when verifying a visual or feel change, reproducing a reported bug, or when the user asks to "see it", "show me", or "does this look right?". For headless numbers use balance-test / mechanics-test instead.
---

# Playtesting a change

Headless soaks prove the sky survives; `mechTest` proves the verbs work. Neither shows you what a
change *looks* like. This is how you get the game in front of a change in seconds instead of flying
there manually.

**Never ask the user to check it themselves — park the ship, fire the event, screenshot it.**

**This is the default way to drive the game.** The Claude Browser pane renders in the user's own app
where they can watch, and it carries tools the Electron driver has no equivalent for: `read_page`
(accessibility tree with `ref_N` handles), `find`, `read_network_requests`, `resize_window` with
light/dark, and scroll/hover/drag. Switch to the `run-solar-slinger` driver only when you need a run
that works with nothing visible (the pane suspends `requestAnimationFrame` when hidden), a soak longer
than the pane's ~30s console eval budget, or an exit code for a script.

## 1. Open the preview

`preview_start` with `{ name: "solar-slinger" }` (never Bash for the server — `serve.py` must stay the
no-cache threaded wrapper). If it was already running, reload so the latest ES modules load.

Add `?dev=1` to the URL for the speed hotkeys (`-` halve, `=` double, `0` reset). Add
`?seed=20260721` when you need a world bit-comparable with an earlier session — **the seed is random
per run otherwise.**

The pane must be **visible** for rAF to run; a hidden pane suspends the loop, so `window.speed` does
nothing there.

## 2. Get to the thing

```js
window.freshRun(0);              // spec 0 brawler, 1 hauler, 2 scout — fixed seed, sim armed
window.god(true);                // survive the trip
window.goto('Vesper');           // teleport beside a named body, velocity matched, camera snapped
window.goto(12000, -4000);       // or raw coordinates
window.locate('gas');            // returns the body itself — 'name' or 'type'
```

`goto` parks outside the body's radius with brief invulnerability and reclassifies the field LOD
immediately, so the arrival renders populated rather than empty for a frame.

## 3. Force the situation instead of waiting for it

| Want | Do |
|---|---|
| a solar wave | `window.storm('charge')` for the full telegraph, `window.storm('here')` to park a front just about to arrive, `window.storm('off')` to clear |
| a specific build | assign `game.prog` wholesale (`{ xp, level, tier, picksThisTier, spec, upgrades: { abilityId: rank }, lives }`) then `window.tick(1/60)` once to rebuild `game.st` |
| to blast past pick cards | `game.autoUpgrade = true` |
| time to pass | `window.speed(10)` live (0.25–50), or `window.tick(60)` headless then look |
| to study one collision | `window.speed(0.25)` slow-mo once the event is imminent |
| damage states | `window.god(false)` and fly into it, or drive hp directly on the body |

`window.speed(1)` restores normal play. The amber `SIM ×n` badge shows target + achieved rate and is
dev-only helper UI — it must stay hidden at 1×.

## 4. Look at it

- `computer` `{ action: "screenshot" }` — the actual deliverable for a visual change. Take a
  **before and after** when the change is a restyle; one image alone rarely settles "does this read
  right?".
- `read_console_messages` — `Solar Slinger: culled non-finite body` / `reset non-finite ship` means a
  NaN tripwire fired. Contained, but a real upstream bug.
- `preview_logs` for server-side problems (a 404 on a module usually means a stale path or a missing
  `.js` extension).
- `resize_window` with `{ preset: "mobile" }` or a dark/light `colorScheme` for HUD and panel work.
- `javascript_tool` for measured facts the eye can't settle — `game.st.*`, `game.perf.*`,
  `game.reg` counts, `game.prog.ach.stats`.

## 5. Judge it against the visual grammar

A change can render fine and still be a regression. The short list — full text in
[docs/design-laws.md](../../../docs/design-laws.md):

- **Dashes are helper/aiming UI only.** Real objects use solid strokes.
- **The shield is calm** — no dashes, no idle motion; motion is for events only. **Shield down draws
  nothing at all.**
- **Hint rings:** green auto-orbits, cyan holdable, red too heavy.
- **No hard edges in-world** — no stroke at an exact radius, no geometric transition. Boundaries read
  through density, fog and stochastic cues.
- **Chrome is mood-reactive; instruments are not** — hull green, shield blue, lives pink stay semantic.
- **Helper/debug UI is amber** and stays out of the semantic palette.

Then hand the diff to the **`visual-language-reviewer`** subagent.

## Common parking spots

| Where | Why |
|---|---|
| `goto('The Shoal')` | dense field — LOD, lurkers, rock rendering, the worst-case frame |
| `goto('Vesper')` | the free-flying comet — the one body that must never be railed |
| a gas giant (`locate('gas')`) | dive, swallow, vent, strip — the longest visual sequence in the game |
| a crystal world | the only non-circular collider; drawn shape must equal felt shape |
| near the sun | corona heat ramp, the graveyard ring clearance |
| `WORLD_R` edge | the Oort cloud — verify it still reads as weather, not a boundary |

## When NOT to use this

If the question is "did the sky survive an hour" or "did I break grabbing", the headless suites answer
faster and repeatably — use the **`balance-test`** or **`mechanics-test`** skill instead. Playtest is
for what only the eye can settle.
