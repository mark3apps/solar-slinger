// All gameplay tuning lives here.
export const CFG = {
  G: 8,                    // gravitational constant (gameplay-tuned)
  DT: 1 / 120,             // physics substep
  // Soft boundary radius. MUST exceed the outermost orbit reach (orbit +
  // moons), or the boundary force quietly deorbits the outer planets.
  // Beyond it lies the Oort cloud, which grinds the ship down.
  WORLD_R: 42000,
  OORT_WARN: 1400,         // warning distance before the cloud edge
  OORT_DPS: 6,             // hull damage/s at the edge, scaling with depth
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
  // The ship feels amplified gravity from everything — big suns and planets
  // should really pull on YOU (thrown objects and NPCs use normal G).
  SHIP_GRAV: 1.45,
  // How hard the sun grabs the SHIP (multiplies SHIP_GRAV for stars only).
  // Tunes as a pair with the sun's mass (world.js, 1.42e7): the ship-felt sun
  // pull and its cruise speed both scale with mass x this amp. It was
  // deliberately NOT raised when the sun mass was lowered to calm the sky —
  // slower cruise SHOULD come with a gentler pull (see the sky-speed notes in
  // world.js and on SHIP_ZOOM). Never touch one without considering the other.
  STAR_GRAV_SHIP: 0.8,
  // Planets, moons, and rogues also grab the ship extra hard — flying near
  // a world should FEEL like entering its well (total = SHIP_GRAV * this)
  PLANET_GRAV_SHIP: 3.0,
  // LONG ARMS (ship only): beyond SHIP_WELL_START planet radii, the
  // ship-felt pull of a world falls off as 1/r instead of 1/r² until the
  // boost caps at SHIP_WELL_MAX — wells reach farther WITHOUT deepening
  // close-range gravity. Applies only on the ship's gravity path (and its
  // mirror in predictPaths — keep them in sync); thrown rocks, aliens,
  // debris, and celestials are untouched.
  SHIP_WELL_START: 2.5,
  SHIP_WELL_MAX: 6,
  // ORBIT RUBBER BAND (ship only): inside SHIP_BAND_RANGE body radii (+300)
  // of a world, the INWARD radial component of the ship's velocity relative
  // to that world is damped by up to SHIP_BAND_DAMP/s (accel capped at
  // SHIP_BAND_MAX). Tangential motion is untouched — plunges soften into
  // captures and orbits circularize on their own. Outward radial velocity
  // is exempt ON PURPOSE: an assist must never become an escape jail.
  // Mirrored in predictPaths like the long arms.
  SHIP_BAND_RANGE: 4,
  SHIP_BAND_DAMP: 1.2,
  SHIP_BAND_MAX: 130,
  // SURFACE SKIMMING: grinding tangentially along a body while in contact
  // chews the hull (collideShipBody) — a gentle landing is free below
  // SKIM_SPEED, then dps = (tangential speed - SKIM_SPEED) * SKIM_DPS_K.
  // (A sub-orbital slide grinds continuously; a super-orbital graze lifts
  // off in a few substeps and only takes a scratch — both are intended.)
  SKIM_SPEED: 100,
  SKIM_DPS_K: 0.09,

  // Solar flares: the sun RARELY erupts plasma at ships that fly close.
  // A direct hit is a real event now: EMP kills the engines for
  // FLARE_ENGINE_OUT seconds and blows half the orbit shield loose.
  FLARE_RANGE: 5500,       // only fires while the ship is this close to the sun
  FLARE_SPEED: 750,
  FLARE_LIFE: 6,           // seconds of flight — flares fizzle ~4500 out
  FLARE_DMG: 26,
  FLARE_ENGINE_OUT: 3,     // seconds of dead engines after a direct hit

  // CORONA HEAT on BODIES/ALIENS: everything melts inside HEAT_ZONE x the
  // sun's radius (dps ramps depth²). Lava-born things are immune.
  // HEAT_ZONE must keep this zone's outer edge INSIDE the graveyard ring
  // (~3160): 1.30 x 2400 = 3120 — raise it and the wrecks start cooking
  // (any damage at all derails them; there is no "subtle" for railed bodies).
  HEAT_ZONE: 1.30,
  HEAT_DPS_BODY: 0.12,     // fraction of a body's maxHp per second at surface
  // CORONA HEAT on the SHIP: a wide envelope with an EXPONENTIAL ramp —
  // dps = HEAT_SHIP_DPS * e^(-(d - sunR) / HEAT_SHIP_FALLOFF). At the zone
  // edge it's a whisper (~0.01), at the graveyard ring ~2.5/s, at the
  // photosphere the full 42/s. Warmth warns long before it kills; the kill
  // only happens if you keep going.
  HEAT_SHIP_ZONE: 2.1,     // visual + damage envelope, x sun radius
  HEAT_SHIP_DPS: 42,       // dps at the photosphere
  HEAT_SHIP_FALLOFF: 300,  // e-folding distance of the ramp
  // Lava worlds radiate the same aura, weaker and SHIP-only (their own
  // moons must never cook on their rails)
  LAVA_HEAT_ZONE: 1.7,     // reach, x planet radius
  LAVA_HEAT_DPS: 12,
  // GAS DIVE: gas giants have no surface for the SHIP — it flies in.
  // Interior gravity uses enclosed mass (x d³/R³ of the point value, in
  // gravityAt + predictPaths) so climbing out stays possible while the
  // pressure crushes: dps = depth² x GAS_CRUSH_DPS; instant death inside
  // GAS_CORE x radius. Rocks and aliens still bounce off the cloud tops.
  GAS_CRUSH_DPS: 110,
  GAS_CORE: 0.30,

  // Celestial bodies feel full gravity from stars and their parent planet, but
  // only this fraction from other planets/moons/rogues. The ship, aliens,
  // debris, and anything you throw always feel FULL gravity from everything.
  // Without this, planet masses big enough to matter to the ship make the
  // systems gravitationally shred themselves within minutes.
  CROSS_GRAV: 0.15,
  // Non-anchor STARS are damped even harder for celestials: at 0.15 the
  // neighbor-star tide on outer planets is still ~8% of their own star's pull
  // (16x Jupiter-scale) and pumps them into their sun within ~8 minutes.
  CROSS_STAR: 0.05,

  // Body-vs-body impacts only deal damage above a closing-speed threshold —
  // ambient orbital traffic (asteroids drifting across planet orbits at
  // 100-300) must bounce harmlessly or the systems sandblast themselves to
  // death in minutes. Deliberately THROWN objects get a lower threshold and a
  // damage multiplier, so the tractor fling (and alien throws) stay lethal.
  DMG_BODY: 1.2e-6,        // dmg = K * (closing - threshold)^2 * otherMass
  // 240 is tuned to the sky speed (sun mass 1.42e7, world.js): ambient
  // crossing traffic closes at ~100-300, and this lets it bounce harmlessly
  // while real slams still bite. It was briefly raised to 340 when the sun
  // was 3.2e7 (1.4x faster sky); with the sky slowed back down it returns to
  // 240. Keep them in ratio if the sun mass changes again. THROWN keeps its
  // own low threshold — fling/alien-throw speeds are ship-derived, not orbital.
  DMG_THRESH: 240,         // closing speed below which impacts just bounce
  DMG_THRESH_THROWN: 140,  // threshold when either body was recently thrown
  DMG_THROWN_MULT: 2,
  // Ship impact damage: closing * DMG_SHIP * massSat, where massSat is the
  // impactor's mass saturating at 1 — the saturation knee SCALES WITH BEAM
  // TIER (1500 * (1 + tier * 1.2) in collideShipBody), so pebbles that
  // stung a scout barely tickle a dreadnought while planet slams always
  // hurt. Capped at 45% of max hull per hit.
  DMG_SHIP: 0.18,
  RESTITUTION: 0.35,

  // Speed governor: each engine level raises the ceiling; excess speed
  // (slingshots, knockbacks) bleeds off at SPEED_BLEED x the overage per
  // second, and NOTHING sustains beyond SPEED_HARD x the ceiling. The old
  // gentle bleed (0.8, no hard cap) predates the long-arm gravity boost —
  // 6x far-field assists let low-level ships coast at absurd speeds.
  // The ceiling is measured RELATIVE to the local orbital flow
  // (physics.orbitalFlow): the ship's velocity is capped to within maxSpeed of
  // the surrounding space's prograde circular velocity. The current carries the
  // ship and the engine buys maxSpeed of deviation in any direction — with the
  // spin you reach flow+maxSpeed, against it flow-maxSpeed. predictPaths mirrors
  // the bleed, the hard cap, AND the flow-relative reference; keep all in sync.
  SPEED_BLEED: 1.6,
  SPEED_HARD: 1.9,

  // Fair-view normalization: cam.zoom is scaled by the canvas diagonal so
  // EVERY window sees the same world extent — a small screen renders the
  // world smaller instead of cropping it, and a huge monitor grants no wider
  // view. At this reference diagonal (1920x1080) zoom equals the tuned
  // values exactly. Screen-space UI (DOM HUD, minimap, the /zoom stroke
  // idiom) is unaffected and never scales.
  VIEW_REF_DIAG: Math.hypot(1920, 1080),

  SHIP_TURN: 9,            // rad/s — the nose tracks the mouse
  // The SHIELD recharges after a quiet spell; the HULL never self-heals — it
  // mends only by collecting glow-pocket motes (glow.js)
  SHIP_REGEN: 9,           // shield/s once recharging
  SHIP_REGEN_DELAY: 5,     // seconds without damage before recharge starts

  PICKUP_MAGNET: 620,      // scrap starts homing inside this range
  DEBRIS_LIFE: 150,

  ORBIT_OMEGA: 1.5,        // rad/s — how fast the shield orbit spins
  // SHOTGUN volley: holding RMB arms orbiters progressively over this many
  // seconds (1 at a tap -> all at full charge); release fires what's armed,
  // and hitting full charge fires automatically
  VOLLEY_TIME: 2,

  // Rails: celestial bodies ride precomputed orbits until something disturbs
  // them (impulse, grab, or a heavy wanderer inside this range).
  RAIL_DISTURB: 1400,
  RAIL_RETRY: 2,           // seconds between re-rail scans
  RAIL_TOL: 0.16,          // max fractional deviation from circular to re-rail

  ALIEN_HP: 45,
  ALIEN_RADIUS: 13,
  ALIEN_ACCEL: 250,
  ALIEN_SPEED: 330,
  ALIEN_CAPACITY: 2600,    // heaviest rock an alien can grab
  ALIEN_THROW: 430,
  ALIEN_CONTACT_DMG: 24,
  ALIEN_FIRST_WAVE: 55,    // seconds of peace at the start
  ALIEN_WAVE_EVERY: 42,
  ALIEN_SCRAP: 28,
  ALIEN_TERRITORY: 6000,   // aliens defend their nest's turf, never roam past this
  ALIEN_BURST: 4,          // a nest can scramble up to this many at once

  // Solar storms: periodic charged waves sweeping the WHOLE system —
  // discovery weather, not a weapon. The front lights auroras on the worlds
  // it washes over, brightens comet tails, and gives loose scrap a gentle
  // outward push. It deals no damage and never touches celestials or rails.
  STORM_EVERY: 420,        // average seconds between storms — rare weather, not a metronome
  STORM_SPEED: 950,        // wave-front expansion speed (u/s)
  STORM_BAND: 700,         // half-thickness of the active front

  PREDICT_STEPS: 200,      // trajectory forecast resolution (ship path)
  PREDICT_DT: 1 / 30,
  HELD_STEPS: 60,          // the throw line is short (~2s of flight)...
  LOCK_T: 1.8,             // ...and lock-on only works within throw-line reach
};

