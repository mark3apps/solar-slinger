# Ship art prompts — SCOUT and BRAWLER hulls

> **SUPERSEDED — kept as the design brief, not as instructions.** The generated-reference route
> was abandoned: the hulls were built directly as procedural vector art in render.js
> (`SCOUT_TIERS` / `BRAWLER_TIERS`). Several specifics below were overtaken during that work and
> are WRONG as a spec — the scout's ceiling is four guns TOTAL (not four per wing), it escalates
> guidance rather than armament, its hull splits from tier 3, and the brawler's ram is the
> dominant feature at every tier. Read docs/design-laws.md "Ship hull art" for what actually
> shipped. This file survives because the per-tier intent and the palette/silhouette rules it
> works out are still the reasoning behind those tables.

Ready-to-paste GPT Image 2 prompts for reference sprite sheets, which get hand-converted into
procedural path tables (`SCOUT_TIERS` / `BRAWLER_TIERS`) alongside the existing `SHIP_TIERS`
(→ `HAULER_TIERS`) in render.js. The images are **reference, not shipped assets** — the same route
the current hull took (see the note above `drawShipHull`, render.js:4514).

**Two prompts, one per spec.** Each yields one sheet carrying the full 6-tier ladder, so the whole
class shares a design language by construction rather than by luck across separate generations.

## No damage states

Damage is already procedural. `shipScars()` (render.js:4525) seeds scorch gouges, rust streaks and
rim bites off `(tier, dmg)` and is driven by the damage level, not the hull design — it applies to a
new spec table for free. Thresholds, for reference (render.js:5156): clean > 66% hull, damaged
33–66%, critical < 33%.

**Known follow-up:** scar placement currently samples a circle of radius `bR` around the body disc
(`cx + cos(sc.a) * sc.d * bR`), which assumes a roundish hull. On a thin swept-wing scout that will
drop scars into empty space beside the fuselage. Placement needs a per-spec region — an ellipse or a
hull-profile scatter — when the new tables land. A reference image wouldn't have solved this; it's a
code change regardless.

If you later want damage that reads *differently* per spec (a scout losing a wing panel vs a brawler
shedding armour slabs), generate one extra 3-cell strip for a single tier rather than rebuilding the
ladder sheet.

## How to run these

- **Generate at the largest landscape size available.** The sheets are 3 columns × 2 rows.
- **Transparent background**; if not offered, ask for flat magenta `#FF00FF`. Never black — it
  collides with the outline colour `#2b3444`.
- **Re-roll on sight** for: perspective tilt, a visible light source, gradients or glow baked into
  the plating, an asymmetric silhouette, ships pointing anywhere but right, or cells that overlap or
  merge into each other.
- **Expect to re-roll for tier drift** — the failure mode of a single sheet is the later cells
  wandering off the family look. If cells 4–6 stop reading as the same shipwright's work, re-roll
  rather than accepting; that cohesion is the whole reason for one sheet.

## Design constraints these encode

Drawn from what the code already enforces, so the art doesn't fight the sim:

- **Symmetry is mandatory.** Every feature in `SHIP_TIERS` is mirrored at draw time
  (`for (const m of [1, -1])`); an asymmetric reference costs a redesign to port.
- **Scout is a winged gun platform.** It arms itself by swallowing rock: intake maw at the bow →
  hopper amidships → feed conduits running outboard along the wings → weapons on wing hardpoints.
  The escalation axis is **hardpoint count and wingspan**, and the sensor gear climbs alongside as
  fire control. Its full-wrap shield reads as emitter *posts* around the rim — hardware, not a ring,
  because the shield glow is drawn in code.
- **Brawler is front-heavy with a bare tail**, because `st.shieldArc < PI` genuinely covers the front
  arc only. The weakness is visible.
- **Neither gets ring-arms or spinning assemblies.** That is the hauler's silhouette signature and
  the thing that keeps the three specs readable at a glance.
- **Do not draw the ships to true relative scale.** The real footprint ladder spans about 11× from
  tier 0 to tier 5 (`SHIP_RADIUS` 4.0 → 44.2), which would render tier 0 as an unreadable speck. The
  prompts ask for a modest visual progression instead; the true ratios come from config.js.

---

# SCOUT — the sheet

Tier ladder: 0 SPLINTER · 1 DART · 2 STILETTO · 3 LONGSHOT · 4 FARSIGHT · 5 ORACLE.

