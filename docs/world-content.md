# World content — discovery layer, expedition, dense fields, the LOD, planet archetypes

> Deep reference. Read before editing `world.js` generation, the dense fields, the field LOD /
> awake list / frame registries in `physics.js`, `ai.js` lurkers, `glow.js`, or any planet
> archetype mechanic.

## The discovery layer

Combat-free exploration content, deliberately sparse and all seeded (landmarks you can give
directions by — within one run's world; since the seeded-layout pass the SPOTS derive from the
lanes each seed generated, so they differ between seeds but never within one). Rules that keep it
from breaking the invariants above:

- **Comet Vesper** free-flies an eccentric orbit (peri ~3900 — deliberately above the graveyard ring,
  which otherwise collision-random-walks it into the sun — apo ~20100) and must NEVER be railed —
  rails are circular-only. It is an **honorary celestial**: weighted gravity (`majorComet` in the
  Phase-1 `weighted` check + predictPaths mirrors) and ×0.25 natural impulses, because full planet
  gravity/impulses killed it every ~15 min in soaks. If chaos still claims it, `replenishWorld`
  respawns it in ~4 min. `cometT = Infinity` deliberately survives the ambient-comet expiry
  (`Infinity - dt` stays `Infinity`). Its anti-sunward tail is render-only.