// Tractor size tiers. Your ORBIT can hold objects one tier below what your
// BEAM can grab.
export const TIERS = {
  caps: [1200, 6000, 35000, 120000, 400000, 1200000],
  labels: ['Asteroids', 'Moons', 'Minor planets', 'Planets', 'Gas giants', 'Anything but stars'],
};

// Per-tier collision radius. DERIVED, not hand-picked: the ship's full drawn
// FOOTPRINT (nose tip / outer ring — shipVisualR) grows by the SAME RATIO
// each tier (x1.62, from 6.0 to 67 world units — equal RATIOS, not equal
// increments: the eye judges size change multiplicatively), and the collision
// circle is a UNIFORM fraction of that footprint on every tier:
//   SHIP_RADIUS[t] = SHIP_HIT_FRAC × footprint[t]
// History: the collision circle used to be the drawn body DISC only, which
// covered 43% of the visual reach at tier 0 but ~57% at tier 5 — rocks
// visibly sailed through the scout's nose, and the hitbox feel changed tier
// to tier ("collision size doesn't match the ship"). 0.66 covers the solid
// hull mass everywhere while leaving nose tips and thin ring arcs forgiving.
// render.js normalizes the art to the footprint (r / SHIP_HIT_FRAC), so
// changing the fraction moves ONLY the hitbox, never the drawn size.
export const SHIP_HIT_FRAC = 0.66;
export const SHIP_RADIUS = [4.0, 6.4, 10.4, 16.8, 27.3, 44.2];