```
A sprite sheet for a top-down 2D space game, showing the six-tier upgrade ladder of a single scout ship class — six distinct ship designs of escalating power, all clearly built by the same shipwright.

SHARED DESIGN LANGUAGE across all six: a slim, aerodynamic, sharply swept-wing craft — long thin high-aspect-ratio wings raked back from a narrow needle fuselage, like a racing aircraft. A small cockpit blister sits forward on the fuselage doubling as a targeting optic with a cyan lens. An intake slot in the bow swallows rock and feeds a segmented ammunition hopper amidships, with chunks of grey rock visible through its open slots. Feed conduits run outboard from that hopper along the wing roots to weapon hardpoints mounted on the wings. Engine bells at the tail with thin cyan exhaust slits. This class is fast and lightly armoured — its mass is spent on wings, weapons and optics, never on plating.

The six cells, in order:

1. SPLINTER — the smallest, barely more than a cockpit between two wings. Slim needle fuselage, two long thin swept wings with clean bare leading edges and a single tiny empty hardpoint nub under each wing. Small bow intake slot, small hopper behind the cockpit, one engine bell. A short whip antenna trailing off each wingtip. It reads as a fast frame waiting to be armed.

2. DART — the same slim frame with slightly longer wings, now carrying one weapon pod per wing at mid-span: a short rail barrel projecting forward past the leading edge with a small cyan muzzle. Twin engine bells side by side. A pair of forward-swept rangefinder vanes on the fuselage shoulders, each tipped with a cyan lamp.

3. STILETTO — longer, thinner, more sharply swept wings carrying two weapon pods each, one at mid-span and one outboard, their short barrels projecting forward. Visible feed conduits run from a larger hopper out along both wing roots. A dorsal spotter dish behind the hopper, drawn as a flat circle with concentric rings. Twin engine bells, cyan wingtip lamps.

4. LONGSHOT — three weapon hardpoints per wing, their rail barrels now longer with two coil rings clamped along each. Wingspan noticeably wider. A large hopper with grey rock visible through its slots, flanked by a pair of flat rectangular fire-control array panels ruled with fine parallel seams. Small cyan emitter posts spaced evenly around the fuselage rim, about eight, drawn as physical nubs. Cyan wingtip lamps, twin engines.

5. FARSIGHT — four weapon hardpoints per wing plus a launcher pod faired into each wingtip. Very long, very thin, high-aspect wings. Twin ammunition hoppers flanking the centreline, two dorsal spotter dishes in line, four fire-control array panels, and long forward-raked mast antennae beside the nose. Three engine bells at the tail — one large centre, two smaller outboard. About twelve cyan emitter posts around the fuselage rim.

6. ORACLE — the ultimate scout: a flying weapon rack. Each wing carries a continuous stepped row of seven or eight rail barrels along its entire leading edge, with a large launcher pod faired into each wingtip. The wings are the longest and thinnest of the six, sweeping far back. Spanning the fuselage is a broad crescent fire-control sail — a thin curved wing of array panels ruled with fine seams, curving forward like a shallow bowl. Twin large hoppers, two dorsal dishes, a forest of forward-raked mast antennae. Three large engine bells. About sixteen cyan emitter posts around the fuselage rim. A large glowing cyan reactor core disc at the fuselage centre with a bright white-cyan middle and concentric dark rings, with heavy power conduits branching outboard to every wing hardpoint. Lethal, elegant and impossibly thin.

LAYOUT: arrange the six ships in a grid of 3 columns by 2 rows — cells 1, 2, 3 across the top row left to right, then cells 4, 5, 6 across the bottom row. One ship per cell, generously and evenly spaced, never overlapping or touching. Each ship is drawn large enough to fill most of its own cell with legible detail; let the later designs read as somewhat larger than the earlier ones, but do NOT scale them to true relative size — even the smallest must be drawn large and fully detailed.

Style: flat vector game sprite art, top-down orthographic view seen from directly overhead — no perspective, no tilt, no camera angle. Every ship points RIGHT with its nose toward the right edge of its cell, and is perfectly bilaterally symmetric about its own horizontal centreline. Hard-edged cel art: flat colour fills with a single dark outline. No gradients, no glow, no bloom, no drop shadows, no ambient occlusion, no texture noise, no specular highlights. Strictly limited palette: hull plating #dce6f2, secondary plating #9fb0c6, dark machinery and greebles #57637a, outlines and panel seams #2b3444, energy accents #7adcff, hot core centre #e8f7ff. Transparent background. Crisp, clean, high contrast, poster-like, suitable for automatic tracing to SVG. No text, no labels, no numbers, no captions, no watermark, no UI, no stars, no background scenery, no grid lines or cell borders.
```

---

# BRAWLER — the sheet

Tier ladder: 0 BRUISER · 1 MAULER · 2 BREAKER · 3 BULWARK · 4 RAMPART · 5 COLOSSUS.

