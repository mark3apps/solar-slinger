# The rock fracture library — design + implementation plan

> **Status: PART BUILT.** The library, the bake and the narrow phase exist and are verified. Nothing
> is wired into the sim yet — `physics.js` still runs the old sampled collider. When it lands, the
> laws move into [design-laws.md](design-laws.md) and
> [physics-invariants.md](physics-invariants.md) and this file shrinks to a pointer.
>
> | | |
> |---|---|
> | ✅ `tools/bake-rocks.mjs` | authors the tree by cutting, decomposes, asserts its own output |
> | ✅ `src/rockdata.js` | 68 baked shapes — 5 giants, 18 mids, 45 smalls. 44 KB |
> | ✅ `src/rockshape.js` | SAT narrow phase: true MTV, real manifolds |
> | ✅ `tools/test-rockshape.mjs` | 17,839 checks green |
> | ✅ `tools/rockviz.html` | look at the library and verify the pieces tile |
> | ⬜ wiring into `physics.js` | the old collider is still the one running |
> | ⬜ soft rails | |
> | ⬜ the fracture itself | |
> | ⬜ deleting the old machinery | |

## Why

`util.rockShape` generates a star-shaped radial polygon per body id and the collider samples it at
runtime: a 256-entry LUT, a per-edge normal table, a 32-sector directional reach bound, a 7-sample
penetration probe, and an exact-vs-conservative arbitration in the packer. That machinery has been
extended four times this session and still cannot produce a true minimum-translation vector — the
depth comes from the deepest sample and the direction from a separate face normal, and the two
disagree. Overlap accumulates during play (265 pairs over 600s idle, all both-railed) because a
resting contact never resolves to a correct separation.

The fix is to stop computing shape at runtime. Bake a small library of asteroid outlines, bake their
convex decompositions alongside, and let the collider do lookup + transform.

## The shape is a TREE, not a set

A giant breaks into 3–4 mids, a mid into 2–3 smalls, a small into ordinary asteroids. The pieces have
to match the parent they came from — which is only guaranteed if they are **a partition of it**.

**Author the parent, then cut it.** Never author a child independently and try to make it fit.

```
giant  ──cut──▶  4 mids  ──cut──▶  3 smalls each  ──▶  ordinary asteroids (existing gravel path)
```

- 5 giants × ~3.5 = ~18 mids × ~2.5 = ~44 smalls. **~67 authored polygons**, all baked offline.
- The leaf tier is NOT authored. A small's children are ordinary asteroids — they already exist, they
  collide as circles, they draw from the sprite atlas. The tree stops where the polygon collider
  stops paying for itself.
- Cuts are **jagged polylines**, not straight chords, or every break reads as a knife cut. Three or
  four segments with a little lateral noise is enough.
- Because a child is a sub-polygon, its area is exact. **Mass splits by baked area fraction and
  conserves exactly** — no fudge factor, no drift down the tree.

## The bake

An offline script (`tools/bake-rocks.mjs`, run by hand, output committed) — not a build step. The
edit-reload loop stays intact because the output is a plain ES module of arrays.

1. **Generate candidates** with the existing `util.rockOutline` under a fixed seed. It already encodes
   the law that a rock is never a perturbed primitive and never convex — lobes, stretch, 1/f grain,
   half-plane facets, concave bites. Reuse it; don't hand-draw and lose that.
2. **Pick ~5 giants by eye** from the candidate sheet. This is the only subjective step.
3. **Cut recursively.** Pick a cut axis through the polygon's long dimension, jitter it, clip the
   polygon against it (Sutherland–Hodgman handles the convex case; a general polygon needs a proper
   polyline split, since a concave bite can produce two pieces on one side — keep both).
4. **Convex-decompose every node** — ear-clip to triangles, then Hertel–Mehlhorn merge across
   non-essential diagonals. Target ≤6 hulls per shape.
5. **Precompute per node:** outline verts, hulls, area, centroid, polar moment of inertia (about the
   centroid, unit density), bounding radius, and — for children — the offset + rotation of the child
   **in the parent's local frame**.
6. **Emit** at 3-decimal precision. ~67 shapes × ~50 points ≈ 60 KB. Trivial next to the LFS beds.

Verify the bake, don't trust it: assert every hull is convex and wound consistently, that child areas
sum to the parent's within 0.5%, and that no child polygon self-intersects.

## Runtime

**Collide:** SAT over the two bodies' hull lists, transformed by position/rotation/scale. Exact MTV
falls out of SAT for free — that is the whole point. Contact manifold by edge clipping (2 points for
a face–face contact, 1 for a vertex–face), then a sequential-impulse solver with real mass, the baked
inertia, restitution and Coulomb friction. Positional correction uses Baumgarte with slop, so a
resting contact stops fighting the rail instead of being shoved apart every frame.