// Per-tier camera zoom TARGET (the value cam zoom eases toward): a
// geometric ramp from 2.46 to 0.6 — each step recedes by the same ~25%
// RATIO. The start value is DERIVED, not aesthetic: it makes the ship's
// APPARENT on-screen size arc identical to the approved one (~15px-eq
// scout -> ~40px-eq titan) while the ship's WORLD size shrank — small
// ships look the same in the viewport but tiny next to planets. The pairing
// anchor is the drawn FOOTPRINT ladder (SHIP_RADIUS ÷ SHIP_HIT_FRAC): change
// THAT and you must re-derive this — retuning SHIP_HIT_FRAC alone moves only
// the hitbox and needs no zoom change. Zoom is driven by beam tier
// alone — other progression tracks don't pull the camera back.
// NOTE: this tight tier-0 zoom is why the SKY SPEED is tuned low (the sun's
// mass, world.js) — the world scrolls past ~2x faster per zoom unit, so a
// fast sky at this zoom reads as flying wildly fast. Flight feel = sky speed
// x zoom; they tune together. Raise this zoom and the sun mass must drop.
export const SHIP_ZOOM = [2.46, 1.86, 1.40, 1.06, 0.80, 0.60];

// Per-tier ship CLASS name (matches the hull designs drawn in render.js
// SHIP_TIERS). Distinct from st.label, which names what your BEAM can grab.
export const SHIP_NAMES = ['Scout', 'Fighter', 'Corvette', 'Cruiser', 'Dreadnought', 'Titan'];

// ROGUELITE PROGRESSION (spec-based). The RUN OPENS on a SPECIALIZATION choice
// (SPECS — main.startGame -> the 'spec' modal); it sets your starting kit and gates
// which named ABILITIES you can be offered. The core grab/throw/fly loop is base
// (shipStats), so every spec is playable at once. Doing good things (grab, smash,
// skim, kill, collect, survey, slingshot, shield-block) grants XP; crossing a
// threshold PAUSES the game for a pick. SMALL picks (rankChoices) only DEEPEN
// abilities you already own. Every PICKS_PER_TIER small picks the next pick is a
// TIER-UP milestone: choose 1 of 2 random NEW abilities from your spec's pool
// (tierChoices — soft-floored by minTier), and the tier-up also auto-levels your
// whole learned build once (applyTierUp) + a life. Death spends a life (build
// kept); 0 lives = game over and a fresh spec choice.
export const PROG = {
  START_LIVES: 3,
  MAX_LIVES: 5,
  PICKS_PER_TIER: 3,       // small picks before a tier-up milestone
  // XP-to-next-pick: BASE + STEP*level + CURVE*level² (level = picks taken).
  // FRONT-LOADED PACING (user design rule): tier 0 must feel MUCH faster than
  // the old flat band, with the cost shifted onto the later tiers — the old
  // linear curve (145 + 58*level) priced every tier in the same band (tier t
  // total = ~928*(t+1)), so the opening crawled exactly like the midgame. The
  // quadratic redistributes it: per-tier totals run 462 / 1278 / 2478 / 4062 /
  // 6030 vs the old 928 / 1856 / 2784 / 3712 / 4640 — tier 0 is ~2x faster,
  // tiers 1-2 cheaper, tiers 3+ pricier, and the WHOLE climb to max tier stays
  // within ~3% of the old grind (14310 vs 13920), so it's a reshape, not a
  // buff. First pick lands at 60 XP: a survey + a catch, or a few smashes —
  // the opening upgrade should arrive inside the first couple of minutes.
  XP_BASE: 60,
  XP_STEP: 30,
  XP_CURVE: 3,
  // XP awards per action (tuned in the balance-test soak — see CLAUDE.md)
  XP_CATCH: 6,             // + up to 20 scaled by mass vs capacity
  XP_SMASH: 10,            // + 12 for a big kill
  XP_SCRAP: 0.5,           // per unit of debris-chunk value collected
  XP_ORBIT: 8,             // stow a rock into the orbit shield
  XP_BLOCK: 14,            // a shield rock intercepts an alien throw
  XP_SURVEY: 40,           // chart a world
  XP_SKIM: 0.7,            // per hull-point ground off while skimming a surface
  XP_SLING: 0.6,           // per unit of speed gained in a clean slingshot
  // Life pods: sparse world collectibles that refill the buffer
  LIFE_R: 62,              // collect radius
  LIFE_MAX_ACTIVE: 1,      // at most this many adrift at once
  LIFE_RESPAWN: 150,       // avg seconds between respawns (only while under MAX_LIVES)
  // Glow pockets (glow.js): sparse clusters of small bioluminescent motes that
  // ride the belt's prograde orbit, scattered thin across the whole mid system.
  // Motes are SLIGHTLY MAGNETIC — drift near one and it leaps into the ship,
  // popping just BEFORE the hull touches it, for a little hull + XP. Glow pockets
  // are the ONLY place the hull heals mid-life (design law; it otherwise only
  // resets on respawn). Pockets never refill where you stand: as one is drained
  // it vanishes and a fresh pocket fades in ELSEWHERE, so the healing supply
  // constantly relocates and you're always flying on to the next one.
  GLOW_POCKETS: 48,        // active pockets kept scattered across the system
  GLOW_RMIN: 4200,         // orbital band they scatter through — just above the graveyard ring
  GLOW_RMAX: 31000,        // ...out to the far ice belt
  GLOW_SPREAD: 480,        // field radius — WIDE, so you sweep the ship through it (and it's easy to spot)
  GLOW_MOTES: 9,           // motes in a fresh pocket (more, to keep the wide field dense enough to scoop)
  GLOW_R: 6,               // pop gap beyond the hull — the mote flies ALL the way in and pops AT the ship
  GLOW_MAGNET: 170,        // capture range — once the ship is this close a mote commits and vacuums in
  GLOW_HOME_MIN: 240,      // homing speed the instant a mote is captured...
  GLOW_HOME_MAX: 900,      // ...ramping up to this — faster than the ship, so it always reaches the hull
  GLOW_HOME_ACCEL: 1600,   // homing acceleration (u/s²): the vacuum ramp from MIN to MAX
  GLOW_HEAL: 4,            // hull points mended per mote (small — there are many)
  GLOW_XP: 3,              // XP per mote
};