```
A sprite sheet for a top-down 2D space game, showing the six-tier upgrade ladder of a single armoured assault ship class — six distinct ship designs of escalating power, all clearly built by the same shipwright.

SHARED DESIGN LANGUAGE across all six: a broad, front-heavy wedge hull, wide at the shoulders and tapering to a narrow tail, with mass piled toward the bow. A thick chisel-edged ram prow across the front, armour plating that is visibly heaviest at the bow and thins toward the stern, heavy rivet rows and thick panel seams throughout, and engine bells at the tail with thin cyan exhaust slits. Crucially, on every one of the six the REAR of the hull is conspicuously less armoured than the front — exposed dark frame and thin plating behind the engines. No wings, no fins, no antennae: this class is a fist.

The six cells, in order:

1. BRUISER — the smallest and stubbiest. A short broad wedge with a thick blunt ram prow, a heavy chisel-edged block of armour noticeably thicker than the rest of the hull. Heavy shoulder plating, one engine bell, a single narrow cyan viewport slit in the prow. Bare, riveted, industrial.

2. MAULER — the same short wedge, now with a curved deflector plate mounted ahead of the prow: a thick armoured arc spanning the bow, standing off the hull on two heavy hinge pivots with a visible gap behind it. Twin engine bells side by side. The rear third shows bare dark frame and exposed machinery.

3. BREAKER — a broader wedge with a toothed ram prow, its chisel edge notched into three blunt teeth. The curved deflector plate stands ahead of the bow on heavy hinges. Thick impact ribs run back from the prow along both shoulders, and flat kinetic sling rails lie along each flank ending in small cyan emitter blocks. Twin engine bells.

4. BULWARK — a broad, deep wedge. The bow carries a segmented deflector of three overlapping armour slabs in a shallow arc, each on its own heavy hinge pivot with visible gaps. Behind them, a toothed ram prow. Thick buttresses brace the shoulders into the hull, impact ribs run the flanks. A row of small lit cyan windows along each flank, and a small glowing cyan reactor core disc showing through an armoured slot at the hull's centre. Twin engine bells; thin, gapped tail plating.

5. RAMPART — a mobile battering ram. A layered deflector of five overlapping armour slabs on heavy hinge pivots forms a shallow arc across the whole bow. Behind it, a massive toothed ram prow with a cyan-lit kinetic slot down its centre. Outboard armour sponsons bulge from both shoulders on thick buttresses; impact ribs and kinetic sling rails run the full length of both flanks. Three engine bells — one large centre, two smaller outboard. Rows of lit cyan windows, a glowing cyan core in an armoured slot.

6. COLOSSUS — the ultimate assault ship: a fortress built around a battering ram. The bow is a full brow of layered armour, seven overlapping deflector slabs on massive hinge pivots in a continuous shallow arc across the entire width, stacked in two staggered layers. Behind them, a colossal hammerhead ram prow wider than the hull itself, its chisel edge notched into heavy teeth with a bright cyan kinetic slot glowing down the centre line. A spine of thick impact ribs runs the hull's length; outboard armour sponsons and heavy buttresses flare from both shoulders; long kinetic sling rails with cyan emitter blocks flank both sides. Four engine bells — two large centre, two outboard. A large glowing cyan reactor core disc at the hull's centre, bright white-cyan in the middle, set in an armoured slot with concentric dark rings and tick marks. Brutal, layered, slab-sided — a siege engine that is still visibly thin-skinned at the stern.

LAYOUT: arrange the six ships in a grid of 3 columns by 2 rows — cells 1, 2, 3 across the top row left to right, then cells 4, 5, 6 across the bottom row. One ship per cell, generously and evenly spaced, never overlapping or touching. Each ship is drawn large enough to fill most of its own cell with legible detail; let the later designs read as somewhat larger than the earlier ones, but do NOT scale them to true relative size — even the smallest must be drawn large and fully detailed.

Style: flat vector game sprite art, top-down orthographic view seen from directly overhead — no perspective, no tilt, no camera angle. Every ship points RIGHT with its nose toward the right edge of its cell, and is perfectly bilaterally symmetric about its own horizontal centreline. Hard-edged cel art: flat colour fills with a single dark outline. No gradients, no glow, no bloom, no drop shadows, no ambient occlusion, no texture noise, no specular highlights. Strictly limited palette: hull plating #dce6f2, secondary plating #9fb0c6, dark machinery and greebles #57637a, outlines and panel seams #2b3444, energy accents #7adcff, hot core centre #e8f7ff. Transparent background. Crisp, clean, high contrast, poster-like, suitable for automatic tracing to SVG. No text, no labels, no numbers, no captions, no watermark, no UI, no stars, no background scenery, no grid lines or cell borders.
```

---

## What happens to the images

They get traced by eye into per-tier spec tables shaped like `SHIP_TIERS` (render.js:4565) — body
radius, nose length, plate arcs, pod bearings, engine count — not embedded as bitmaps. So the useful
properties of a generation are, in order:

1. **A clean, readable silhouette.** Everything else is recoverable; a muddy outline is not.
2. **Symmetry.** Asymmetric detail can't be ported to the mirrored draw loop without a redesign.
3. **Feature placement legible as angles and radii** — a hardpoint at "two-thirds out along the wing"
   ports directly; an organically-blended blob does not.
4. **Family cohesion across the six cells** — the reason for one sheet.
5. Colour accuracy matters least. The palette constants live in render.js and get re-applied anyway.