- The **shepherd** station-keeps (it's in the physics `install` set) and respawns ~5 min after an
  AMBIENT death only — a player kill scatters the ring permanently. Both are deliberate: ring decay
  must always trace back to a player choice.
- **The interstellar visitor** carries `noBoundary` — the one flag exempting a non-star-anchored body
  from the world-edge force (`physics.js`), because that force would capture its hyperbolic pass. It's
  cleared the moment the player catches it. Don't put `noBoundary` on anything else without a reason
  this strong.
- **THE SOLAR WAVE** (`CFG.STORM_*`) — system-wide weather with a telegraph, a bite, a counterplay
  and a payday. The sun CHARGES visibly, then fires a shock front sweeping outward trailing a deep
  **plasma sheath**. **The sheath is the whole mechanic**: the front alone is a thin ring that crosses
  any radius in ~1.5s — too brief to notice, which is exactly what the storm used to be (decorative).
  The sheath takes seconds to pass, so being caught out in one is a situation you answer. Force-wise
  NOTHING CHANGED: it still pushes SCRAP DEBRIS ONLY, never bodies, celestials, or rails — a wave
  touching those is an invariant-3-style regression. What it does instead lands on the ship, on
  scrap, and on sensors:
  - **THE SUN THROWS THREE DIFFERENT THINGS** (`CFG.STORM_CLASSES`, weakest first: `squall`, `surge`,
    `cme`). Every number a wave runs on — charge, speed, band, tail, reach, dps, thrust derate, ion
    seconds, shove, whether it blinds, its payday weight and its whole palette — is a row in that
    table, and the live wave CARRIES its row (`game.storm` is `{r, prevR, seed, k, ...row}`).
    **Nothing downstream may read a class-shaped constant off `CFG`**: physics, render and main all
    read the wave, so the plasma on screen is always the plasma the sim is charging you for. The class
    is picked at CHARGE time (`config.stormClass`, off `Math.random` — never the seeded stream) and
    parked on `game.stormCls`, because the telegraph has to announce WHICH one is loading.
  - **The pick is FLAT RANDOM — one of the three, equal odds, no weights and no special cases.**
    Weighting the table, or forcing the first wave of a run to the gentle row, are both tempting and
    both were deliberately declined: a third each is what makes the telegraph worth reading every
    time, because there is never a class you can assume it probably is.
  - **`CFG.STORM_EVERY` IS UNCHANGED AT 300** (and the first-wave timer at 240). Adding classes must
    not make the sky stormier — the sun fires no more often than it ever did; what changed is what it
    throws, not how often.
  - **HOW FAR IT CLIMBS gives the system a geography.** `reach` is the fraction of `CFG.WORLD_R` the
    shock can climb to before it has spent itself, and past `fade` (a fraction of that reach) it
    DISSOLVES rather than running at full strength and then blinking out — `config.stormStrength`
    returns the live 0..1 the wave carries as **`k`**, and every bite (dps, shove, thrust derate, ion
    seconds, ride XP, ionization) and every render alpha is multiplied by it. A wave that vanished at
    an exact radius would be the geometric in-world edge the house style forbids; each class instead
    spends its last ~10s visibly shredding, and the filaments and motes THIN OUT as well as dim (fade
    alone leaves a full grid of ghost streaks that reads as a screen effect). Measured:
    | class | full strength to | gone at | of the system |
    |---|---|---|---|
    | `squall` | ~18,500 | **29,900** | **½** — inner system only; never reaches the amber giant |
    | `surge` | ~27,100 | **39,900** | **⅔** |
    | `cme` | ~59,800 | 69,730 | the whole sky |
    The `cme` row's `fade` puts its taper's start at **exactly `WORLD_R`** — entirely outside the
    world — so the top class behaves precisely as it always did (full strength everywhere anything
    lives, and its 69,730 matches the 69,700 the old expiry let the front travel to). `stormSpent`
    ends a wave on the FRONT, not the tail: the sheath trails behind the shock, so a front stopped at
    the limit is a wave wholly inside it, which is what "a squall never reaches the outer system" has
    to mean. `k` is already ~0 by then, so nothing visible is cut.
  - **The ladder is priced on FULL-PASS EXPOSURE, not dps** — standing still, a sheath washes over you
    for `tail/speed` seconds, so the real cost is that times dps: **squall 3.5s × 2.5 ≈ 9 hull**,
    **surge 6.1s × 4.5 ≈ 27**, **cme 9.7s × 7 ≈ 68** (the CME row is the wave's original numbers,
    unchanged — measured at tier 0: BRAWLER 27%, HAULER/SCOUT 53% of their thinner hulls). ~3× per
    step, so the classes are told apart by CONSEQUENCE rather than by reading a label. Those figures
    are for a wave at full strength; scale by `k` for one that is spending itself.
  - **Caught EXPOSED** (in the sheath, no world between you and the sun): directionless hull damage
    (no `hitAng` — no facing dodges a wave, so a partial shield soaks only its coverage share, and the
    continuous damage means the regen delay never elapses mid-wave), engines derated to the class's
    `thrust`, and **sensors scrambled** for its `ion` seconds past the last exposure — the trajectory
    forecast and lead markers go dark and the radar drops/smears its returns. All three stay FLAT, not
    hull-scaled, like every other environmental hazard, and under the gas cloud tops (9 dps).
    `game.stormIonMax` records the class that set the scramble, since `stormIonT` outlives its wave
    and render normalises the wash against it — a fixed divisor would read a squall's 2s as 40% of a
    CME's and open the dial half-eaten.
  - **SHELTER is the counterplay** (`main.shelterBody`, `config.shelterR`, `STORM_SHADOW_*`): the sun
    is pinned at the origin, so a world's lee is just the cylinder running anti-sunward from it.
    Shelter geometry is a property of the BODY, deliberately **not** of the wave — all three classes
    break around the same lee, so what a pilot learns behind one world holds everywhere. Render CUTS
    that lee out of the plasma with an even-odd clip — the shadow isn't painted on, the plasma simply
    isn't there — and the drawn lee is deliberately NARROWER/SHORTER than the mechanical one, so
    anywhere that LOOKS sheltered is sheltered (the dust-halo safe-direction rule). Its outline is
    re-stroked soft afterwards: a clip cuts with a knife, and a hard in-world edge is against the
    house style.
  - **MOONS SHELTER — all but the very smallest.** The type test always read planet/moon/rogue, but
    `STORM_SHADOW_MIN_R` sat at 60 and the sky's moons then ran 25–84 (median 52.5), so **40 of 59
    moons silently failed**: "duck behind that moon" worked two times in three with nothing to tell
    you which. The floor is **24** — every real moon casts a lee (the 2026-08 moon growth to ~50–250
    radii only widens the margin), the ring shepherd moonlet still doesn't (a moonlet near ship
    scale shelters nobody). `config.shelterR` adds a **flat
    `STORM_SHADOW_PAD`** on top of the radius multiple, because forgiveness has to be measured in
    ship-widths: `1.15 ×` a 26-radius moon is a 30-unit half-width, which a TITAN (`SHIP_RADIUS` 66.3)
    does not fit through. **The pad moves with the Titan and only with the Titan** — it went 45 → 68
    (×1.5) with the 2026-08 +50% top tier, because a pad sized off the largest hull stops doing its
    job the moment that hull grows past it. `shelterR` is the ONE definition — `shelterBody` decides with it and
    `drawStormWave` punches the plasma out with it, and the two drifting apart is a pilot sitting in
    visible shadow taking damage. The lee-edge stroke widths ride it too, or on a small moon the soft
    edge falls inside the shadow and the clip shows as a hard line.
  - **The payoff, and it SCALES**: a wave BLINDS ALIEN SENSES system-wide for its whole passage (the
    window to move) — but **only the classes with `blind: true`**. A squall is a ripple, not a flood,
    and it is also the class that costs almost nothing; handing it the free blackout would make the
    cheapest weather the best weather. It also holds the stealth layer where it was balanced: at the
    reach limits the system is sense-blind **~12%** of the time, against ~25% when every wave was a
    CME that crossed the whole sky — a shorter-reaching wave is a shorter-LIVED one, so the ladder
    roughly halves the window to move. **If the aliens start feeling too sharp, this is the first
    place to look**; giving the squall `blind` would only take it to ~15%. The wave
    also IONIZES the scrap it sweeps (drawn charged blue) and riding it out exposed pays
    `PROG.XP_STORM_RIDE`/sec, **capped per wave** at `STORM_RIDE_MAX` — the front outruns any ship but
    you can still ride it outward, and an uncapped per-second payout would reward exactly that (the
    same rate-independence argument as the fields' `xpLeft`). Both halves of that payday ride the
    class's single **`pay`** weight (0.45 / 0.72 / 1): `d.ion` stores how far toward
    `PROG.ION_SCRAP_MUL` a chunk was charged rather than a bare flag, so the multiplier lerps and the
    big wave's salvage is the good salvage — and it stays truthy at every class, which is what keeps
    every `if (d.ion)` working. It is stamped with `Math.max`, so a squall trailing a CME can never
    DISCHARGE salvage the big wave already charged. Risk and reward move together or the ladder lies.
  - **Ionization must never touch FIELD scrap.** A shoal chunk's XP was already priced against the
    pocket budget by `fieldXp` at DROP time, so `dropScrap` stamps `d.field` and the pickup multiplier
    skips it — otherwise the field farm launders itself back through the weather.
  - **main.js owns `stormExposed`/`stormBlind`/`stormIonT`/`stormShelter`**, resolved once per frame
    in `updateStorm` before both consumers (`updateAliens` and the substeps); physics/render/ai only
    READ them — the same owner-split as the afterburner tank and `game.burnerOn`. `driftSplash` clears
    them (a wave left standing when you back out to the menu would cook the parked ship forever), and
    `resetRun` clears the geometry, the class and the two `*Max` scales with them.
  - **The lee message must survive an UNNAMED shelter — and must not LEAK an unearned one.** Every
    moon carries a name now (`world.MOON_NAMES`), but names are chart-ladder knowledge: main.js only
    prints a moon's own name once it is CHARTED, and an uncharted moon shelters you as
    `a moon of <parent>` / `this moon` — the same fallback shape `starmap.contactLabel` uses. The
    original hazard is still real for any future body minted outside `spawnMoon`'s naming path:
    `game.stormLeeName = ''` is falsy and the EVENT_MSGS table would drop the one message that
    teaches the counterplay.
  - **Render sizes STRUCTURE in wave units and TEXTURE off `view.r`.** A gameplay view is ~900u wide
    against a 9200u sheath, so anything sized in wave units is bigger than the screen and collapses to
    a flat wash — the first cut's 220u filaments drew as screen-filling columns. Streaks/motes scale
    with the view, fade at BOTH tips (a hard leading tip reads as architecture, not plasma), and
    stay saturated (low-alpha additive near-white over black is just grey). ~0.4ms while it crosses
    the view, nothing at all otherwise.
  - **A weak class is a SPARSER wave, never a dimmer one.** `dens` thins the filaments, the motes and
    the sun's prominences; fading a full-density wave instead just desaturates it, and a low-alpha
    additive over black is grey — the same failure the filament note above warns about. Colour rides
    the game's EXISTING heat grammar (hot = amber-to-white, cool = violet-to-blue): a squall is a pale
    cyan ripple over blue-violet haze, a surge burns rose, only a CME earns the white-hot core, and
    the `cme` row's colours are the wave's originals so the top of the ladder still looks like itself.
    Six `[r,g,b]` triples per class (`core`/`shock`/`warm`/`sheath`/`haze`/`filLo`+`filHi`) — triples
    because the filament ramp INTERPOLATES (`mixc`), and they still stringify into `rgba(${c}, a)`.
    The front's raggedness scales too, but only partway (`0.5 + 0.5 × dens`): take the wobble to zero
    and the squall's shock draws a PERFECT CIRCLE, which is the geometric in-world edge the whole pass
    exists to avoid. The radar rings, the chart arc and the far-field screen pulse all take the class
    colour as well — the instruments have to say which of the three is out there.
  - `window.storm('charge'|'here'|'off', cls)` fires one on demand instead of waiting out
    `STORM_EVERY`; `cls` pins the intensity by key (`'squall'`/`'surge'`/`'cme'`) or index and
    defaults to a fair roll. Pin it when checking a class's own numbers or palette — a random draw is
    the wrong tool for "does the squall read as a squall".
- **Survey/CHART**: flying into a world's nameplate zone charts it (`replenishWorld` scan) and pays
  `PROG.XP_SURVEY`. That zone is widened by the SCOUT **Recon Drone** ability (`st.recon`), which charts
  worlds from far outside it. Forecast horizon (`st.predictBoost`) and sensor/minimap reach
  (`st.sensorMul`) come from the SCOUT **Nav Plotter** and **Deep Array** abilities, not from a passive
  survey track.
- **Echo logs** are strings on bodies (`b.echo`), announced once on first grab via `game.echoMsg`.
- **The expedition layer** (all seeded content appends AFTER `seedGlowPockets` in `generateWorld` —
  any rng draw earlier reshuffles the whole sky and breaks mechTest T1; the guard comment in world.js
  marks the spot):
  - **Deliveries** (`world.updateDeliveries`, per-frame): the shared "fling/tow an object into a
    target's catch radius" verb (`CFG.DELIVER_R`). Consumption is a HANDOVER (`alive = false`, no
    shatter/scrap); **railed bodies are never cargo** (legit deliveries are always loose — without
    that gate a planet's railed junk satellites self-deliver to the barge at lane conjunction), and
    every handler carries a **re-entry guard** (the loop visits bodies pushed mid-sweep, and the
    barge's ice payment spawns inside its own catch radius — unguarded, an ice-for-ice trade is a
    runaway).
  - **CHART EVERYTHING**: every world/moon/station/named landmark carries a `b.chartKey`;
    `game.charted` records KEYS (respawned landmarks stay charted — spawn fns set their own keys).
    The total is recomputed live each scan (a destroyed uncharted body drops out — no 100% softlock).
    100% fires **MASTER CHART** (`prog.masterChart` → sensorMul ×1.25 + predictBoost in shipStats).
    Moons/POIs pay less than worlds and halve the Recon Drone reach.
  - **The Herald resolves**: deliver any graveyard wreck (`b.wreck`) → `gh.awake` — XP, a life pod,
    the ping turns friendly, and the fog scan sees ×1.5 farther within 6000u (MIRRORED in the
    minimap sensor bubble — keep in sync).
  - **The Tinker Barge** (`spawnTinker`): the system's ONE friendly NPC — a railed, station-keeping
    trader at r≈12000 with a rotating want (crystal/ice/wreck/junk — junk EXCLUDES the carved
    stone/visitor/wrecks or it eats landmarks). **Wants come from a LOCAL census** (user design
    rule — the barge only asks for things close by; a cross-system haul is a chore, not a trade):
    `pickTinkerWant` counts supply within `CFG.TINKER_WANT_R` (cored rocks count toward crystal),
    offers only plentiful wants (fallback: whatever there's most of), and a want whose local supply
    dries up re-rolls on a ~8s census — but NEVER while the player is holding a match (no re-rolling
    out from under a delivery in progress). The wreck want thus only appears if wrecks were hauled
    near the lane. Not grabbable (`b.tinker` in tryGrab); mass 1900 DELIBERATELY under `ATTRACT_MIN`
    (installations are never attractors); player kill permanent, ambient death respawns (~300s) —
    the shepherd's rule.
  - **The Uncharted Star**: `b.hidden` = sensor-null (fog + chart scans both skip it) — only feeding
    the Relay Station (the `ei === 0` echo station; its log IS the breadcrumb) a core crystal reveals
    the dark dwarf on the outermost rail (r≈39500). Type `'planet'` ON PURPOSE (star bypasses minimap
    fog; a custom type wouldn't re-rail after a rogue disturbance); NO `noBoundary`. Charting it:
    `XP_SURVEY_STAR` + permanent `prog.maxLivesBonus` +1 — **all lives-cap reads go through
    `config.maxLives(prog)`**, never raw `PROG.MAX_LIVES`.
  - **Mayday pods**: rare ambient rescues (t>180s, one at a time) — a real loose body (hp override 60)
    drifting sunward or nest-ward with an air timer; dock it at ANY station. The pod SPRITE is a
    real spacecraft (capsule + charred shield + orange rescue paint + beacon mast strobing faster
    as air runs out) — never a flat UI token. While the rescue is live the minimap runs a full
    mission display: blinking POD-tagged cross (hidden while the pod rides the player's beam), a
    guide line from ship to the nearest station, and a pulsing DOCK-tagged ring (prefer a SEEN
    dock; an unseen fallback is a bearing only — the station blip itself stays fogged, never a map
    reveal). Loss = a silent somber message, no penalty. Aliens grabbing the pod is intended drama
    (the helper refuses alien-held deliveries).
  - **Moons with jobs**: **iron** = debris-only magnet pooling scrap at a surface halo (the
    storm-shove law — never bodies/rails; ship magnet always wins); **sulfur** = player-credited
    smash (`earnsScrap`, >8 dmg, not the killing blow, 30s cd ticked in the always-running pre-pass)
    fountains capped loose rock; **dust** = `game.dustCloak` stealth (computed once per frame in
    `updateAliens` with 1.2s release hysteresis; nest-bound aliens disengage through the
    battle-tested return-home path, ORPHANS need the explicit cooldown fallback or they deadlock;
    never fortified); **banded** = skim XP ×`XP_SKIM_BANDED`, hull cost unchanged.
  - **The 2026-08 six** (same contract — one mechanic each, riding an existing system):
    **lodestar** = gravity as terrain (mMul 4.5 / rMul 0.5 — pure config; the attractor shortlist,
    the trajectory forecast and the mass-banded winch do all the work; rMul 0.5 keeps the worst
    roll ≥ ~28, above `STORM_SHADOW_MIN_R`, so "every moon shelters" holds); **geode** = a PLAYER
    kill frees a dense `core` body in `physics.shatter` (the cored-rock economy one size up:
    `earnsScrap` gate, mass clamp 2500–9000, plugs into the existing core want/scrap paths);
    **verdant** = hosts an anchored glow pocket in low orbit (`glow.seedMoonGlow`, off a rng FORKED
    from the world seed; regrows one mote per `PROG.GLOW_REGROW` 24s in place — the no-camping law
    by a different route; not counted against `GLOW_POCKETS`; dies with its moon); **comet** =
    spawnMoon forces the widest ellipse the slot allows (e drawn then overridden — the branch draw
    is KEPT) and the hazard loop vents ice-geyser pellets only near periapsis (`rail.a·(1−e)·1.35`).
    **The fast burst cadence is paid for by the window and only exists above `e ≥ 0.15`** — below
    that (tight slot, or the circular rail the off-view re-rail scan hands a disturbed moon) the
    "window" is always open, and the burst would out-earn the ice moon it is modeled on (~1.5x,
    uncapped by fieldXp — measured, progression audit 2026-08); those vent on the plain ice-moon
    cadence instead, so a grab can't delete the mechanic OR buff it; **husk** = a hard player smash (`earnsScrap`, >8 dmg, not the killing blow, 60s
    `huskCd` ticked in the pre-pass) sets `game.huskWake` and ai.js sends ONE wreckwright down on
    the moon under the ambient descent's exact caps; the moon itself is scrapValue ×1.8; never
    fortified; **pumice** = featherweight froth (mMul 0.45 / rMul 1.28): restitution vs a pumice
    moon is a flat 0.06 (throws bury, never bounce — near-zero, not zero, or contacts re-resolve
    forever) and a ×2 `soft` factor widens the wear gates and deepens `sev` (double crumble; hp
    loss untouched, so invariant 9's durability class stands), plus a `bigEnough` carve-out —
    pumice is world-class by SIZE, and most rolls sit under `CHUNK_MIN_MASS`.
    **molten** (2026-08, user call) = a cooled black crust over live magma: dark body, breathing
    ember crack-web (render, the drawMoltenCrust pulse precedent), and SEARING to skid on.
  - **HOSTILE SURFACES** (physics.js skim block): sulfur crust POISONS a skidding hull (×2.5 grind)
    and molten crust SEARS it (×3.5). **Skim XP stays on the UNmultiplied grind** — XP is priced
    per hull point ground on an ordinary surface, and paying the multiplier out as XP would make
    the poison moon the best skate park in the sky. **The fx/ledger gate rides the unmultiplied
    tick too** (`damageShip`'s `fxDmg` param): sear ×3.5 pushes one fast substep past the `>= 1`
    anti-spam gate (~vT 290 on a `DT_COARSE` machine), which would fire hit sfx/shake at substep
    rate and count grinding ticks as achievement "blows". Both teach with a one-shot warn-low
    message on first contact (`sulfurSkidWarn` / `moltenSkidWarn`), and both death causes name the
    surface.
    **Promoted landmarks keep their rolled `moonType`** (the Forge Moon / shepherd override name
    and job, not type), so the coma, the verdant garden, and the chart's per-type readout line all
    explicitly skip `b.volcanic || b.shepherd` — check those guards when adding a type mechanic.
  - **Every moon carries a NAME now** (`world.MOON_NAMES` — one pool per type, seeded shuffle off a
    stream FORKED from the world seed so spawnMoon assigns names without touching the main rng;
    pools wrap with a roman numeral). Names are readout/lee/journey knowledge, EARNED by charting —
    the chart still draws moons as icons, never labels (`render.labelsItself` keys off type), and
    `starmap.contactClass` carries a per-type `MOON_KIND` line every new `MOON_TYPES` row must add
    to, or its moons chart blank.
    **`updateAliens` OWNS `game.dustCloak` and is the only writer; every GATE asks
    `util.senseBlind(game)` instead**, because a live solar wave hides the ship too
    (`game.stormBlind`). render.js's hunting-eye mirror uses the same leaf helper — the two must
    never disagree about whether the ship is visible, and render must not import ai.
- The **ring shepherd**, **Forge Moon**, **graveyard wrecks**, **ghost ship** (station-type, `parent:
  null` so it gets no station-keeping), and **carved stone** are ordinary railed bodies — the fortify
  pass must keep skipping volcanic/shepherd moons.

## Early-game interactables, the dense fields, the LOD, and planet archetypes

- **Early-game interactables** (give the belt more to do than smash-the-same-rock; all lean on the
  existing throw/grab/collision loop, no new subsystems):
  - **Cored rocks** (`b.cored`, ~13% of belt/field rocks over 250 mass, world.js `maybeCore`): cracking
    the shell with a PLAYER smash frees a dense `b.core` crystal — heavy salvage (3.5x scrap, fat beam
    catch). Ambient shatters don't reveal it (earnsScrap gate). A purple glint marks cored rocks.
  - **Salvage caches** (`b.cache`, world.js `spawnCache`, ~5% of local-field spawns): light grabbable
    canisters that BURST into scrap + ice ammo when the player cracks them (physics.shatter).
  - **Gravity billiards** (physics.js): throw-kills chained within `game.comboT` (2.6s) rack up
    `game.combo`; a heavy rock plowing through light ones, or a knocked rock (credit propagated — ASTEROIDS
    ONLY, never moons/planets) killing the next, keeps it going. 2+ shouts a multiplier + bonus scrap.
  - **Ice-moon geysers** (world.js): ice-type moons vent catchable ammo like the far ice planets, but
    close-in and faster — an early harvesting loop.
  - **Dense asteroid fields** (`world.seedDenseFields`, `CFG.FIELD_*`): four VAST rock shoals —
    three riding planet-lane GAPS and one on the outer band's frost fringe (The Shoal, The
    Grindstones, The Hushfield, The Farshoal). Since the seeded-layout pass the three inner radii
    are the MIDPOINTS of the gaps the seed actually generated (`buildLayout`'s `fieldMid` slot
    markers, handed into `seedDenseFields`) — the gaps are the point, not the numbers, and a fixed
    radius would land ON a lane two seeds out of three. The Farshoal keeps its authored 44300
    spread by `SR`, pinned to `WORLD_R` (46000 authored) by construction. Each is ~910 rocks
    (`CFG.FIELD_ROCKS` 920 is the packer's ceiling; the census lands a few short of it)
    across a roughly 6520 x 4860 pocket (`FIELD_LEN`/`FIELD_SPREAD` are HALF-extents), mean
    nearest-neighbour spacing ~148u centre-to-centre and ~26u surface-to-surface — the density the
    user signed off on; SIZE and COUNT are separate knobs and must move together, or you are
    re-tuning the feel rather than the size). **The pocket is close to ROUND on purpose** (`FIELD_LEN` /
    `FIELD_SPREAD`, physical units converted to an angle per radius — an angular width turned the
    outer field into a dilute 11,000u arc): the design goal is that you fly in and GET LOST, and a
    long lane-shaped smear never does that no matter how big it is — against a ~450u view radius the
    far side is a dozen screens away in every direction.
    **But round is not RECTANGULAR** — `FIELD_LEN`/`FIELD_SPREAD` are the EXTENTS of an organic
    outline, not a box to scatter inside. A uniform draw across those extents read as an obvious
    SQUARE of rocks (the eye finds the four corners instantly and the shoal stops being a place).
    The boundary is a lobed blob: three low harmonics per field (`f.lobe`, seeded at worldgen,
    evaluated by `config.fieldLobe`, ceiling `FIELD_LOBE_MAX`) bulge and pinch it ~0.6-1.4x, so no
    two shoals share a silhouette. `world.fieldPoint` is the ONE sampler — seed pass and reknit both
    — and it draws directions AGAINST the lobe radius (bulges stay as dense as pinches), places
    ~7% of rocks past the outline as a ragged fringe (a shoal that stops dead at its boundary is
    the hard in-world edge the design law forbids), and converts the flat pocket frame back to
    sun-polar with the chord-bow correction (`tan²/2r`) so the rocks sit where `fieldFrac` says
    they do. **The HEART is placed at the pocket CENTRE, never a scatter draw** — its rail angle IS
    `f.ang`, so an off-centre heart drags the whole containment frame with it (measured before the
    fix: 40% of a shoal's own rocks fell outside `fieldFrac <= 1`, i.e. outside its own leash, wake
    and entry announce).
    **A POCKET IS GRADED FROM ITS HEART OUTWARD** (user design call: *the really large clumped
    together ones should be focused near the heart, and it should be less dense and large as you
    move to the edge*). Every knob here used to be flat — an area-uniform scatter, a landmark packer
    drawing from the same flat sampler, and a mass ladder that did not know where it was — so a
    pocket had the same rock everywhere and its middle was no more of a place than its rim. Four
    parts, and they are separate because each catches a path the others miss:
    - **The samplers pull inward.** `fieldPoint` takes an exponent on the normalised radius
      (`CFG.FIELD_*_POW`; 0.5 is the old area-uniform draw, larger pulls in). The fringe straggler is
      applied AFTER the taper and pushes outward regardless of it, or the ragged edge the
      no-hard-edges law asks for would just become a fainter edge in a different place.
    - **The masonry is packed heaviest-first, each rock with its own pull.** `packBigRock` places
      `spec` in order and interpolates each entry's exponent from `FIELD_CORE_POW` down to
      `FIELD_EDGE_POW` across the size range, so the biggest go in first and go in the middle. The
      two classes are ranked TOGETHER — a monolith is 5-8x a giant, so ranking within each class
      would have the smallest monolith and the biggest giant claiming the same spot with the same
      claim. **The bias is dropped past `FIELD_PACK_BIAS_FRAC` of the try budget**: a biased draw
      into a core that is already full rejects everything, and what gets silently lost is precisely
      the biggest rocks (measured: 14 of 126 landmarks, before the fallback existed).
    - **A rejection on where the rock LANDED** (`fieldKeep` / `FIELD_EDGE_KEEP`) is what actually
      produces the density gradient. Biasing the samplers is not enough on its own, because four
      rocks in five are skirt gravel banked against a host and inherit the masonry's spread. The
      count is unchanged: a rejected draw is retried, so the same `FIELD_ROCKS` end up further in.
    - **The mass ladder reads its own position** (`fieldMass(rng, frac)`), at seed AND at reknit —
      refilling from a flat ladder would erase the gradient over a long run, the same failure the
      skirt draw exists to prevent one knob along.

    **The HEART keeps its own clearance** (`FIELD_HEART_CLEAR`). The per-pair pack gap bottoms out at
    4 units, so once the big rocks are drawn inward it welds a ring of monoliths onto the one rock
    the field is named for — and that rock is the chart entry, the AI anchor and the thing you fly in
    to reach. Measured before the clearance: a staged shot at a heart lost ~60% of its damage to
    whatever was parked in front of it, against a `FIELD_HP_CAP` that exists precisely so a monolith
    stays breakable.

    **Grading a pocket must not re-weigh it.** `FIELD_GRAVEL_TAPER` is SOLVED against the measured
    distribution, not picked to look balanced: gravel sits at a mean normalised distance of 0.74 and
    37% of it is at or past the rim, so an eyeballed taper took 30% of the pocket's gravel mass out
    and surfaced in the `giants` census (field rock over 3000 mass). Re-solve it if
    `FIELD_RUBBLE_POW`, `FIELD_EDGE_KEEP` or the pocket extents move.
    **The whole shoal shares ONE `rail.w`** (the id-hashed ±4% jitter is overridden per rock, at seed,
    at reknit, AND in the physics re-rail scan): a pocket with mixed angular speeds shears apart and
    same-radius rocks grind each other, so a rigid pocket is what keeps a field a field. Each field's
    HEART is a named, chartable giant; the AI anchor (`game.fields`, ai.js `updateFields`) reads the
    heart's rail angle directly (splash frames advance rails but not the AI, so deriving from the rail
    keeps the anchor glued to the rocks), falling back to its own clock at the shared `w` if the heart
    is stolen or killed. Pockets slowly REKNIT toward seeded density off-view (`replenishWorld`;
    the census counts the POCKET, not strays).
  - **FIELD ROCK is its own material** — never treat it as belt rock (`world.markFieldRock` stamps
    every one, including shards minted by `physics.shatter`, or the pocket launders itself back into
    gravel):
    - **No gravity in either direction.** It doesn't FEEL gravity (skipped in physics Phase 1, so a
      knocked rock drifts and caroms in a straight line instead of falling into an orbit) and it never
      EXERTS any — `attractor` is forced false at any mass, GIANTS INCLUDED. A heavy attractor parked
      in a pocket built for knocking rocks together would quietly turn the shoal into its own solar
      system. It is also the only reason 2000+ of them are affordable: the hot loop is
      O(bodies x attractors), and field rock adds to neither side of it.
    - **...but INSIDE ITS OWN POCKET IT HAS FRICTION, AND IT SETTLES** (`CFG.FIELD_DRAG`, user design
      call). Gravity-free meant nothing at all removed energy from a knocked rock, and `FIELD_BOUNCE`
      0.92 across 800 touching rocks decays about as slowly as it spreads — so a cascade had no end
      state and the pocket ground itself down instead of returning to being a place. Rock is damped
      toward THE POCKET'S OWN FLOW (the rigid `f.w` rotation at its position), never toward rest: a
      shoal orbits, and damping toward zero in the sun frame drops rock out of its lane and smears
      the field along it. Below `FIELD_SETTLE_V` relative it REJOINS THE RAIL, because drag alone
      only asymptotes and leaves thousands of nearly-stopped free bodies awake forever.
      Three gates, each load-bearing: **only inside the pocket** (`FIELD_SETTLE_FRAC` — `w * r`
      evaluated out where an escapee flew to is a speed nothing there should have, and damping toward
      it ACCELERATES the escapee; measured at a fixed 1,479 u/s relative for a whole run before the
      gate), **barely at all during a live player throw** (`FIELD_DRAG_THROWN` — the aim solver leads
      against a straight line, so a visibly decaying throw makes the marker lie), and **no re-rail
      within 1.5s of a knock** (`liveT`, or the rail advance fights the contact resolver and the rock
      judders). Outside the pocket, the straight-line drift above is unchanged.
      Measured: 399 rocks kicked to 150 u/s, of which 399 were above the damage gate — under 10 after
      60s, ~2 after 120s.
    - **Near-elastic bounce**: field-vs-field uses the FLAT `FIELD_BOUNCE` (0.92), not a multiplier
      on the world's deadened `RESTITUTION` (scaling it still thudded). Kept under 1 — at e >= 1
      every hit ADDS energy and the pocket boils itself apart. Field rocks are also EXEMPT from the
      gentle-contact absorb rule against each other: a pocket that ate every soft touch with a 15x
      mass ratio digested itself around its own giants.
    - **Dangerous to you by QUANTITY and by the flat knee — not by a multiplier.** The
      `FIELD_SHIP_DMG` multiplier (1.0 → 2.5 → 1.3) is **REMOVED, 2026-08** (user call: "remove this
      multiplier altogether") — under the tempered damage curve it was the last flat amplifier in
      the sky, and a stirred pocket fed rock after rock into the 45%-per-hit hull cap. Shoal rock
      now prices exactly like any rock of its mass and closing speed; a rigid pocket stays SAFE to
      fly (match its orbit and relative speeds are ~0, under the `closing > 25` gate), and the cost
      of working one is the stirred-up rock you yourself set moving. Hull does not self-heal, so
      that attrition is still a real price.
      **Field rock keeps the BASE mass-saturation knee at every tier** — this always mattered more
      than the multiplier, and it is the shoal's remaining structural danger: the knee normally
      grows with tier (`1500 × (1 + tier×1.2)`) so a dreadnought shrugs off pebbles, and that made
      the shoals get SAFER the stronger you got — a median field rock at 300 closing went 31% of
      hull at tier 0, 7% at tier 3, **4% at tier 5**, i.e. harmless at exactly the tier you farm
      them. Flat knee ⇒ the same absolute bite at every tier, so a bigger hull endures more of a
      shoal without ever becoming immune to one. A big ship in a dense field is a big target.
      To make shoals scarier again, tune the knee or the lurkers — do not reintroduce a flat field
      multiplier. (The old multiplier was never applied to alien-thrown rock; `LURKER_SHOVE` keeps
      its own independent tuning, unchanged by the removal.)
    - **Tough against its own kind** (`FIELD_TOUGH` 0.08 damage scale, `FIELD_HP_MUL` 6 hp): hits
      send rocks flying, they don't erase them. The damp covers EVERY field-vs-field impact —
      including lurker body-checks and chain caroms, which are 'thrown' and at full damage vaporized
      their targets instead of billiarding them. Only a player's own live throw punches at full
      strength — smashing field rock deliberately still works and still pays. In a 30s soak melee,
      40 kicked rocks cascaded into ~1160 loose rocks caroming with only 5 deaths out of 2200.
      **"A player's own live throw" means YOUR throw and at most `FIELD_CHAIN_MAX` links past it** —
      see the billiards depth cap in the design laws. Unbounded, the propagated `thrownBy = 'player'`
      mark defeated this damp across the whole pocket, which is also why the shoal did NOT survive
      being knocked around "indefinitely" as this rule intends.
    - **THE LANDMARK LADDER IS GRADED BY RADIUS, AND THAT IS A DESIGN LAW** (user: "it should start
      out with just the little and mid sized rocks and as you get closer to the center, really pack in
      the large ones"). `FIELD_GIANT_MASS` is `[rim, core]`, walked in LOG space across the sorted
      list (`FIELD_GIANT_SKEW` weights the count toward the small end), and `FIELD_GIANT_R_MUL` is a
      `[rim, core]` pair walked with it — density falls with size, which is what buys a mid-size rung
      without dropping the class's small end below the gravel it has to outweigh.
      **Four things must move together or the grading silently stops working:**
      1. **A ROCK'S ALLOWED REACH FALLS AS A POWER OF ITS RADIUS** (`CFG.FIELD_REACH` `[rim, core]`
         plus `FIELD_REACH_EXP`) — the primary limit and the direct statement of the law. Two
         things that look adequate and are not: biasing the *sampler* does nothing, because
         `packBigRock`'s greedy-snug scoring fills outward from whatever is already placed and
         saturates to one flat coverage everywhere it can reach (measured: mean landmark radius
         across five equal-AREA bands 165/153/157/153/121, coverage 0.61/0.68/0.66/0.59/0.24 — flat
         until the rim); and a LINEAR ramp between the two ends is far too generous mid-ladder — a
         332-unit rock, 80% of the biggest in the pocket, came out allowed to q 0.63, so the outer
         third still held rock over 300 units.
      2. **A cumulative-AREA valve sits underneath it** (`FIELD_PACK_FRONT`), and it cannot be the
         primary limit — it derives reach from TOTAL area, so one shared envelope governs every rock,
         and tightening it enough to hold giants in the middle confines the SMALL rock there too.
         Its remaining job is to let big rock spill outward rather than be dropped when it genuinely
         does not fit. `FIELD_FRONT_SLACK` is proportional, not additive: a flat slack concedes far
         more to a rock capped at 0.30 than to one allowed 1.15, i.e. it leaks hardest exactly where
         the cap matters most.
      3. **The core allowance has a FLOOR set by the heart**, not by taste. The heart's own reach
         disc plus `FIELD_HEART_CLEAR` already covers out to q ~0.29, so an allowance below that
         leaves the big rocks nowhere to stand and the area valve dumps them into the middle third
         instead — measured at 0.28, 6.8 rocks over 150 units in the middle third against 1.3 in the
         core, the exact opposite of the intent. `FIELD_HEART_CLEAR` is therefore subtracted from the
         room the giants have, and sits BELOW its historic value on purpose.
      4. **The OUTER THIRD's mean size is floored by the class's own small end.** That region holds
         nothing but the bottom of the ladder, so its mean can never fall below the mean of
         `FIELD_GIANT_R_MUL[0]`-scaled rock. At a 2.4 rim multiplier the floor averaged ~39 and the
         outer third bottomed out at 48 whatever else moved; 1.9 is what let it reach 37.
      5. **`FIELD_HEART_CLEAR` tracks the pocket's DENSITY** — re-sweep when that moves. At ~0.7 core
         coverage the old failure returned exactly (a staged shot at the heart lost 64% of its damage
         to rock parked in front of it, 294 -> 105) and needed 560; once density came down and the
         masonry was spaced by its true reach, sweeping 170/260/340 moved the combat rung by nothing.

      Measured shape, in THIRDS BY RADIUS (the terms the design is stated in) — mean landmark radius
      78 / 62 / 37, coverage 0.19 / 0.41 / 0.05, and rocks at or above 150 units 1.3 / 6.8 / **0**.
      The outer third contains no large rock at all; its largest is ~54 units.
    - **THE MASONRY IS PACKED BY ITS REACH, NOT ITS RADIUS, AND THE GAP BAND GOES NEGATIVE.** A
      landmark's corners reach 1.14–2.45x its nominal radius across the baked library (mean 1.50 —
      `rockshape.shapeReach`; history: 1.14–1.62x under the old per-id generator, whose
      `util.ROCK_REACH_MAX` 1.62 still caps the gravel outlines), so packing
      on `r` reserved a footprint about half the size of the rock that went into it and the masonry
      was born INTERLOCKED — visibly overlapping and clipping on every seed, before anything moved.
      The silhouette and rotation are therefore drawn from the seeded stream BEFORE placement and
      stamped onto the body as `shapeId` / `rot`, which is what every consumer already reads.
      Spacing uses `reach` rather than the extent along the pair's bearing, because a bearing test
      fails the same way the old collider did — two star polygons can clear along the centre line and
      still interlock off it (measured: 60–75 overlapping pairs survived a bearing test, worst 237
      units) — and probing enough bearings to catch that is not affordable in a packer that runs
      hundreds of rocks x 170 tries x every placed slot on every worldgen.
      The bound is DIRECTIONAL (`rockshape.reachAt` — the max within a sector, not over the whole
      outline) and it **must be widened by the arc the other rock subtends**: a centre-line bound is
      the same blindness the old collider had, and two large rocks interlock at a corner off it
      (measured: worst 95u of overlap). But a bound safe enough to guarantee that is pessimistic
      enough to strand the biggest rocks — mean surface gap to the nearest landmark ~30 units for
      every size class except 250+, which sat at 89. So the bound is used to **accept** (free, always
      right) and `world.pairOverlaps` — an exact boolean convex-hull SAT test through
      `rockshape.rockOverlap` — arbitrates the near misses. That combination gives zero overlap AND
      uniform spacing. (History: this was `world.pairClearance`, a 7-sample radial probe mirroring
      the old `physics.bigPenetration`; both went with the collider rewrite.)
      **`CFG.FIELD_PACK_GAP`'s measured overlap sweep is OWED A RE-RUN** — its own note says to
      re-sweep when the shape kinds change, and the entire shape library was replaced with one whose
      reach tail runs to 2.45 instead of 1.62.
      **Small rock BANKS against big rock** (`FIELD_PACK_BANK`, picking from the size-ordered head of
      the slot list): the greedy-snug rule is otherwise rich-get-richer — it scores candidates by
      distance to the nearest neighbour, so every later draw crowds into whatever region already has
      the most rock, and the biggest rocks, placed first and alone in the core, stay alone. No amount
      of radial-bias tuning fixes it, because the bias picks where candidates FALL and the score picks
      which one WINS.
    - **SWIMLANES** (`world.findLanes`, `CFG.FIELD_LANE_*`) — routes rim to rim so that following one
      gives a better shot of getting out. They are **found among the placed rock, not carved through
      it**, which is both why they do not read as authored and why they cost almost nothing: carving
      first cost two thirds of the pocket's largest rocks (27 -> 8). They **skirt the core** for a
      geometric reason, not an aesthetic one — a lane is ~180 units of half-width against a ~300-unit
      core rock, so a core-crossing route would have to thread 960-unit gaps that do not exist, and
      can only be built by deleting what it crosses. A landmark is removed only if it would leave
      less than `FIELD_LANE_MIN` of passage: a slab at a lane's edge is the WALL, not an obstruction.
      Gravel is cleared too — the earlier corridor attempt failed partly because it was not, and
      "the thing actually blocking you was gravel" — but `FIELD_LANE_LEAK` of it stays, so a route is
      where rock thins out rather than a channel with a kerb.
    - **GIANTS** (`FIELD_GIANTS` per pocket) shatter into a spray of smaller field rock, and shards
      over 3000 mass are giants themselves — a bounded cascade, not an unbounded chain. This is the
      shoal's chaos engine. The shard budget must stay ABOVE the world's steady-state body count or
      the cascade silently never fires. Above them sit **MONOLITHS** (`FIELD_MONOLITHS` + the named
      heart, `FIELD_MONOLITH_MASS`): drawn at `FIELD_MONOLITH_R_MUL` 4.62, against a giant's
      `FIELD_GIANT_R_MUL` [2.3, 5.53] rim-to-core ramp — RADIUS only, the mass is untouched — the
      rocks you steer by from across the pocket.
      **That ceiling is bounded by `TIERS.ceil[5]` (1.2e6)** — the heart takes `MASS[1]`, and a
      monolith above the ceiling is permanently ungrabbable at every tier, which throws away the
      payoff the whole landmark is built around. Field-rock hp is
      capped at `FIELD_HP_CAP` (5200) precisely so a monolith stays breakable by a thrown moon-class
      mass — FIELD_HP_MUL alone made one ~34k hp, i.e. unbreakable, contradicting the calving design.
      A thrown monolith IS a rail disturber (mass > 5e4) — that's existing thrown-giant drama.
      The masses were raised as a whole (user: "much more mass so they don't move nearly as easily"),
      which is a deliberate, scoped reversal of the radius-not-mass rule: a core giant is now >20x
      nearly all of the pocket's gravel, so invariant 4 makes it immovable to a pebble, while staying
      close enough to a large moon that real mass still shifts it.
    - Field rock is why the view-local spawner's global asteroid cap is 9800 (was 380) and the world
      runs ~4,415 bodies (3,643 field rock + 772 non-field, measured — `bench.mjs worldgen`). The cap
      is far above the steady state at today's `FIELD_ROCKS` 920; it was sized when a pocket held
      1,900. (History: the pocket was 1,900, then 740, and is 920 now.) Headless
      `tick` calls at this scale can exceed a 30s console eval budget: run soaks in chunks.
  - **THE FIELD LOD** (`physics.updateFieldLOD`, called once per FRAME from main.update AND
    driftSplash — never per substep) is what makes those bodies affordable: **full physics is a
    LOCAL privilege.** Every field rock is classified AWAKE (its field is the one the ship is at,
    and it sits inside a wake bubble of ~2.2x viewR around the ship) or DORMANT (the far side of
    your own field, and every field you are not in). Dormant rocks are skipped by the collision
    sweep, both gravity phases, the per-substep rails pass, the ship/alien collision loops and the
    NaN tripwire; railed dormants are group-advanced once per frame with exact trig — the pocket is
    RIGID (shared `w`), so the whole shoal travels as one and the minimap stays truthful — while
    LOOSE dormants freeze mid-drift (off-view by definition; they resume on wake). Held/thrown/
    parry-frozen rocks are ALWAYS awake (a throw must never freeze mid-flight), and dormant
    advancement drives the same `rail.ang` the substep path reads with `rl.rdt = 0` invalidating
    the incremental rotor, so waking is seamless (measured: no displacement pops crossing the wake
    seam at speed). The LOD is advanced by `simSteps * CFG.DT` — the exact sim time the substep
    loop consumed — so dormant pockets never drift off the sim clock. **The chaos you see is always
    the chaos near you — that's the design, not a shortcut** (a thrown rock CAN pass through a
    dormant zone uncollided; it's off-view and the trade is deliberate).
    **THE FRAME REGISTRIES (`game.reg`) ride the same walk.** The awake list fixed the
    per-substep loops; a second family of scans survived it — "find every body of kind X",
    asked against the FULL array over and over (physics' iron-moon and terran shortlists ran
    per SUBSTEP; ai's `avoidStars` walked every body to find the one star, once per alien per
    frame; world's local/asteroid census ran two full reduces; render asked half a dozen more).
    Measured: with the ship parked in open space — an identical 381 awake bodies either way —
    DOUBLING the world's total body count still cost 1.7x the frame, and that gap was entirely
    work proportional to bodies already ruled out. So `updateFieldLOD` classifies as it goes
    (`stars`/`planets`/`terrans`/`ironMoons`/`stations`/`forts`/`cloakers`/`locals`/`decay`/
    `nonField`, plus asteroid and moon counts) and every scan reads the answer.
    `nonField` is the renderer's set: ~380 of ~7,900, and the landmark passes (approach plates,
    planet colour wash, minimap blips) were rejecting every shoal rock one at a time to reach it.
    Three rules: a registry is a per-frame SNAPSHOT so consumers still check `b.alive`; it holds
    REFERENCES so `generateWorld` nulls it beside `_awake`; and it may be one frame stale for
    newcomers (`physics.frameReg` covers the cold start with a one-off walk).
    Three follow-on optimizations ride the same classification:
    - **THE AWAKE LIST** (`game.bodies._awake`, built in the same LOD pass): every per-substep loop
      in `step()` iterates it instead of the full array — walking ~3,700 bodies 10-15x per frame just
      to skip dormants measured ~1.4ms (~40% of sim). It holds REFERENCES (compaction-proof), lives
      ON the bodies array so `generateWorld`'s clear invalidates it (`bodies._awake = null`; step()
      falls back to the full array while null), and `spawnAsteroid` registers spawns eagerly; any
      creation site that bypasses it self-heals at the next frame's rebuild (one frame of stasis).
      The dead/escaped cull is the one remaining full-array pass, throttled to every 4th substep.
    - **The renderer skips dormant bodies outright**: dormancy requires >2.2x viewR + 600 from the
      camera and the screen edge is at 1.0x viewR, so a dormant rock CANNOT be on screen. Teleports
      (Slipstream warp, dev goto) reclassify the LOD immediately (`updateFieldLOD(game, 0)`) or the
      arrival would render empty for one frame.
    - **The minimap dot layer is cached**: ~910 in-range rocks x (hypot+atan2+fillRect) per frame
      bakes into an offscreen canvas at ~15Hz (rebaked on origin jumps, fog flips, or the sim clock
      rewinding = resetRun) and composites as one drawImage; the sweep line stays live.
    Measured at ~8000 bodies (the 1,900-rock pocket era), in-field: sim 3.6 -> 2.3ms, draw 2.2 ->
    1.6ms, locked 120 fps. The world is ~4,415 bodies now, so those absolutes are an upper bound.
  - **SHOAL LURKERS** (`Alien` kind `'lurker'`) are the fields' ambush predators, and they fight like
    BRAWLERS, not grabbers: no beam — they BODY-CHECK field rocks at you. Entering `FIELD_WAKE` springs
    one from a nearby rock (`FIELD_BROOD` per field per run, `FIELD_HUNTERS` of them hunting at
    once); it picks a rock roughly between itself and the ship,
    swings around to the far side (`line` — the visible tell), and CHARGES through it (`charge`), which
    launches the rock on a two-pass lead solve, marked alien-thrown so it plugs into every existing
    counter (a ring rock blocks it for XP — passively, or actively once Guard Sling is owned; Deflector parries it, Dead Stop primes on the catch). Three
    rules are load-bearing and each fixed a real failure:
    - **Ambient rock contact does it NO harm.** A predator that died to its own habitat suicided on the
      nearest rock within seconds of spawning. A PLAYER-thrown rock still hurts it — that's the counterplay.
    - **It takes a MINIMUM number of hits, and hp is not what does that** (`LURKER_HIT_CAP` 0.34 of
      `LURKER_HP`, capped in `collideAlienBody`). Rock damage is QUADRATIC in closing speed and linear
      in mass, spanning three orders of magnitude (a 200-mass lob at 400 closing does 139; a 1400-mass
      rock at 1000 does 7422), so NO hp value is tunable across that range — every one is either
      one-shot by a real throw or immortal to a weak one. Raising `LURKER_HP` 34 → 90 alone changed
      literally nothing: both were one-shot by all nine sample throws. The per-hit cap (same idiom as
      invariant 3's comparable-rock cap) makes it cost ≥3 solid hits, which is what lets the predator
      live long enough to line up the rocks that are the actual threat. Lurkers only — grabbers and
      golems keep their existing feel.
    - **Only a committed `charge` shoves.** At shoal density a lurker brushes rocks constantly just
      manoeuvring; letting brushes shove burnt every cooldown on a random rock flung a random way
      (measured: 1 shove/min, none landing within 1300u).
    - **`collideAlienBody`'s "never collide with your own ammo" early-out must skip lurkers** — for a
      lurker the target IS the rock it means to hit, and that one line silently cancelled the whole mechanic.
    - **Only rocks under `LURKER_SHOVE_MASS` are shovable, in the AI pick AND the physics gate.**
      Without the physics half, a charge that clipped a giant on the way in "threw" it at ~40u/s and
      burnt the cooldown on a shot that visibly did nothing.
    The shot is *helped*: it only sets up from close in (`LURKER_SHOVE_R`) and the launched rock keeps
    steering toward the lead point briefly (`LURKER_GUIDE_*`) so a busy pocket deflecting it off a
    neighbour doesn't turn every shot into a graze. `LURKER_SHOVE` sits ABOVE `ALIEN_THROW` on
    purpose — the body-check is the lurker's whole attack, and at the old 420 the rock crawled over
    and the guidance window was doing all the work. Lurkers respect the dust shroud, and their
    containment is the POCKET FOOTPRINT itself via **`config.fieldFrac`** — the ONE shared
    lobed-outline test (ai.js leash + wake, render.js hunting-eye mirror, world.js entry announce all
    use it, so they can never disagree about where a field ends). A circular territory wide enough
    to cover the lane's long axis overshot the short axis 2x and lurkers visibly hunted empty space;
    now they engage while the ship is inside ~1.15 of the footprint, turn back at 1.3, and ambushes
    only spring with the ship actually IN the rocks (frac < ~1).
  - **Glow pockets** (`game.glowPockets`, glow.js): sparse WIDE FIELDS of small bioluminescent motes that
    ride the belt's prograde orbit (a circular rail, `w` matched to the flow at their radius), scattered
    thin across the mid system — a field (`GLOW_SPREAD`) is wide enough that you SWEEP the ship through it,
    scooping several in a pass, and its green region-halo makes it easy to spot. Motes are SLIGHTLY
    MAGNETIC — near the ship (`GLOW_MAGNET`) they home in and POP a hair before the hull touches
    (`GLOW_*` tuning in config.js) for a little hull + XP. **The only roaming mid-life
    hull heal** (see the split-health law above — hull-raising picks also heal their gain). No in-place refill — a drained pocket vanishes and a
    fresh full one fades in ELSEWHERE (never within view), so `game.glowPockets` holds a steady
    `PROG.GLOW_POCKETS` and the healing supply constantly relocates. Seeded deterministically off the
    world rng in `world.seedGlowPockets`; collected on dtReal in `glow.updateGlow` (a proximity test like
    the life pods, NOT the fixed step); drawn additively in `drawGlow` (a green region-halo + motes,
    healing-green palette). Never touches bodies/rails/velocities — purely additive to the sim.
- **Planet archetypes each carry ONE mechanic, every one built on an existing battle-tested shape**
  (nine ptypes: lava/rocky/gas/ice + terran/ocean/desert/shroud/crystal; the world.js PTYPE comment
  is the source of truth; gas giants also carry a render-only `gasKind` — amber/azure/violet looks,
  physics keys on ptype `'gas'` alone):
  - **GAS — A GAS GIANT IS NOT MADE OF ROCK** (`CFG.GAS_*`), and until this pass it took damage
    as though it were: a thrown rock BOUNCED off the cloud tops, the hit drew the solid-world
    crack web (stone fissures across a ball of hydrogen), and killing one sprayed rock fragments
    and left a hole in the sky. Four rules replace that, all the same idea — the atmosphere IS the
    body:
    - **It SWALLOWS.** Anything that reaches the cloud tops sinks and is gone (physics
      `collideBodies`): no bounce, because there is nothing to bounce off. It applies to MOONS as
      well as rock — scoping it to `type === 'asteroid'` left a thrown moon on the ordinary
      contact path, where the giant's mass dominance shattered it against the clouds, so the most
      dramatic thing you can throw at a gas giant exploded on it instead of going in. A PLANET is
      the deliberate exception (two worlds meeting is the top of invariant 8's ladder, and neither
      body should silently vanish); held rock and the orbit wall are exempt, since the ship dives
      these on purpose and stripping its cargo on the way in is an unannounced second penalty.
    - **The impact is an EVENT you can see.** A swallowed body takes `GAS_SINK` to go under —
      ploughing on, slowing, fading as the clouds close over it — and stamps a surface-local entry
      wound on `b.gasHits` that `render.drawGasWound` plays out in four beats: compression FLASH,
      PLUME, a SHOCK RING running out through the bands, and a dark PUNCH-HOLE that swirls shut
      over `GAS_HIT_FADE`. A rock blinking out against a wall of cloud was the least interesting
      thing that could happen and told the player nothing.
    - **WHAT GOES IN COMES BACK OUT** (`physics.gasErupt`). Reaching depth erupts a column back up
      the throat it made. The ejecta are launched to ORBIT, not away: surface escape here is only
      ~80, so a first cut at 90-700 threw everything clear of the world in a second — a firework,
      gone before the player could reach it. The band straddles escape instead, and what is
      captured settles into the giant's halo through the ordinary crust assist, so a giant you keep
      hitting wears a ring built from what you fed it and what it threw back. `gasEjecta` stops the
      fountain feeding itself; the halo binding is capped at `CRUST_PER_HOST` (surplus stays loose
      and goes home on the leash) or one dying giant fills the whole debris budget by itself.
    - **AN ERUPTION THROWS BOULDERS, NOT DUST** (`CFG.GAS_EJECTA` / `GAS_EJECTA_R` /
      `GAS_STRIP_EJECTA`, user design law). The column shipped as 3-15 pieces sized 1.2-4.2% of the
      giant's radius, which MEASURED as: one solid impact = 15 pieces at a median 17.6 units against
      a **1,148-unit** world (the amber giant is 1,560 since SYSTEM SCALE un-clamped it, which only
      sharpens the point); the geyser drip = 87 pieces per 30s flung out to 3.6x the radius; a
      full collapse = 96 pieces peaking at 102 live. A 17-unit crumb beside a world that size is
      sub-visible — it is *under* `CRUST_R_MIN`, the crumb floor of the crumble system that mints
      every other piece of a broken world — so the loudest thing in the game read as a puff of grit,
      and one dying giant spent ~100 of the 1,500 `DEBRIS_BUDGET` slots (of which ordinary play
      already holds ~950) on rock nobody could see. Four rules, one idea — **the column is objects,
      not texture**:
      - **A third the pieces at double the radius**, landing about the same total ejected MASS.
        Measured after: impact 15 -> **5** at a median 39.3; drip 87 -> **~25**. Count and size both
        ride `scale`, so a pebble still puffs and a moon still fountains — the ladder is intact, it
        just starts from a real rock instead of from grit. Ejecta are correspondingly HEAVIER to
        lift (a solid impact now throws boulder-class rock rather than tier-0 ammunition); a giant
        is a mid-game target and its halo is worth coming back for.
      - **The COLLAPSE is the exception and keeps a big yield** — measured 47 pieces minted and ~55
        gas ejecta left in the scene, against 96 before and ~26 if it merely inherited the
        per-eruption rule. Killing the biggest thing in the sky is allowed the biggest debris event
        in the game; what was wrong before was the SIZE, not the quantity. The throes run a hotter
        `scale` than a geyser (0.4 -> 1.0), which is what makes a collapse's pieces the big ones,
        but the COUNT is just the ordinary formula — the cadence already tightens as the world
        fails, so nothing needs to multiply it. Minted and surviving differ by ~15%: ejecta launch
        from the CURRENT surface while the throes collapse that surface inward, and escape velocity
        climbs as the radius falls, so the late column increasingly falls short of escape and rains
        back in to be quietly eaten.
      - **`beginGasStrip` MUST zero `ventT`.** The throes share that timer with the instability
        geysers, and a giant always reaches its death having been past `GAS_VENT` for a while — so
        `updateGasVents` has just armed it on ITS cadence, which is `GAS_VENT_EVERY`-based and runs
        up to ~4 SECONDS. `updateGasStrip` only decrements the same field, so the collapse inherited
        that leftover and **spent its first half completely silent**: measured, the ejecta ledger
        sat at 0 from `stripT` 4.7 down to 2.6 and only then began minting — no eruptions, no shake,
        no boom, on the one scene in the game that is supposed to be venting from everywhere at once
        for five seconds. It hid well, because the second half still delivered a plausible pile of
        rock; it surfaced only from watching the ledger tick during a playtest. Note the shape of
        this bug — a stalled first half reads as "not throwing enough" and invites inflating a count
        to compensate, which buries it instead of fixing it.
      - **A column, not a fan.** The +/-33 degree spread, fired at a random bearing every time
        through the throes, painted the sky around the world evenly — the opposite of "it blew a
        hole and the hole threw this out". Half that arc, and a speed band narrow enough that the
        scale term cannot push the whole thing past escape on a big hit (the old one did, so the
        eruptions throwing the most material were exactly the ones throwing it away). Drip spread
        measured 3.6x radius -> **1.2x**.
      - **The collapse answers to a hard TOTAL**, not to a cadence. `GAS_STRIP_EJECTA` is a
        per-collapse ledger (`b.stripEj`, reset in `beginGasStrip`); the piece count was previously
        an emergent product of two tunings with nothing bounding it. Out of budget still *erupts* —
        cloud, shock, shake and sound all fire, it just mints no rock. Same idiom as
        `CRUST_PER_HOST` / `CRUST_DEATH`: bound it by construction, not by hoping a cadence holds.
        The ceiling sits deliberately ABOVE the tuned yield so it stays a backstop rather than the
        mechanism — a cap that binds every time would truncate the tail, and the tail is the most
        violent part of the collapse, so the last and loudest vents would be the ones minting
        nothing.
      - **GAS EJECTA ARE TERMINAL — they puff, they never split** (the `!body.gasEjecta` guard on
        `shatter`'s `CHUNK_SPLIT_R` branch). Load-bearing and non-obvious: making the pieces bigger
        put **20 of 24 over `CHUNK_SPLIT_R`** where the old crumbs mostly sat under it, so every
        piece would now go two split levels (48 -> ~24 -> ~12) instead of one, and a player working
        through a collapse's 26 pieces could mint ~1,270 bodies out of them — the hundred pebbles
        this whole rule exists to delete, handed back one shot later. A crust slab splits because it
        is a piece of a crust that BROKE and is still breaking; ejecta are what an eruption already
        tore apart, so their fragmentation event has happened. Verified: killing ejecta yields **0**
        new chunks. Splitting stays the crumble's job.
    - **A FAILING GIANT VENTS ON ITS OWN.** Past `GAS_VENT` it geysers on a timer that tightens as
      it fails (`physics.updateGasVents`, near-ship only) — the world coming apart without the
      player's help, and the payoff the venting streamers promise.
    - **NO SINGLE IMPACT STRIPS ONE** (`GAS_HIT_CAP`). Collision damage is quadratic in closing
      speed and a late-game sling throws a moon ~3x faster than a mid one; measured, a heavy moon
      at full tier-5 fling computed 2.7x the giant's ENTIRE hp in one hit, so **two moons ended the
      biggest thing in the sky**. Same idiom as invariant 3's comparable-mass cap and
      `LURKER_HIT_CAP`: bound one blow, and the number of blows stops depending on how hard the
      player happens to be able to throw. Six to ten moons either way.
    - **Damage never resizes a body on the frame of the hit.** `damageBody` sets a radius TARGET
      (`b.radiusT`) and the integrate loop eases the live radius to it, so a world sags rather than
      popping a size smaller. Collisions read the live radius, so the felt size follows the drawn
      one the whole way down.
    - **Damage reads as WEATHER.** No cracks, no craters (`canWear` already excluded gas): storms
      instead, and past 40% damage their eyes GLOW — you are seeing down through a hole in the
      cloud deck to the hot interior, the same escalation ember fissures give a solid world. Past
      `GAS_VENT` the limb streams atmosphere away. Without this a wounded giant just looked like a
      giant with weather on it.
    - **It is STRIPPED, not shattered — and the strip is a SCENE.** At zero hp `damageBody` diverts
      into `beginGasStrip`: `GAS_STRIP_TIME` (5s) of death throes you can watch and fly through —
      venting from everywhere at once on a tightening timer, the envelope collapsing inward across
      the WHOLE window (the throes drive the radius directly; handing it to the chip easing
      collapsed it in the first 1.5s and left the world sitting at core size for the rest), and the
      hot core burning brighter through the thinning cloud with tearing seams opening across it.
      Then the atmosphere goes in one shell. It replaced an instant pop from giant to core, which
      was the most abrupt death in the game attached to the biggest thing in it.
      **The body is never killed and replaced — it BECOMES the core in place** (`completeGasStrip`:
      ptype, mass, radius, colour, hp). That is what keeps its rail, its lane, its chart entry and
      its whole family of moons attached with no hand-over pass; a satellite never learns its
      primary changed. It is then RAILED BY FIAT onto its lane, because `damageBody` derails on
      every chip so a giant reaches its own death already free-flying, and the generic re-rail scan
      will not accept a path that far from circular — measured, a stripped core wandered from its
      20,200 lane out past 35,000 and kept going. Kill credit is banked at the START of the throes,
      where the player earned it. Killing a gas giant TRANSFORMS it, which is also why the planet
      count holds. Mass dominance is softened for gas impacts (`GAS_DOM_EXP`) — dominance models a
      RIGID body shrugging off a light one, and a gas giant is not rigid.
      **Read the collision CREDIT before clearing the thrown state** — `collisionCredit` keys off
      `thrownBy`/`thrownTimer`, and clearing them first made every kill a gas giant ever took read
      as ambient: no kill credit, no XP, and Giant Slayer could never land however many moons you
      fed it.
    - **The halo it caught becomes a second, WIDER ring.** At completion every crust piece bound to
      the giant is railed where it stands and unbound (`completeGasStrip`) — orbiting at ~1.2 of
      the OLD radius, four times the core it just became. Without it the crust assist read the band
      off the *core's* radius, judged the whole ring far outside it, unbound everything, and the
      leash swept away the ring the player spent the fight building.
    - **The core comes out MOLTEN** (`b.molten`, `GAS_CORE_COOL`): red-hot and boiling, cooling to
      ordinary rock over ~75s (`physics.coolColor` lerps the body colour, `render.drawMoltenCrust`
      adds convection cells and a heat halo). Deliberately NOT ptype `'lava'` — that would hand a
      freshly killed giant the lava archetype's heat aura and magma artillery as a parting gift.
  - **World-breaking achievements** (13 rows): the planet ladder (five planets, ten worlds, kill a
    planet WITH a planet, kill one with a slab off another, four archetypes, all nine) and the gas
    ladder (feed one, feed fifteen, feed a whole MOON, make one vent, strip two, strip all three,
    then kill the core one left behind). `noteKill` classifies them; the archetype rows keep a
    bitmask plus an incrementally-maintained count so the predicates stay plain compares (no loop,
    no allocation in the sweep). All count from zero, so none can be a frame-one freebie —
    re-checked against `freshRun` for all three specs.
  - **TERRAN — atmosphere burn-up** (`CFG.ATMO_*`, physics.step, the corona-heat shape): loose
    free-flying asteroids under `ATMO_MAX_MASS` burn inside 1.5x radius — railed bodies (the world's
    own junk satellites live in the shell; damage would derail them), held rocks, and
    premium/quest objects (core/cache/pod/carved/visitor/wreck) are exempt, the SHIP never burns,
    and heavyweights punch through BY DESIGN: bombarding a terran world takes a real rock.
    Render streak rides `b.reentryT/reentryAng` (stamped in physics, decays in the integrate loop).
  - **OCEAN — waterspouts** (world.js hazard loop): the cryo-geyser branch with a sea-green cast —
    railed `iceOf` pellets, same caps, so it can never flood the belt.
  - **DESERT — dune skimming** pays `PROG.XP_SKIM_DUNE` (2x); hull cost UNCHANGED — the banded-moon
    law (bonus XP never discounts the grind).
  - **SHROUD — cloud cloak**: feeds the SAME `game.dustCloak` flag as dust moons (ai.js), halo
    `CFG.SHROUD_HALO` (1.7x; render haze drawn wider at 2.1x — no hard mechanic edge). Fortified
    shrouds don't cloak (a permanently cloaked siege is a free win).
  - **CRYSTAL — the one NON-CIRCULAR collider in the sim.** `util.crystalShards(id)` is the single
    source of the jagged shard polygon for BOTH render (traceCrystal) and physics — keep them on one
    table or the drawn surface and the felt surface diverge. Physics: `surfRadius` radial narrow
    phase in collideBodies/collideShipBody/collideAlienBody, `b._bp` broad-phase reach (the sweep
    must see the tallest spike, 1.32r max = `util.CRYSTAL_REACH`), predictPaths mirrors both hit
    tests, and ALL surface spawn offsets (chunk spray, shards) go through `surfReach` so nothing is
    born inside a spike (invariant 7's feedback loop). A hard player smash also rings loose a `core`
    shard (`damageBody`, floor dmg > 3 — planet mass dominance keeps throws under the moon-tuned 8).
    Render: lit sunward limb + per-shard sheens keyed to sun alignment; the hitbox IS the drawn shape.
  - **Each archetype carries achievements too** (11 rows + a secret): the discovery rows ride the
    existing one-shot `tut` flags (`atmo` / `dune` / `shroudCloak`) or a counter fed from
    `ACH_EVENT_STATS` (`spoutWarn`→`spouts`, `shardWarn`→`shards`) rather than instrumenting the sim
    twice; only the terran burn needed a real `bump` (`atmoBurns`), because its warn flag is
    tut-gated to one message and cannot count. `noteKill` classifies terran/crystal deaths
    (`kTerran` / `kCrystal`) alongside the existing ice/lava/gas buckets.