// SPECIALIZATIONS. You pick ONE at the start of a run (main.startGame -> the 'spec'
// modal). It sets your starting kit and gates which named ABILITIES you can be
// offered at tier-ups. The core grab + throw + fly loop is UNIVERSAL (shipStats
// bases), so every spec is playable from the first frame; the kit + tree layer on.
// KIT RULE (design law): every kit must contain at least THREE abilities with
// max > 1 — tier-0 small picks can only deepen owned abilities (rankChoices), so
// fewer rankable tracks makes the first three picks a non-choice (SCOUT once
// shipped with a lone rankable track because Retro Jets is a max-1 unlock that
// arrives already maxed — count max-1 unlocks as flavor, not as a track).
export const SPECS = [
  { id: 'brawler', name: 'BRAWLER', icon: '※',
    desc: 'Smash, ram, and shatter. Throws hard, flies tanky.',
    start: ['kineticSling', 'reinforcedHull', 'heavyRounds'] },
  { id: 'hauler', name: 'HAULER', icon: '◎',
    desc: 'Master of the beam — long reach, big hauls, orbit shields.',
    start: ['longArmTractor', 'salvageMagnet', 'heavyWinch'] },
  { id: 'scout', name: 'SCOUT', icon: '◇',
    desc: 'Eyes and speed — sensors, precision, and mobility.',
    start: ['tunedThrusters', 'retroJets', 'navPlotter', 'leadComputer'] },
];