**Scale:** collider = hull verts × `b.radius`. Uniform scale cannot break convexity, so one baked
decomposition is valid from a 20-unit chip to a 400-unit monolith. Inertia scales as `r⁴`, area as
`r²`.

**Break:** spawn each child at `parent.pos + rot(child.offset) * parent.scale`, inheriting parent
velocity plus a small separation impulse along the outward direction from the parent centroid. Mass
from the baked area fraction. Then **soft-rail** each piece onto a rail computed from its actual
post-break position and velocity — see below.

**Variety** is rotation × mirror × scale × decals, not geometry. 5 giants is not 5 visible rocks;
combined with free rotation, mirroring and the existing per-rock crater/detail pass it reads as far
more variation than the current per-id generation, and none of it touches the collider.

## Decisions taken

- **Scars are cosmetic decals.** They no longer compose onto the collision profile. This is a
  deliberate narrowing of the crumble law: *worlds* keep "the crater you see is the crater you can
  fly into"; *rocks* express damage by breaking apart instead of by being eroded. Damage state on a
  rock is a decal set plus a hp value, nothing geometric.
- **Field rock breaks easier** than it does today, because breaking is now the interesting outcome
  rather than a failure of the collider. `FIELD_BIG_HP_MUL` comes down; the exact value is a tuning
  pass after the collider is trustworthy.
- **Scope is `bigShape` bodies only.** Belt gravel, planet chunks and crust slabs keep circles and the
  atlas. A polygon collider on a 6-unit pebble is wasted work and would blow the perf budget.
- **The library replaces per-id generation for landmarks only.** `util.rockOutline` survives as the
  bake-time generator and as the gravel silhouette source.

## Soft rails

The current railed/derailed split is binary, which is why the pass-through guard exists and why both
sides of an overlapping pair can be railed and neither can respond. Replace it for field rock with a
**soft-railed** state: the body is a real dynamic body that carries a home (`setFieldHome`'s
`homeTan`/`homeRad` in the pocket frame) and is pulled toward it. It always responds to contact; it
always drifts back. There is no state in which it cannot move.

A fresh break computes its own rail from where it actually is and how fast it's actually going, then
eases onto it — "newly calculated", not inherited from the parent. The return is deliberately slow
(`FIELD_HOME_A` / `FIELD_HOME_K` are the knobs and want retuning once nothing is glued).

This is what fixes the accumulating overlap: a resting pair with a correct MTV and a slop-tolerant
positional correction settles instead of interpenetrating, and neither body is ever in a state that
forbids it from separating.

## Interaction with the debris budget

The fracture chain is **player-driven, one level per kill** — it does not violate invariant 7b
(a split must not chain), but the implementation has to prove that. A single hit must destroy at most
one node and spawn only its direct children. `CHUNK_INERT` and the `chainOk` credit rule apply
unchanged to the pieces, and every spawned piece counts against `DEBRIS_BUDGET` (1500) like any other
fragment. Worst case is one giant fully worked down: 4 + 12 ≈ 16 authored pieces plus their eventual
gravel — well inside budget, but it must be *counted*, not assumed.

## What this deletes

The clearest signal the direction is right. All of the following goes away:

| Gone | Where |
|---|---|
| `rockShape` LUT + normal table + sector table | util.js |
| `rockSurfAt`, `rockNormalAt`, `rockReachAt`, `rockSectors` | util.js |
| `bigRockSurfAt`, `surfReach`, the `bigShape` branch of `surfRadius` | physics.js |
| `bigPenetration` (the 7-sample probe) and its `_probeX`/`_probeY` stash | physics.js |
| `applyBigFriction`'s bolted-on angular response | physics.js |
| the railed-pair pass-through guard and `stuckPair` fall-through | physics.js |
| `pairClearance` and the conservative-bound-vs-exact-probe arbitration | world.js |
| `FIELD_REACH`, `FIELD_REACH_FALL` and the reach-widened clearance test in `packBigRock` | config.js / world.js |

The packer's clearance test becomes exact convex SAT against a handful of hulls — cheaper than what
it does now and correct, which kills the entire bug class that produced seed-time interlocking.

## Measured, once built

The numbers that decide whether this was worth doing. From `tools/test-rockshape.mjs`:

| | |
|---|---|
| realistic overlapping pairs tested | 3,000 |
| **still interpenetrating after resolution** | **0** |
| separated in one iteration | 98% (2,940) — 58 in two, 2 at the cap |
| worst residual | 0.06% of the original penetration |
| contact points inside both bodies | within 0.1% of the surface |
| hulls per shape | mean 4.0, max 12 |