// The named-ability catalog. Each ability has an OWNER spec, ranks (small picks
// deepen it), and a `minTier` soft-floor (it can't be OFFERED until you've
// reached that tier). An optional `also: { specId: minTier }` map shares the
// ability with OTHER specs at (usually higher) tier floors — the Scout sensor/
// QoL chain (Retro Jets, Gravity Compass, Nav Plotter, Lead Computer, Impact
// Warning) reaches every spec this way: Scout gets them at tier 0, everyone
// else buys in later. `channel` is the stat bucket it feeds — shipStats sums
// each owned ability's rank into its channel and derives everything from those
// totals, so several abilities can stack the same channel.
// NAMING LAW (user design rule): two abilities that DO the same thing carry the
// SAME name/icon/desc even across specs (Heavy Winch is the catch starter in
// both BRAWLER and HAULER; Reinforced Hull is the hull track in both — ids stay
// distinct, they're separate catalog rows). Same-spec second tracks (Grapple
// Extenders, Expanded Bay, Overtuned Drive, Bulk Freighter, Juggernaut) are the
// deliberate exception: they must stay separately named to coexist as distinct
// cards, so their descs read as "more of the same" instead. BRAWLER's runtime abilities
// (Ram Prow, Cluster Rounds, Shockwave, Berserker, Demolition, Juggernaut) are
// live — their hooks live in physics.js (collideShipBody + brawlerThrowKill) and
// tractor.js (Berserker fling). HAULER's: Recovery Tether + Twin Grip (tractor.js),
// Aegis Reflector (physics collideBodies), Rockwall (physics damageBody hardening
// + tractor orbit spin). SCOUT's: Afterburner (fuel tank in main.js, thrust +
// governor in physics), Dash Jets (A/D — main.onDash), Reflex Jink (the
// auto-dodge scan in physics.step), Slipstream (main.onWarp), Recon Drone
// (world.js survey). All three specs' runtime abilities are live.
export const ABILITIES = [
  // 🥊 BRAWLER
  { id: 'kineticSling',   spec: 'brawler', name: 'Kinetic Sling',  icon: '➹', channel: 'fling',  max: 6, minTier: 0, weight: 1.0, desc: 'Hurl held rocks harder.' },
  { id: 'reinforcedHull', spec: 'brawler', name: 'Reinforced Hull', icon: '▤', channel: 'hull',  max: 6, minTier: 0, weight: 1.0, desc: 'Raise maximum hull.' },
  { id: 'scattergun',     spec: 'brawler', name: 'Scattergun',     icon: '☄', channel: 'volley', max: 3, minTier: 0, weight: 1.1, desc: 'Right-click to blast your orbit rocks outward.' },
  { id: 'heavyRounds',    spec: 'brawler', name: 'Heavy Winch',    icon: '✦', channel: 'catch',  max: 6, minTier: 0, weight: 1.0, desc: 'Grab and hurl much heavier rocks.' },
  { id: 'bulwarkRing',    spec: 'brawler', name: 'War Rack',       icon: '◒', channel: 'orbit',  max: 4, minTier: 0, weight: 1.1, desc: 'Drag captured rocks behind you as shotgun ammo (moon-size max).' },
  { id: 'warPlating',     spec: 'brawler', name: 'War Plating',    icon: '⛨', channel: 'shield', max: 6, minTier: 0, weight: 0.9, desc: 'A heavy regenerating shield — FRONT ARC ONLY. Your tail stays bare.' },
  { id: 'ramProw',        spec: 'brawler', name: 'Ram Prow',       icon: '△', channel: 'ram',        max: 4, minTier: 0, weight: 1.0, desc: 'Ram bodies for damage and take less from impacts.' },
  { id: 'clusterRounds',  spec: 'brawler', name: 'Cluster Rounds', icon: '❋', channel: 'cluster',    max: 3, minTier: 0, weight: 1.0, desc: 'Your throw-kills burst into grabbable shrapnel.' },
  { id: 'shockwave',      spec: 'brawler', name: 'Shockwave',      icon: '◎', channel: 'shockwave',  max: 3, minTier: 0, weight: 1.0, desc: 'Throw-kills knock nearby bodies back.' },
  { id: 'berserker',      spec: 'brawler', name: 'Berserker',      icon: '✷', channel: 'berserk',    max: 3, minTier: 3, weight: 0.9, desc: 'The lower your hull, the harder you throw and ram.' },
  { id: 'demolition',     spec: 'brawler', name: 'Demolition',     icon: '✸', channel: 'demolition', max: 3, minTier: 3, weight: 0.9, desc: 'Throw-kills detonate, damaging everything nearby.' },
  { id: 'juggernaut',     spec: 'brawler', name: 'Juggernaut',     icon: '⬢', channel: 'ram',        max: 3, minTier: 3, weight: 0.9, desc: 'A devastating ram and a much tougher hull.' },

  // 📡 HAULER
  { id: 'longArmTractor', spec: 'hauler', name: 'Long-Arm Tractor', icon: '⤢', channel: 'reach',  max: 6, minTier: 0, weight: 1.0, desc: 'Extend tractor range and grab forgiveness.' },
  { id: 'salvageMagnet',  spec: 'hauler', name: 'Salvage Magnet',   icon: '⦿', channel: 'magnet', max: 6, minTier: 0, weight: 1.0, desc: 'Vacuum scrap and motes from farther away.' },
  { id: 'orbitalSling',   spec: 'hauler', name: 'Orbital Sling',    icon: '◍', channel: 'orbit',  max: 4, minTier: 0, weight: 1.1, desc: 'Stow rocks into a defensive orbit ring.' },
  { id: 'heavyWinch',     spec: 'hauler', name: 'Heavy Winch',      icon: '✦', channel: 'catch',  max: 6, minTier: 0, weight: 1.0, desc: 'Grab and hurl much heavier rocks.' },
  // HAULER has NO energy shield ON PURPOSE (design law): the orbit rock wall IS
  // its protection — Rockwall/Reinforced Hull harden that identity instead.
  { id: 'cargoPlating',   spec: 'hauler', name: 'Reinforced Hull',  icon: '▤', channel: 'hull',   max: 4, minTier: 0, weight: 0.9, desc: 'Raise maximum hull.' },
  { id: 'grappleExtenders', spec: 'hauler', name: 'Grapple Extenders', icon: '⤢', channel: 'reach', max: 6, minTier: 0, weight: 1.0, desc: 'More reach and grab forgiveness.' },
  { id: 'expandedBay',    spec: 'hauler', name: 'Expanded Bay',     icon: '◍', channel: 'orbit',  max: 4, minTier: 0, weight: 1.0, desc: 'More orbit slots.' },
  { id: 'rockwall',       spec: 'hauler', name: 'Rockwall',         icon: '⛉', channel: 'rockwall', max: 3, minTier: 0, weight: 1.0, desc: 'Orbit rocks are far tougher and spin faster to block.' },
  { id: 'bulkFreighter',  spec: 'hauler', name: 'Bulk Freighter',   icon: '❖', channel: 'catch',  max: 6, minTier: 3, weight: 0.9, desc: 'Haul planet-scale masses.' },
  { id: 'recoveryTether', spec: 'hauler', name: 'Recovery Tether',  icon: '↩', channel: 'tether', max: 3, minTier: 0, weight: 1.0, desc: 'Your thrown rocks curve back into your orbit.' },
  { id: 'aegisReflector', spec: 'hauler', name: 'Aegis Reflector',  icon: '❂', channel: 'aegis',  max: 3, minTier: 3, weight: 0.9, desc: 'Orbit rocks hurl intercepted enemy fire back.' },
  { id: 'twinGrip',       spec: 'hauler', name: 'Twin Grip',        icon: '⇄', channel: 'twin',   max: 1, minTier: 3, weight: 0.9, desc: 'Hold and throw two rocks at once.' },

  // 🔭 SCOUT
  { id: 'tunedThrusters', spec: 'scout', name: 'Tuned Thrusters', icon: '⏩', channel: 'engine',    max: 6, minTier: 0, weight: 1.0, desc: 'Faster thrust and a higher speed ceiling.' },
  // The sensor/QoL chain is SHARED (`also`): Scout-native at tier 0, offered to
  // the other specs later — max-1 flight unlocks at tier 1, rankable sensor
  // tracks at tier 2 (below the tier-3 capstone band so they don't crowd it).
  { id: 'retroJets',      spec: 'scout', name: 'Retro Jets',      icon: '◂', channel: 'reverse',   max: 1, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'Unlock reverse thrust (S).' },
  { id: 'gravityCompass', spec: 'scout', name: 'Gravity Compass', icon: '✧', channel: 'compass',   max: 1, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'World-pull chevrons at your ship.' },
  { id: 'navPlotter',     spec: 'scout', name: 'Nav Plotter',     icon: '⋯', channel: 'plotter',   max: 3, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.1, desc: 'Your flight-path forecast.' },
  { id: 'impactWarning',  spec: 'scout', name: 'Impact Warning',  icon: '⚠', channel: 'collision', max: 1, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.0, desc: 'Mark where your path will hit (needs the plotter).' },
  { id: 'leadComputer',   spec: 'scout', name: 'Lead Computer',   icon: '⊕', channel: 'targeting', max: 3, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.0, desc: 'Aim lead-markers for your throws.' },
  { id: 'overtunedDrive', spec: 'scout', name: 'Overtuned Drive', icon: '⏩', channel: 'engine',    max: 6, minTier: 0, weight: 1.0, desc: 'Push the speed ceiling higher.' },
  { id: 'deepArray',      spec: 'scout', name: 'Deep Array',      icon: '◈', channel: 'deep',      max: 3, minTier: 3, weight: 0.9, desc: 'Long-range map and forecast.' },
  { id: 'phaseScreen',    spec: 'scout', name: 'Phase Screen',   icon: '⛨', channel: 'shield',      max: 3, minTier: 0, weight: 0.9, desc: 'A thin full-wrap shield that recharges fast.' },
  // Afterburner is shared to BRAWLER only, and LATE (tier 4 — above even the
  // capstone band): a burning brawler is an endgame reward, and HAULER never
  // gets it (the freighter fantasy is mass, not speed).
  { id: 'afterburner',    spec: 'scout', name: 'Afterburner',    icon: '»', channel: 'afterburner', max: 3, minTier: 0, also: { brawler: 4 }, weight: 1.0, desc: 'Hold SHIFT for a long, hard burn. The tank refills slowly.' },
  { id: 'evasionRoll',    spec: 'scout', name: 'Dash Jets',      icon: '↯', channel: 'evasion',     max: 3, minTier: 0, weight: 1.0, desc: 'Tap A / D to dart sideways (brief i-frames).' },
  { id: 'autoEvade',      spec: 'scout', name: 'Reflex Jink',    icon: '↺', channel: 'autoevade',   max: 3, minTier: 2, weight: 0.9, desc: 'Auto-dodges an incoming rock at the last instant. Recharges.' },
  { id: 'reconDrone',     spec: 'scout', name: 'Recon Drone',    icon: '✜', channel: 'recon',       max: 3, minTier: 3, weight: 0.9, desc: 'Auto-charts worlds from much farther out.' },
  { id: 'slipstream',     spec: 'scout', name: 'Slipstream',     icon: '➸', channel: 'slipstream',  max: 1, minTier: 3, weight: 0.9, desc: 'Tap F to warp forward toward the cursor.' },
];

export function abilityById(id) { return ABILITIES.find((a) => a.id === id); }
export function specById(id) { return SPECS.find((s) => s.id === id); }

export function newProgress() {
  return {
    xp: 0,
    level: 0,              // total pick-events taken
    tier: 0,               // 0..5 — driven by milestones, NOT capacity
    picksThisTier: 0,      // toward the next tier-up milestone
    spec: null,            // chosen at run start (applySpec seeds the starting kit)
    upgrades: {},          // { abilityId: rank } — empty until a spec is chosen
    lives: PROG.START_LIVES,
    // flavor counters (stats only, not read by shipStats)
    catches: 0,
    smashes: 0,
    surveyed: 0,
  };
}

// ---- XP + pick bookkeeping (pure helpers over game.prog) --------------------

export function xpForPick(prog) {
  return PROG.XP_BASE + PROG.XP_STEP * prog.level + PROG.XP_CURVE * prog.level * prog.level;
}
export function owesPick(prog) { return prog.xp >= xpForPick(prog); }
export function addXp(game, amount) {
  if (amount <= 0 || !game.ship || !game.ship.alive) return;
  game.prog.xp += amount;
}
// The next owed pick is a tier-up milestone once enough small picks are banked
// (until the top tier, after which it's small picks forever).
export function pickIsMilestone(prog) {
  return prog.tier < TIERS.caps.length - 1 && prog.picksThisTier >= PROG.PICKS_PER_TIER;
}
export function consumePickCost(prog) {
  prog.xp = Math.max(0, prog.xp - xpForPick(prog));
  prog.level++;
}
// Add one rank to an ability (capped at its max). New abilities come in at rank 1.
export function applyAbility(prog, id) {
  const a = abilityById(id);
  if (!a) return;
  const cur = prog.upgrades[id] || 0;
  if (cur < a.max) prog.upgrades[id] = cur + 1;
}
// Run start: lock in the spec and grant its starting kit at rank 1.
export function applySpec(prog, id) {
  const s = specById(id);
  if (!s) return;
  prog.spec = id;
  for (const aid of s.start) prog.upgrades[aid] = Math.max(1, prog.upgrades[aid] || 0);
}
// TIER-UP DIVIDEND + bump. Every ability already LEARNED ranks up once (capped) —
// the tier's power spike, on top of whichever NEW ability the milestone grants
// (main.js grants that AFTER this, so it comes in fresh at rank 1). (Object.keys
// is a snapshot; the loop only bumps existing keys, so mutating mid-iterate is safe.)
export function applyTierUp(prog) {
  for (const id of Object.keys(prog.upgrades)) {
    const a = abilityById(id);
    if (a && prog.upgrades[id] > 0 && prog.upgrades[id] < a.max) prog.upgrades[id]++;
  }
  prog.tier = Math.min(TIERS.caps.length - 1, prog.tier + 1);
  prog.picksThisTier = 0;
}

// One weighted, no-replacement draw from a bag of { u, w }: roulette-wheel on
// total weight, splice the winner out, return its upgrade. Runtime randomness
// (Math.random) is intentional per the determinism rules.
function drawWeighted(bag) {
  let total = 0; for (const e of bag) total += e.w;
  let r = Math.random() * total, idx = 0;
  for (; idx < bag.length - 1; idx++) { r -= bag[idx].w; if (r <= 0) break; }
  return bag.splice(idx, 1)[0].u;
}