"Realistic" is load-bearing in that table. Pairs are placed by bisecting for the exact touching
distance and then pushing in 0.5–18 units, because that is what a substep can produce: at `CFG.DT`
even a fast throw penetrates ~17 units against rocks 40–400 across, and a resting contact under one.
An earlier version of the suite dropped bodies at a random fraction of combined reach — one monolith
most of the way inside another — and failed 46% of them. That configuration cannot occur, and tuning
the collider to handle it would have cost the case that occurs constantly. The deep-interlock numbers
are still *reported* by the suite, just not gated.

## Order of work

1. ~~Bench baseline~~ — taken.
2. ~~**Revert the body-count bump**~~ — `FIELD_ROCKS` 1250 → 800, `FIELD_GIANTS` 760 → 450. Done.
3. ~~Bake script + library + assert suite.~~ Done.
4. New collider behind a flag, `bigShape` pairs only. A/B it against the old path in one session
   (interleaved — the perf bench swings ±50-90% across sessions on unchanged code).
5. Soft rails; retune the home-return.
6. Fracture: break → children → new rails.
7. Delete the old machinery, retune `FIELD_BIG_HP_MUL`, re-run `window.mechTest()` (19/19) and a soak.

### Notes for the wiring

- `rockContacts(a, b)` returns a LIST, deepest first, capped at 4 — one manifold per overlapping hull
  pair. Do not collapse it to one. A decomposed body has no single MTV, and taking only the deepest
  left 46% of pairs still overlapping, which is the old collider's failure by another route.
- The normal is **not** guaranteed to point along centre-to-centre, and must not be re-derived from
  it. Two rocks catching on a corner legitimately produce a normal pointing back across that line —
  that is the behaviour shaped collision exists to have, and assuming otherwise is precisely what
  made the old resolver read as skating sideways down a slab.
- `b._hw` (world hull cache) and `b._rs` (resolved shape) must be cleared when a body's shape or
  radius changes — on a break, above all.
- `hulls` is a coarser polygon than `v`. `v` is what the player sees; `hulls` is what they hit. They
  agree to 1.2% of reach, and the simplification only ever removes area, so the collider sits
  fractionally inside the silhouette rather than outside it.

## Still open after this

Roads not reading visually is a **separate** problem and this does not fix it. Measured, the lanes
are genuinely clear (cover 0.013 inside vs 0.200 outside, 15×) but occupy only 9.3% of pocket area
and their surroundings aren't dense enough to form walls. That's a density-contrast problem, and it
gets easier once the body count can go back up safely — which depends on the collider being cheap.

## The shoal size law, stated correctly

Recorded because it has been misread repeatedly, each time producing a different wrong pocket.

**THE SIZE RANGE WIDENS TOWARD THE CORE. IT DOES NOT SLIDE.** The *top* of the range scales up as
you go in; the *bottom* stays exactly where it is at every radius. The core holds monoliths **and**
pebbles **and** ordinary asteroids. The rim holds only the small end. Flying in, what changes is that
big things start being possible — not that small things stop.

What this rules out, all of which have been built and are all wrong:

- A band that slides inward (small band at the rim, mid band in the middle, big band in the core).
  That empties the core of small rock, which is the complaint.
- Biasing small rock inward to compensate (`FIELD_EDGE_POW` above 1). That just moves the hole to the
  rim — measured, outer-third coverage fell to 0.007 and there was nothing to fly in through.
- Skewing the mass ladder hard toward small (`FIELD_GIANT_SKEW` 0.14). That does not make a gentle
  gradient, it collapses the class into one bucket and leaves a HOLE: 843 rocks at 24-48 units, one
  at 96-128, none at 128-160, then monoliths appearing from nowhere at 160+.

**The mechanism in world.js is already right — the failure is placement order.** `setQMax` gives each
rock an allowance that falls as a power of its radius (`FIELD_REACH` / `FIELD_REACH_FALL`), so small
rock may go anywhere and big rock is confined to the core. That *is* "the top end scales, the bottom
end exists everywhere". What breaks it is that `packBigRock` runs **heaviest first**: the core is
saturated before small rock is ever drawn, so every small-rock candidate aimed at the core is
rejected and the leftovers land at the rim. The sampler is not the bug. The saturation is.

Two consequences worth chasing in that order:

1. **The core needs headroom, not a different sampler.** `FIELD_PACK_FRONT` is the valve (lower =
   rock spreads outward = core less full). Fixing saturation lets an area-uniform small-rock sampler
   land in the core on its own, which is why `FIELD_EDGE_POW` belongs near 0.5-0.85 and not above 1.
2. **Ordinary asteroids are filtered out of the core separately.** The rubble loop runs *after* the
   landmarks and clearance-tests every pebble (`roomAt`, `gravelClear`, the lane check). In a
   saturated core every one of those fails, so plain rock never gets in — reported as "we need the
   normal asteroids in the center as well, but that seems to be filtered out". This is the same root
   cause as (1) but it needs checking on its own: a pebble rejected for want of room is silently
   dropped, so the failure leaves no trace.