// The tier floor for an ability under a given spec: the OWNER spec uses
// `minTier`; a spec listed in `also` uses its own (usually higher) floor;
// any other spec can never be offered it.
export function tierFloorFor(a, spec) {
  if (a.spec === spec) return a.minTier || 0;
  if (a.also && a.also[spec] != null) return a.also[spec];
  return Infinity;
}
// TIER-UP cards: `n` random NEW abilities from your offer pool (your spec's own
// rows + shared `also` rows) that you don't own yet and whose tier floor has
// been reached. Weighted, no-replacement.
export function tierChoices(prog, n = 2) {
  const bag = ABILITIES
    .filter((a) => !(prog.upgrades[a.id] > 0) && prog.tier >= tierFloorFor(a, prog.spec))
    .map((a) => ({ u: a, w: a.weight || 1 }));
  const chosen = [];
  while (chosen.length < n && bag.length) chosen.push(drawWeighted(bag));
  return chosen;
}
// SMALL-PICK cards: `n` random abilities you already OWN that can still rank up —
// between-tier picks only deepen what you've learned, never introduce new
// abilities. Ownership alone qualifies (no spec filter): a shared `also` ability
// a non-Scout picked up must stay deepenable or it dead-ends at rank 1.
export function rankChoices(prog, n = 2) {
  const bag = ABILITIES
    .filter((a) => (prog.upgrades[a.id] || 0) > 0 && (prog.upgrades[a.id] || 0) < a.max)
    .map((a) => ({ u: a, w: a.weight || 1 }));
  const chosen = [];
  while (chosen.length < n && bag.length) chosen.push(drawWeighted(bag));
  return chosen;
}

// Derived ship stats. The UNIVERSAL BASE (tier-scaled) is the old tier-0..5
// baseline — the core grab/throw/fly loop that EVERY spec has from frame one.
// Owned ABILITIES then add on top: each ability's rank is summed into its
// `channel`, and the stats below read those channel totals. The st field names
// are unchanged, so every consumer (render/physics/tractor/hud) is untouched.
export function shipStats(prog) {
  const tier = prog.tier;
  const u = prog.upgrades || {};
  // Sum owned ability ranks into their channels.
  const ch = {};
  for (const a of ABILITIES) { const rk = u[a.id] || 0; if (rk > 0) ch[a.channel] = (ch[a.channel] || 0) + rk; }
  const c = (k) => ch[k] || 0;

  const catchC = c('catch'), reachC = c('reach'), engineC = c('engine'), flingC = c('fling'),
    hullC = c('hull'), shieldC = c('shield'), magnetC = c('magnet'),
    orbitLvl = c('orbit'), volC = c('volley');
  // BRAWLER runtime channels (ram = Ram Prow + Juggernaut; the rest are 1:1).
  const ramC = c('ram'), berserkC = c('berserk'), clusterC = c('cluster'),
    shockC = c('shockwave'), demoC = c('demolition');
  // HAULER runtime channels.
  const tetherC = c('tether'), aegisC = c('aegis'), twinC = c('twin'), rockwallC = c('rockwall');
  // SCOUT runtime channels.
  const afterburnerC = c('afterburner'), evasionC = c('evasion'), reconC = c('recon'),
    slipC = c('slipstream'), autoevadeC = c('autoevade');
  // Sensor chain — each is its own ability/channel (Scout-owned, shared to the
  // other specs via `also`); reads spec-agnostically, so whoever owns it gets it.
  const compassC = c('compass'), plotterC = c('plotter'), collisionC = c('collision'),
    targetingC = c('targeting'), deepC = c('deep');
  const hasCompass = compassC > 0, hasPredict = plotterC > 0, hasTargeting = targetingC > 0,
    hasDeepSensors = deepC > 0, hasCrashWarn = collisionC > 0 && hasPredict;

  const capacity = TIERS.caps[tier] * (1 + 0.22 * catchC);
  const maxHull = 120 + 40 * tier + 55 * hullC + 30 * ramC;   // ram armor beefs the hull too
  // The regenerating shield is an UPGRADE, and its SHAPE is spec DNA (design
  // law): no shield ability -> shieldFrac 0 -> shieldMax 0 -> no shield, no SHLD
  // bar. BRAWLER (War Plating) carves a BIG slice of the pool but covers the
  // FRONT ARC ONLY — shieldArc is the half-angle around the nose; hits from
  // behind skip the shield entirely (physics.damageShip). SCOUT (Phase Screen)
  // is a THIN full wrap that recharges fast (regen/regenDelay below). HAULER
  // has no shield ability at all — the orbit rock wall is its protection.
  // It trades max hull for a recharging layer; only the shield regens.
  let shieldFrac = 0, shieldArc = Math.PI;
  if (shieldC > 0) {
    if (prog.spec === 'brawler') {
      shieldFrac = Math.min(0.65, 0.38 + 0.055 * (shieldC - 1));
      shieldArc = Math.PI / 2;   // the front half — the tail is bare
    } else {
      shieldFrac = Math.min(0.28, 0.16 + 0.05 * (shieldC - 1));
    }
  }
  const hullMax = Math.round(maxHull * (1 - shieldFrac));

  // Stow cap: one tier below the beam (or 45% of capacity), unlocked by an
  // orbit ability. The FORMATION is spec DNA like the shield: HAULER's stow
  // orbits and protects; BRAWLER's trails BEHIND the ship (trailStow — an
  // ammo train, not a shield) and is CAPPED AT MOON CLASS forever, however
  // high the beam tier climbs — the rack is shotgun ammo, not a planet garage.
  const trailStow = prog.spec === 'brawler';
  let orbitCap = orbitLvl > 0 ? Math.max(tier >= 1 ? TIERS.caps[tier - 1] : 0, capacity * 0.45) : 0;
  let orbitLabel = tier >= 1 ? TIERS.labels[tier - 1] : 'Small rocks';
  if (trailStow && orbitCap > TIERS.caps[1]) {
    orbitCap = TIERS.caps[1];
    orbitLabel = TIERS.labels[1];
  }

  // totalLevel feeds ENEMY scaling (ai.js) and SHIP MASS (physics.js). Keep it in
  // the old ~0..25 band so combat/physics balance is preserved: it's just the sum
  // of every owned ability rank (each channel total), weighted like before.
  const rankSum = Object.values(ch).reduce((s, v) => s + v, 0);
  const totalLevel = Math.min(25, tier * 2 + Math.round(rankSum * 0.6));

  return {
    capacity,
    tier,
    label: TIERS.labels[tier],
    shipName: SHIP_NAMES[tier],
    // Beam-reach base is sized against SHIP_ZOOM so the ring stays on-screen at
    // every tier; reach abilities + the orbit ring extend it.
    range: [160, 223, 308, 451, 538, 630][tier] + 40 * reachC + 30 * orbitLvl,
    grabSlack: 70 + 22 * reachC,
    force: capacity * 55 * (0.6 + 0.12 * tier),
    maxSpeed: 280 + 40 * tier + 80 * engineC,
    thrust: 180 + 30 * tier + 95 * engineC,
    fling: 430 + 55 * tier + 150 * flingC,
    maxHull: Math.round(maxHull),
    // Pool splits hull (mends only at glow pockets) / shield (recharges)
    hullMax,
    shieldMax: Math.round(maxHull) - hullMax,
    // Stow is LOCKED until an orbit ability (rank 0 -> no slots); see the
    // trailStow/moon-cap derivation above for the brawler differences.
    orbitCap,
    orbitLabel,
    trailStow,
    // 1/3/5/7 slots, CAPPED at 7 — orbit is a stacking channel (Orbital Sling +
    // Expanded Bay), so uncapped it could hit 15; higher ranks still grow orbitCap/range.
    maxOrbiters: orbitLvl > 0 ? Math.min(7, 2 * orbitLvl - 1) : 0,
    orbitLvl,
    // Kept for render (engine-flare size, chart-length) — indexed like the old levels
    levels: { beam: tier, orbit: orbitLvl, fling: flingC, hull: hullC, thrust: engineC, chart: deepC },
    // ---- ability gates (Scout sensor chain + shared unlocks) ----
    hasReverse: c('reverse') > 0,
    hasTargeting,
    targetLvl: targetingC,
    targetReach: 0.6 + 0.25 * targetingC,   // x LOCK_T, when targeting is on
    targetMarkers: 2 + 2 * targetingC,      // how many ✕ markers show
    hasPredict,
    predictLvl: plotterC,
    hasCrashWarn,
    hasCompass,
    compassLvl: compassC,
    hasVolley: volC > 0,
    volleyLvl: volC,
    // ---- BRAWLER runtime abilities (read by physics/tractor) ----
    ramMul: 1 + 0.45 * ramC,                      // ram damage DEALT to bodies (Ram Prow/Juggernaut)
    ramArmor: Math.max(0.45, 1 - 0.11 * ramC),    // impact damage TAKEN (lower = tougher)
    berserk: berserkC,                            // fling/ram scale up as hull drops (runtime hull read)
    cluster: clusterC,                            // shrapnel shards spawned on a throw-kill
    shockwave: shockC,                            // knockback impulse on a throw-kill
    demolition: demoC,                            // AoE damage on a throw-kill
    // Shield coverage half-angle around the nose (PI = full wrap). Brawler's
    // front-arc plating sets PI/2; physics.damageShip + render both read it.
    shieldArc,
    // ---- HAULER runtime abilities ----
    tether: tetherC,                              // Recovery Tether: thrown rocks home back to orbit
    aegis: aegisC,                                // Aegis Reflector: orbit rocks reflect intercepted fire
    twinGrip: twinC > 0,                          // Twin Grip: hold two rocks
    maxHeld: twinC > 0 ? 2 : 1,
    rockwall: rockwallC,                          // Rockwall: hardened, faster-spinning orbit rocks
    // ---- SCOUT runtime abilities ----
    afterburner: afterburnerC,                    // hold Shift: fuel-tank overdrive (main.js drains, physics burns)
    burnTime: 3.5 + 1.5 * afterburnerC,           // seconds a FULL tank burns for
    burnRefill: 1 / (55 - 10 * afterburnerC),     // tank/s while idle — a slow 45/35/25s refill
    evasion: evasionC,                            // tap A/D: sideways dash burst + i-frames (main.onDash)
    autoEvade: autoevadeC,                        // Reflex Jink: auto-dodge scan (physics.step)
    recon: reconC,                                // Recon Drone: auto-survey reach (world.js)
    slipstream: slipC > 0,                        // tap F: short warp (main.onWarp)
    // ---- scaled passives ----
    magnet: CFG.PICKUP_MAGNET * (1 + 0.4 * magnetC),
    sensorMul: 1 + 0.3 * deepC,             // Deep Array widens the map reveal
    // Scout's Phase Screen is thin but SNAPPY — it recharges sooner and faster
    // (that speed is the ability's identity; the other specs keep the base rate).
    regen: CFG.SHIP_REGEN * (prog.spec === 'scout' ? 1.6 : 1),
    regenDelay: CFG.SHIP_REGEN_DELAY * (prog.spec === 'scout' ? 0.6 : 1),
    // Forecast horizon: Nav Plotter ranks widen it, Deep Array widens it further.
    // (Ranks must feed a real effect — a flat has-plotter boost made rank 2-3 dead.)
    predictBoost: 1 + 0.18 * plotterC + 0.15 * deepC,
    // Size/zoom are tier-driven ONLY (see the SHIP_RADIUS/SHIP_ZOOM comments)
    radius: SHIP_RADIUS[tier],
    zoomOut: 1.15 / SHIP_ZOOM[tier],
    totalLevel,
  };
}
