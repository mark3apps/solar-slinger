// ACHIEVEMENTS — the run's scoreboard.
//
// A third progression readout that costs the other two nothing: achievements
// grant POINTS (game.prog.ach.score), never XP, never ranks, never picks. They
// are RUN-SCOPED on purpose — the score is "how was THIS run", so it lives on
// prog (main.js seeds it beside newProgress — config stays a leaf and must
// never import this module) and dies with the run like lives and upgrades do.
// Nothing here is persisted to localStorage: a lifetime tally would make an
// achievement a thing you grind once and never see again, and the panel is
// meant to read as a log of the flight you're actually in.
//
// SHAPE. Two halves, deliberately kept apart:
//   1. A STAT LEDGER (prog.ach.stats). Gameplay code bumps plain counters
//      through `bump` / `mark` / `best` — three tiny functions that are safe to
//      call from anywhere, including before a run exists. Call sites never know
//      what an achievement is; they just say what happened.
//   2. PREDICATES. Every catalog row carries `test(game, s, c)` — a pure read
//      over the game, the ledger, and a per-sweep context of derived values.
//      updateAchievements evaluates every UNEARNED row once per frame and
//      splices out the ones that fire, so the sweep shrinks as the run goes on.
// Adding an achievement is therefore one catalog row (+ a bump, if it needs an
// event nothing already records). Nothing else in the game needs to know.
//
// COST. The sweep is a few hundred property reads per frame with no allocation
// and no loops inside predicates — anything a predicate would have to scan for
// is computed ONCE into the shared context below. Time-accumulating stats
// (heat/oort/gas/skim/coast seconds) are integrated here off live game state
// rather than instrumented in physics: those flags already exist, and keeping
// the integration here means the hot path never grew a line for us.
import { ABILITIES, CFG } from './config.js';

// Point bands. Deliberately lopsided: the silly ones are cheap, and the
// insane ones are worth more than a whole category of easy ones, so a big
// score can only come from doing something genuinely hard.
// One bit per planet ARCHETYPE, for the "kill one of every kind" rows. A mask
// plus an incrementally-maintained count keeps those predicates a plain
// compare — no loop, no allocation, per the sweep's rules.
const PTYPE_BIT = {
  lava: 1, rocky: 2, gas: 4, ice: 8, terran: 16,
  ocean: 32, desert: 64, shroud: 128, crystal: 256,
};
// DERIVED, never typed out: `ptypesAll` ("destroy one of every archetype") is
// the only reader, and a hand-maintained 9 beside the table above is exactly
// how that row silently goes back to being winnable one world short the day a
// tenth archetype lands. Computed once at module init — the sweep never sees it.
export const PTYPE_COUNT = Object.keys(PTYPE_BIT).length;

export const PTS = { trivial: 5, easy: 10, normal: 20, tricky: 35, hard: 60, brutal: 100, insane: 200 };

// Category order = panel order. `label` heads its block, `blurb` sits under it.
export const CATEGORIES = [
  { id: 'first',   label: 'FIRST STEPS',  blurb: 'The opening minutes.' },
  { id: 'haul',    label: 'THE BEAM',     blurb: 'Grabbing, stowing, throwing.' },
  { id: 'combat',  label: 'DESTRUCTION',  blurb: 'Things that used to exist.' },
  { id: 'flight',  label: 'PILOTING',     blurb: 'Speed, gravity, and nerve.' },
  { id: 'peril',   label: 'SURVIVAL',     blurb: 'Places that want you dead.' },
  { id: 'explore', label: 'EXPLORATION',  blurb: 'The system and everything in it.' },
  { id: 'build',   label: 'PROGRESSION',  blurb: 'The ship you became.' },
  { id: 'silly',   label: 'ODDITIES',     blurb: 'Nobody asked for these.' },
  { id: 'insane',  label: 'INSANE',       blurb: 'Feats, not tasks.' },
  { id: 'secret',  label: 'CLASSIFIED',   blurb: 'Locked until you trip over them.' },
];

// Rows in the `secret` category are HIDDEN while unearned — the panel shows a
// redacted placeholder instead of the name and description, so the fun of
// finding one survives reading the list. Everything else is visible from the
// start: a locked achievement you can read is a to-do list, which is the point.
const A = (id, cat, pts, name, desc, test) => ({ id, cat, pts, name, desc, test });

// PREDICATE CONTRACT: `test(game, s, c)` is a PURE READ and must stay one —
// it runs every frame for every unearned row, so no loops, no allocation, and
// absolutely no mutation of the game. `s` is the ledger (every counter reads
// as undefined-or-number, so `>=` comparisons are safe without guards) and `c`
// is the shared context filled in by updateAchievements below.
export const ACHIEVEMENTS = [
  // ---- FIRST STEPS: one row per verb the opening minutes teach ----------
  A('firstSpec', 'first', PTS.trivial, 'Specialist', 'Choose a specialization and begin a run.',
    (g) => !!g.prog.spec),
  A('firstMinute', 'first', PTS.trivial, 'Wheels Up', 'Stay alive for one minute.',
    (g) => g.time >= 60),
  A('firstCatch', 'first', PTS.trivial, 'Finders Keepers', 'Catch your first rock in the tractor beam.',
    (g) => g.prog.catches >= 1),
  A('firstFling', 'first', PTS.trivial, 'Yeet', 'Fling a rock at something.',
    (g, s) => s.flings >= 1),
  A('firstDrop', 'first', PTS.trivial, 'Set It Down', 'Put a rock down gently instead of throwing it.',
    (g, s) => s.drops >= 1),
  A('firstSmash', 'first', PTS.easy, 'Demolition Debut', 'Destroy something with a thrown rock.',
    (g) => g.prog.smashes >= 1),
  A('firstOrbit', 'first', PTS.easy, 'Ring Bearer', 'Stow a rock into your orbit.',
    (g, s) => s.stows >= 1),
  A('firstSurvey', 'first', PTS.easy, 'You Are Here', 'Chart your first world.',
    (g) => g.prog.surveyed >= 1),
  A('firstGlow', 'first', PTS.trivial, 'Bedside Manner', 'Collect a glow mote and mend some hull.',
    (g, s) => s.motes >= 1),
  A('firstScrap', 'first', PTS.trivial, 'Bin Diver', 'Collect a debris chunk.',
    (g, s) => s.scrap >= 1),
  A('firstHit', 'first', PTS.trivial, 'First Dent', 'Take your first hit and keep flying.',
    (g, s) => s.hits >= 1),
  A('firstAbility', 'first', PTS.easy, 'Trained', 'Learn an ability from a card.',
    (g) => g.prog.level >= 1),
  A('firstRank', 'first', PTS.easy, 'Practice Makes', 'Earn an ability rank without spending anything.',
    (g, s, c) => c.ranks > c.owned),
  A('firstTier', 'first', PTS.normal, 'Promoted', 'Reach tier 1.',
    (g) => g.prog.tier >= 1),
  A('firstAlien', 'first', PTS.easy, 'Return Fire', 'Destroy an alien.',
    (g) => g.alienKills >= 1),
  A('firstSling', 'first', PTS.easy, 'Free Ride', 'Complete a slingshot without touching the throttle.',
    (g, s) => s.slings >= 1),
  A('firstBlock', 'first', PTS.normal, 'Hard Cover', 'Block an alien throw with an orbit rock.',
    (g, s) => s.blocks >= 1),

  // ---- THE BEAM ---------------------------------------------------------
  A('catch25', 'haul', PTS.easy, 'Rock Hound', 'Catch 25 rocks.',
    (g) => g.prog.catches >= 25),
  A('catch100', 'haul', PTS.normal, 'Rock Collector', 'Catch 100 rocks.',
    (g) => g.prog.catches >= 100),
  A('catch400', 'haul', PTS.hard, 'Compulsive Collector', 'Catch 400 rocks.',
    (g) => g.prog.catches >= 400),
  A('catch1000', 'haul', PTS.brutal, 'Insatiable', 'Catch 1,000 rocks.',
    (g) => g.prog.catches >= 1000),
  A('fling50', 'haul', PTS.easy, 'Warmed Up', 'Throw 50 rocks.',
    (g, s) => s.flings >= 50),
  A('fling250', 'haul', PTS.normal, 'Throwing Arm', 'Throw 250 rocks.',
    (g, s) => s.flings >= 250),
  A('fling800', 'haul', PTS.hard, 'Repetitive Strain', 'Throw 800 rocks.',
    (g, s) => s.flings >= 800),
  A('heavy6k', 'haul', PTS.normal, 'Heavy Lifting', 'Hold something over 6,000 mass.',
    (g, s) => s.heaviest >= 6000),
  A('heavy35k', 'haul', PTS.tricky, 'Minor Planetary', 'Hold something over 35,000 mass.',
    (g, s) => s.heaviest >= 35000),
  A('heavy120k', 'haul', PTS.hard, 'Planet Mover', 'Hold something over 120,000 mass.',
    (g, s) => s.heaviest >= 120000),
  A('heavy400k', 'haul', PTS.brutal, 'Freight Class', 'Hold something over 400,000 mass.',
    (g, s) => s.heaviest >= 400000),
  A('heavy1m', 'haul', PTS.insane, 'Everything But Stars', 'Hold something over 1,000,000 mass.',
    (g, s) => s.heaviest >= 1000000),
  A('stows50', 'haul', PTS.normal, 'Warehouse', 'Stow 50 rocks into your orbit.',
    (g, s) => s.stows >= 50),
  A('stows200', 'haul', PTS.tricky, 'Logistics', 'Stow 200 rocks.',
    (g, s) => s.stows >= 200),
  A('stows500', 'haul', PTS.hard, 'Distribution Centre', 'Stow 500 rocks.',
    (g, s) => s.stows >= 500),
  A('orbit3', 'haul', PTS.easy, 'Escort', 'Fly with three rocks in your formation.',
    (g, s, c) => c.orbitN >= 3),
  A('orbit5', 'haul', PTS.normal, 'Entourage', 'Fly with five rocks in your formation.',
    (g, s, c) => c.orbitN >= 5),
  A('orbitFull', 'haul', PTS.normal, 'Full House', 'Fill every orbit slot you own.',
    (g, s, c) => g.st.maxOrbiters > 1 && c.orbitN >= g.st.maxOrbiters),
  A('orbit7', 'haul', PTS.tricky, 'Seven Sisters', 'Carry seven rocks at once.',
    (g, s, c) => c.orbitN >= 7),
  A('orbitMass', 'haul', PTS.tricky, 'Personal Asteroid Belt', 'Carry 20,000 mass in formation at once.',
    (g, s) => s.orbitMassBest >= 20000),
  A('volley1', 'haul', PTS.easy, 'Buckshot', 'Fire a shotgun volley.',
    (g, s) => s.volleys >= 1),
  A('volley25', 'haul', PTS.normal, 'Trigger Happy', 'Fire 25 volleys.',
    (g, s) => s.volleys >= 25),
  A('volley100', 'haul', PTS.hard, 'Gunner', 'Fire 100 volleys.',
    (g, s) => s.volleys >= 100),
  A('volleyBest3', 'haul', PTS.normal, 'Triple Load', 'Fire a three-rock volley.',
    (g, s) => s.volleyBest >= 3),
  A('volleyBest5', 'haul', PTS.tricky, 'Both Barrels', 'Fire a five-rock volley.',
    (g, s) => s.volleyBest >= 5),
  A('volleyBest7', 'haul', PTS.hard, 'Full Broadside', 'Fire a seven-rock volley.',
    (g, s) => s.volleyBest >= 7),
  A('steal1', 'haul', PTS.normal, 'Highway Robbery', "Snatch a rock out of an alien's beam.",
    (g, s) => s.steal >= 1),
  A('steal10', 'haul', PTS.tricky, 'Career Criminal', 'Steal ten rocks from aliens.',
    (g, s) => s.steal >= 10),
  A('steal30', 'haul', PTS.hard, 'Organised Crime', 'Steal thirty rocks from aliens.',
    (g, s) => s.steal >= 30),
  A('retrieve', 'haul', PTS.easy, 'Second Thoughts', 'Pull a rock back out of your own orbit.',
    (g, s) => s.retrieves >= 1),
  A('retrieve50', 'haul', PTS.normal, 'Quartermaster', 'Pull 50 rocks back out of your orbit.',
    (g, s) => s.retrieves >= 50),
  A('twinFling', 'haul', PTS.normal, 'Two-Fisted', 'Throw while a second rock is still in hand.',
    (g, s) => s.twinFling >= 1),
  A('twinFling25', 'haul', PTS.tricky, 'Ambidextrous', 'Throw twenty-five times with a rock still in hand.',
    (g, s) => s.twinFling >= 25),
  A('tether', 'haul', PTS.normal, 'Boomerang', 'A thrown rock curves home on the tether.',
    (g, s) => s.tetherBack >= 1),
  A('tether50', 'haul', PTS.tricky, 'It Keeps Coming Back', 'Fifty rocks return on the tether.',
    (g, s) => s.tetherBack >= 50),
  A('whipcrack', 'haul', PTS.normal, 'Whip Crack', 'Boost while flinging to throw with your own momentum.',
    (g, s) => s.tetherThrows >= 1),
  A('whipcrack25', 'haul', PTS.tricky, 'Momentum Trader', 'Land 25 tether throws.',
    (g, s) => s.tetherThrows >= 25),
  A('deadStop', 'haul', PTS.normal, 'Dead Stop', 'Catch a rock an alien threw at you.',
    (g, s) => s.deadStops >= 1),
  A('deadStop20', 'haul', PTS.tricky, 'Safe Hands', 'Catch twenty alien throws out of the air.',
    (g, s) => s.deadStops >= 20),
  A('primedKill', 'haul', PTS.tricky, 'Return to Sender', 'Kill with a rock you caught mid-flight and threw back.',
    (g, s) => s.primedKill >= 1),
  A('primedKill10', 'haul', PTS.hard, 'Counterpuncher', 'Ten kills with caught-and-returned rocks.',
    (g, s) => s.primedKill >= 10),
  A('catchIce', 'haul', PTS.normal, 'Snowball Fight', 'Catch 10 pieces of ice.',
    (g, s) => s.cIce >= 10),
  A('catchIce60', 'haul', PTS.tricky, 'Ice Merchant', 'Catch 60 pieces of ice.',
    (g, s) => s.cIce >= 60),
  A('catchCore', 'haul', PTS.normal, 'Mineral Rights', 'Catch an exposed mineral core.',
    (g, s) => s.cCore >= 1),
  A('catchCore8', 'haul', PTS.tricky, 'Prospector', 'Catch eight mineral cores.',
    (g, s) => s.cCore >= 8),
  A('catchCache', 'haul', PTS.normal, 'Finders Fee', 'Crack open a salvage cache.',
    (g, s) => s.cCache >= 1),
  A('catchCache8', 'haul', PTS.tricky, 'Salvage Rights', 'Crack open eight salvage caches.',
    (g, s) => s.cCache >= 8),
  A('catchChunk', 'haul', PTS.easy, 'Piece of the Action', 'Catch a chunk knocked off a world.',
    (g, s) => s.cChunk >= 1),
  A('catchChunk50', 'haul', PTS.tricky, 'Reassembly Required', 'Catch fifty pieces of broken worlds.',
    (g, s) => s.cChunk >= 50),
  A('catchWreck', 'haul', PTS.tricky, 'Grave Robber', 'Haul a wreck out of the graveyard ring.',
    (g, s) => s.cWreck >= 1),
  A('catchWreck6', 'haul', PTS.hard, 'Undertaker', 'Haul six wrecks out of the graveyard ring.',
    (g, s) => s.cWreck >= 6),
  A('catchMoon', 'haul', PTS.tricky, 'Moonlighting', 'Hold an entire moon in your beam.',
    (g, s) => s.cMoon >= 1),
  A('catchMoon5', 'haul', PTS.hard, 'Lunar Logistics', 'Hold five different moons over a run.',
    (g, s) => s.cMoon >= 5),
  A('catchPlanet', 'haul', PTS.brutal, 'World in Your Hands', 'Hold an entire planet in your beam.',
    (g, s) => s.cPlanet >= 1),
  A('catchStation', 'haul', PTS.normal, 'Repossession', 'Grab a derelict station.',
    (g, s) => s.cStation >= 1),
  A('catchRogue', 'haul', PTS.hard, 'Stray Dog', 'Get a rogue planet into your beam.',
    (g, s) => s.cRogue >= 1),
  A('catchPod', 'haul', PTS.normal, 'Tow Truck', 'Take a mayday pod into your beam.',
    (g, s) => s.cPod >= 1),
  A('catchFast', 'haul', PTS.tricky, 'Fastball', 'Catch something closing on you at over 700.',
    (g, s) => s.catchFast >= 1),
  A('catchHot', 'haul', PTS.hard, 'Oven Mitts', 'Make a catch while inside the corona.',
    (g, s) => s.cHot >= 1),
  A('beam300', 'haul', PTS.normal, 'Hands On', 'Spend five minutes with something in the beam.',
    (g, s) => s.beamTotal >= 300),
  A('beam900', 'haul', PTS.tricky, 'Never Empty-Handed', 'Spend fifteen minutes with something in the beam.',
    (g, s) => s.beamTotal >= 900),

  // ---- DESTRUCTION ------------------------------------------------------
  A('kill10', 'combat', PTS.easy, 'Breaking Things', '10 throw-kills.',
    (g) => g.prog.smashes >= 10),
  A('kill50', 'combat', PTS.normal, 'Wrecking Ball', '50 throw-kills.',
    (g) => g.prog.smashes >= 50),
  A('kill200', 'combat', PTS.hard, 'Serial Demolition', '200 throw-kills.',
    (g) => g.prog.smashes >= 200),
  A('kill600', 'combat', PTS.brutal, 'Industrial Scale', '600 throw-kills.',
    (g) => g.prog.smashes >= 600),
  A('bigKill', 'combat', PTS.tricky, 'Heavyweight', 'Destroy a body over 50,000 mass.',
    (g, s) => s.kBig >= 1),
  A('bigKill10', 'combat', PTS.hard, 'Structural Engineer', 'Destroy ten bodies over 50,000 mass.',
    (g, s) => s.kBig >= 10),
  A('killMoon', 'combat', PTS.hard, 'Moon Killer', 'Destroy a moon.',
    (g, s) => s.kMoon >= 1),
  A('killMoon5', 'combat', PTS.brutal, 'Lunar Extinction', 'Destroy five moons.',
    (g, s) => s.kMoon >= 5),
  A('killMoon15', 'combat', PTS.insane, 'Nothing Left to Orbit', 'Destroy fifteen moons.',
    (g, s) => s.kMoon >= 15),
  A('killIceWorld', 'combat', PTS.hard, 'Cold Case', 'Destroy an ice world.',
    (g, s) => s.kIce >= 1),
  A('killLavaWorld', 'combat', PTS.hard, 'Quenched', 'Destroy a lava world.',
    (g, s) => s.kLava >= 1),
  A('killStation', 'combat', PTS.normal, 'Condemned', 'Destroy a derelict station.',
    (g, s) => s.kStation >= 1),
  A('killStation4', 'combat', PTS.hard, 'Slum Clearance', 'Destroy four derelict stations.',
    (g, s) => s.kStation >= 4),
  A('killNest', 'combat', PTS.tricky, 'Fumigation', 'Destroy an alien nest.',
    (g, s) => s.kNest >= 1),
  A('killNest3', 'combat', PTS.brutal, 'Exterminator', 'Destroy three alien nests.',
    (g, s) => s.kNest >= 3),
  // (The two rogue-planet rows retired with rogue planets themselves — an
  // achievement nothing in the world can produce is worse than one row short.
  // The kRogue ledger key and noteKill's rogue branch stay: type 'rogue' is
  // still supported, nothing just spawns it.)
  A('giantCrack', 'combat', PTS.normal, 'Calving', 'Shatter a field giant into pieces.',
    (g, s) => s.kGiant >= 1),
  A('giantCrack10', 'combat', PTS.hard, 'Rock Breaker', 'Shatter ten field giants.',
    (g, s) => s.kGiant >= 10),
  A('killComet', 'combat', PTS.normal, 'Ice Breaker', 'Destroy a comet.',
    (g, s) => s.kComet >= 1),
  A('killComet8', 'combat', PTS.tricky, 'Shower Cancelled', 'Destroy eight comets.',
    (g, s) => s.kComet >= 8),
  A('alien10', 'combat', PTS.normal, 'Pest Control', 'Kill 10 aliens.',
    (g) => g.alienKills >= 10),
  A('alien50', 'combat', PTS.hard, 'Ace', 'Kill 50 aliens.',
    (g) => g.alienKills >= 50),
  A('alien150', 'combat', PTS.brutal, 'Flying Ace', 'Kill 150 aliens.',
    (g) => g.alienKills >= 150),
  A('wright', 'combat', PTS.normal, 'Scrapyard Defence', 'Kill a wreckwright before it finishes building.',
    (g, s) => s.kWright >= 1),
  A('wright5', 'combat', PTS.tricky, 'No Salvage For You', 'Kill five wreckwrights.',
    (g, s) => s.kWright >= 5),
  A('golem', 'combat', PTS.tricky, 'Made of Me', 'Kill a scrap golem built from your own leavings.',
    (g, s) => s.kGolem >= 1),
  A('golem5', 'combat', PTS.hard, 'Unmade', 'Kill five scrap golems.',
    (g, s) => s.kGolem >= 5),
  A('lurker', 'combat', PTS.normal, 'Not A Rock', 'Kill a shoal lurker.',
    (g, s) => s.kLurker >= 1),
  A('lurker8', 'combat', PTS.hard, 'Shoal Survivor', 'Kill eight shoal lurkers.',
    (g, s) => s.kLurker >= 8),
  A('fieldClear', 'combat', PTS.tricky, 'Quiet Waters', "Destroy a dense field's whole lurker brood.",
    (g, s) => s.fieldClear >= 1),
  A('fort', 'combat', PTS.hard, 'Liberator', 'Smash every turret on a Bastion fort.',
    (g, s) => s.kFort >= 1),
  A('fort3', 'combat', PTS.insane, 'Siege Engine', 'Liberate three Bastion forts.',
    (g, s) => s.kFort >= 3),
  A('fortShield', 'combat', PTS.tricky, 'Shields Down', "Break through a Bastion fort's shield.",
    (g, s) => s.fortShields >= 1),
  A('combo2', 'combat', PTS.easy, 'Trick Shot', 'Chain a ×2 gravity-billiards combo.',
    (g) => (g.comboBest || 0) >= 2),
  A('combo3', 'combat', PTS.normal, 'Three-Ball', 'Chain a ×3 combo.',
    (g) => (g.comboBest || 0) >= 3),
  A('combo4', 'combat', PTS.tricky, 'Cue Ball', 'Chain a ×4 combo.',
    (g) => (g.comboBest || 0) >= 4),
  A('combo5', 'combat', PTS.hard, 'Break Shot', 'Chain a ×5 combo.',
    (g) => (g.comboBest || 0) >= 5),
  A('combos25', 'combat', PTS.tricky, 'Angles', 'Land 25 separate combos.',
    (g, s) => s.combos >= 25),
  A('ram10', 'combat', PTS.normal, 'Battering Ram', 'Ram-kill 10 rocks.',
    (g, s) => s.kRam >= 10),
  A('ram50', 'combat', PTS.hard, 'Bulldozer', 'Ram-kill 50 rocks.',
    (g, s) => s.kRam >= 50),
  A('ram200', 'combat', PTS.brutal, 'Snowplough', 'Ram-kill 200 rocks.',
    (g, s) => s.kRam >= 200),
  A('splat1', 'combat', PTS.normal, 'Pancake', 'Wall-splat a throw against a world.',
    (g, s) => s.kSplat >= 1),
  A('splat25', 'combat', PTS.hard, 'Wallpaper', '25 wall splats.',
    (g, s) => s.kSplat >= 25),
  A('splat75', 'combat', PTS.brutal, 'Interior Decorator', '75 wall splats.',
    (g, s) => s.kSplat >= 75),
  A('parry1', 'combat', PTS.normal, 'Deflected', 'Freeze an incoming rock on your nose.',
    (g, s) => s.parries >= 1),
  A('parry25', 'combat', PTS.tricky, 'Good Hands', 'Freeze 25 incoming rocks.',
    (g, s) => s.parries >= 25),
  A('parry100', 'combat', PTS.hard, 'Nothing Gets Through', 'Freeze 100 incoming rocks.',
    (g, s) => s.parries >= 100),
  A('parry2', 'combat', PTS.normal, 'Double Catch', 'Hold two rocks in one deflection window.',
    (g, s) => s.parryBest >= 2),
  A('parry3', 'combat', PTS.tricky, 'Three-Rock Freeze', 'Hold three rocks in one deflection window.',
    (g, s) => s.parryBest >= 3),
  A('parry4', 'combat', PTS.hard, 'Four in Hand', 'Hold four rocks in one deflection window.',
    (g, s) => s.parryBest >= 4),
  A('parryKill', 'combat', PTS.tricky, 'Sent Back', 'A deflected rock kills what it was aimed at.',
    (g, s) => s.parryKill >= 1),
  A('parryKill20', 'combat', PTS.hard, 'Riposte', 'Twenty kills with deflected rocks.',
    (g, s) => s.parryKill >= 20),
  A('snipe1200', 'combat', PTS.normal, 'Downrange', 'Throw-kill something 1,200 units from where you let go.',
    (g, s) => s.snipe >= 1200),
  A('snipe2500', 'combat', PTS.tricky, 'Long Shot', 'Throw-kill something 2,500 units from where you let go.',
    (g, s) => s.snipe >= 2500),
  A('snipe4000', 'combat', PTS.hard, 'Marksman', 'Throw-kill something 4,000 units from where you let go.',
    (g, s) => s.snipe >= 4000),
  A('aegis', 'combat', PTS.normal, 'Reflected Glory', 'Hurl an intercepted shot straight back.',
    (g, s) => s.aegisBack >= 1),
  A('aegis30', 'combat', PTS.tricky, 'Mirror Finish', 'Reflect thirty incoming shots.',
    (g, s) => s.aegisBack >= 30),
  A('blocks25', 'combat', PTS.tricky, 'Rock Wall', 'Block 25 alien throws with your orbit.',
    (g, s) => s.blocks >= 25),
  A('blocks100', 'combat', PTS.hard, 'Impenetrable', 'Block 100 alien throws.',
    (g, s) => s.blocks >= 100),
  A('vaporize', 'combat', PTS.normal, 'Fed the Sun', 'Throw something into the star.',
    (g, s) => s.sunFed >= 1),
  A('vaporize15', 'combat', PTS.tricky, 'Offerings', 'Throw fifteen things into the star.',
    (g, s) => s.sunFed >= 15),
  A('emberCleanse', 'combat', PTS.tricky, 'Firebreak', 'Smother an Emberkin bloom with ice.',
    (g, s) => s.emberCleansed >= 1),
  A('emberCleanse3', 'combat', PTS.hard, 'Scorched Reefs', 'Cleanse three infested worlds.',
    (g, s) => s.emberCleansed >= 3),
  A('sulfurPop', 'combat', PTS.normal, 'Percussive Mining', 'Vent a sulfur moon with a hard smash.',
    (g, s) => s.sulfurs >= 1),
  A('sulfurPop8', 'combat', PTS.tricky, 'Seismologist', 'Vent a sulfur moon eight times.',
    (g, s) => s.sulfurs >= 8),
  // Killing a WORLD is already scored by ptype (kIce/kLava); these two name
  // the new archetypes whose deaths carry their own weight.
  A('killCrystal', 'combat', PTS.hard, 'Shatterpoint', 'Break a crystal world apart.',
    (g, s) => s.kCrystal >= 1),
  A('killTerran', 'combat', PTS.brutal, 'Ecocide', 'Destroy the living world. It was the only one.',
    (g, s) => s.kTerran >= 1),

  // ---- PILOTING ---------------------------------------------------------
  A('speed500', 'flight', PTS.trivial, 'Underway', 'Top 500 speed.',
    (g, s) => s.topSpeed >= 500),
  A('speed700', 'flight', PTS.easy, 'Getting Somewhere', 'Top 700 speed.',
    (g, s) => s.topSpeed >= 700),
  A('speed1200', 'flight', PTS.normal, 'Fast Mover', 'Top 1,200 speed.',
    (g, s) => s.topSpeed >= 1200),
  A('speed2000', 'flight', PTS.hard, 'Speed Demon', 'Top 2,000 speed.',
    (g, s) => s.topSpeed >= 2000),
  A('sling5', 'flight', PTS.normal, 'Gravity Assist', 'Complete 5 slingshots.',
    (g, s) => s.slings >= 5),
  A('sling25', 'flight', PTS.hard, 'Orbital Mechanic', 'Complete 25 slingshots.',
    (g, s) => s.slings >= 25),
  A('sling75', 'flight', PTS.brutal, 'Free Energy', 'Complete 75 slingshots.',
    (g, s) => s.slings >= 75),
  A('slingBig', 'flight', PTS.tricky, 'Whipcrack', 'Take 400 speed out of a single slingshot.',
    (g, s) => s.slingBest >= 400),
  A('slingHuge', 'flight', PTS.hard, 'Catapult', 'Take 800 speed out of a single slingshot.',
    (g, s) => s.slingBest >= 800),
  A('dist50k', 'flight', PTS.easy, 'Cross Country', 'Fly 50,000 units.',
    (g, s) => s.dist >= 50000),
  A('dist250k', 'flight', PTS.tricky, 'Long Haul', 'Fly 250,000 units.',
    (g, s) => s.dist >= 250000),
  A('dist1m', 'flight', PTS.hard, 'Odometer', 'Fly 1,000,000 units.',
    (g, s) => s.dist >= 1000000),
  A('dist3m', 'flight', PTS.brutal, 'Frequent Flyer', 'Fly 3,000,000 units.',
    (g, s) => s.dist >= 3000000),
  A('dash25', 'flight', PTS.normal, 'Twitchy', 'Dash 25 times.',
    (g, s) => s.dashes >= 25),
  A('dash150', 'flight', PTS.tricky, 'Jitterbug', 'Dash 150 times.',
    (g, s) => s.dashes >= 150),
  A('warp10', 'flight', PTS.normal, 'Blink', 'Slipstream 10 times.',
    (g, s) => s.warps >= 10),
  A('warp50', 'flight', PTS.tricky, 'Here to There', 'Slipstream 50 times.',
    (g, s) => s.warps >= 50),
  A('burn60', 'flight', PTS.tricky, 'Lead Foot', 'Spend 60 seconds on the afterburner.',
    (g, s) => s.burnT >= 60),
  A('burn240', 'flight', PTS.hard, 'Fuel Bill', 'Spend four minutes on the afterburner.',
    (g, s) => s.burnT >= 240),
  A('jink1', 'flight', PTS.normal, 'Reflexes', 'Let the Reflex Jink save you.',
    (g, s) => s.jinks >= 1),
  A('jink15', 'flight', PTS.tricky, 'Autopilot', 'Let the jink save you fifteen times.',
    (g, s) => s.jinks >= 15),
  A('skim30', 'flight', PTS.tricky, 'Surfing', 'Grind 30 seconds of surface skimming.',
    (g, s) => s.skimT >= 30),
  A('skim120', 'flight', PTS.hard, 'Sandpaper', 'Grind two minutes of surface skimming.',
    (g, s) => s.skimT >= 120),
  A('skimBanded', 'flight', PTS.normal, 'Skate Park', "Skim a banded moon's stripes.",
    (g) => !!g.tut.banded),
  A('skimDune', 'flight', PTS.normal, 'Dune Runner', "Skate a desert world's dune seas.",
    (g) => !!g.tut.dune),
  A('skimGas', 'flight', PTS.normal, 'Cloud Surfer', "Skim a gas giant's cloud tops.",
    (g) => !!g.tut.skim),
  A('coast120', 'flight', PTS.normal, 'Drifter', 'Coast for two minutes without touching the throttle.',
    (g, s) => s.coastT >= 120),
  A('coast420', 'flight', PTS.tricky, 'Ballistic', 'Coast for seven straight minutes.',
    (g, s) => s.coastT >= 420),
  A('far30k', 'flight', PTS.normal, 'Outbound', 'Reach 30,000 units from the sun.',
    (g, s) => s.farthest >= 30000),
  A('far40k', 'flight', PTS.tricky, 'The Far Rim', 'Reach 40,000 units from the sun.',
    (g, s) => s.farthest >= 40000),
  A('deep300', 'flight', PTS.tricky, 'Out Where It Is Quiet', 'Spend five minutes beyond 30,000 units.',
    (g, s) => s.deepT >= 300),
  A('inner300', 'flight', PTS.tricky, 'Inner System Local', 'Spend five minutes inside 3,000 units of the sun.',
    (g, s) => s.innerT >= 300),
  A('scrapeSurvive', 'flight', PTS.normal, 'Paint Damage', 'Scrape along a surface and pull away.',
    (g, s) => s.scrapes >= 1),
  A('gasSkim', 'flight', PTS.tricky, 'Aerobraking', 'Enter a gas giant and climb back out.',
    (g, s) => s.gasOut >= 1),
  A('gasSkim5', 'flight', PTS.hard, 'Frequent Diver', 'Dive into gas giants five times and survive each.',
    (g, s) => s.gasOut >= 5),

  // ---- SURVIVAL ---------------------------------------------------------
  A('survive5', 'peril', PTS.easy, 'Still Flying', 'Survive five minutes.',
    (g) => g.time >= 300),
  A('survive15', 'peril', PTS.tricky, 'Veteran', 'Survive fifteen minutes.',
    (g) => g.time >= 900),
  A('survive30', 'peril', PTS.hard, 'Lifer', 'Survive thirty minutes.',
    (g) => g.time >= 1800),
  A('survive45', 'peril', PTS.brutal, 'Tour of Duty', 'Survive forty-five minutes.',
    (g) => g.time >= 2700),
  A('clutch', 'peril', PTS.tricky, 'One Percenter', 'Drop under a tenth of your hull and climb back over half.',
    (g, s) => s.clutch >= 1),
  A('clutch5', 'peril', PTS.hard, 'Habitual Risk', 'Claw back from under a tenth of your hull five times.',
    (g, s) => s.clutch >= 5),
  A('lowHull120', 'peril', PTS.tricky, 'Running on Fumes', 'Fly two minutes under a quarter hull.',
    (g, s) => s.lowHullT >= 120),
  A('noDmg120', 'peril', PTS.normal, 'Clean Sheet', 'Fly two minutes without taking a scratch.',
    (g, s) => s.noDmgBest >= 120),
  A('noDmg300', 'peril', PTS.hard, 'Untouchable', 'Fly five minutes without taking a scratch.',
    (g, s) => s.noDmgBest >= 300),
  // THE SOLAR WAVE — the two ways to answer one. Sheltering is the taught
  // move; riding it out in the open is the wager. Both counters start at 0 and
  // are fed only by main.updateStorm, so neither can land on frame one.
  A('stormLee', 'peril', PTS.normal, 'In the Lee', "Shelter in a world's shadow while a solar wave passes.",
    (g, s) => s.stormShelterT >= 2),
  A('stormRide', 'peril', PTS.tricky, 'Storm Rider', 'Ride out eight seconds of a solar wave in the open.',
    (g, s) => s.stormRideBest >= 8),
  A('stormRide3', 'peril', PTS.hard, 'Stormchaser', 'Ride out three solar waves in the open.',
    (g, s) => s.stormRides >= 3),
  A('heat10', 'peril', PTS.normal, 'Warm', 'Spend 10 seconds inside the corona.',
    (g, s) => s.heatT >= 10),
  A('heat30', 'peril', PTS.tricky, 'Sunbather', 'Spend 30 seconds inside the corona.',
    (g, s) => s.heatT >= 30),
  A('heat90', 'peril', PTS.hard, 'Heat Shielded', 'Spend 90 seconds inside the corona.',
    (g, s) => s.heatT >= 90),
  A('gasDive', 'peril', PTS.tricky, 'Deep Diver', 'Dive under a gas giant’s cloud deck and climb back out.',
    (g, s) => s.gasOut >= 1),
  A('gasDeep', 'peril', PTS.hard, 'Pressure Test', 'Dive halfway to a gas giant’s core and climb out.',
    (g, s) => s.gasHalf >= 1),
  A('oort10', 'peril', PTS.tricky, 'Frost Bitten', 'Spend 10 seconds inside the Oort cloud.',
    (g, s) => s.oortT >= 10),
  A('oortEdge', 'peril', PTS.normal, 'Edge of the Map', 'Get the Oort cloud warning.',
    (g, s) => s.oortT > 0 || s.farthest >= 41000),
  A('flareHit', 'peril', PTS.normal, 'Solar Flare', 'Take a direct flare hit and keep flying.',
    (g, s) => s.flareHits >= 1),
  A('flareHit5', 'peril', PTS.tricky, 'Sunburn', 'Take five direct flare hits.',
    (g, s) => s.flareHits >= 5),
  A('flareHit15', 'peril', PTS.hard, 'Radiation Badge', 'Take fifteen direct flare hits.',
    (g, s) => s.flareHits >= 15),
  A('livesFull', 'peril', PTS.normal, 'Nine Lives', 'Fill your life buffer.',
    (g) => g.prog.lives >= 5),
  A('oneLife300', 'peril', PTS.hard, 'Last Chance', 'Fly five minutes on your final life.',
    (g, s) => s.oneLifeT >= 300),
  A('dustHide', 'peril', PTS.normal, 'Now You Don’t', 'Lose a pursuer in a dust shroud.',
    (g, s) => s.dustT >= 3),
  A('dustHide60', 'peril', PTS.tricky, 'Ghost Protocol', 'Spend a minute hidden inside a dust shroud.',
    (g, s) => s.dustT >= 60),
  A('shroudHide', 'peril', PTS.normal, 'Into the Weather', "Break a pursuer's lock in a shrouded world's cloud cover.",
    (g) => !!g.tut.shroudCloak),
  A('shieldBreak', 'peril', PTS.easy, 'Bare Hull', 'Have your shield broken through.',
    (g, s) => s.shieldBreaks >= 1),
  A('shieldBreak25', 'peril', PTS.tricky, 'Overwhelmed', 'Have your shield broken through 25 times.',
    (g, s) => s.shieldBreaks >= 25),
  A('tookHits50', 'peril', PTS.normal, 'Well Dented', 'Take 50 separate hits and live.',
    (g, s) => s.hits >= 50),
  A('tookHits250', 'peril', PTS.hard, 'Punch-Drunk', 'Take 250 separate hits.',
    (g, s) => s.hits >= 250),
  A('respawn3', 'peril', PTS.easy, 'Try Again', 'Respawn three times.',
    (g, s) => s.respawns >= 3),
  A('respawn8', 'peril', PTS.normal, 'Persistent', 'Respawn eight times.',
    (g, s) => s.respawns >= 8),
  A('clean3', 'peril', PTS.hard, 'Careful', 'Reach tier 3 without dying once.',
    (g, s) => g.prog.tier >= 3 && !s.deaths),
  A('swarm4', 'peril', PTS.normal, 'Outnumbered', 'Have four aliens on you at once.',
    (g, s) => s.aliensAtOnce >= 4),
  A('swarm8', 'peril', PTS.tricky, 'Badly Outnumbered', 'Have eight aliens on you at once.',
    (g, s) => s.aliensAtOnce >= 8),
  // (No rogue-planet rows. Rogue planets were removed entirely — see the note
  // in world.generateWorld — so nothing ever raised the sensor alert these two
  // counted, `s.rogues` had no writer, and both sat in the panel permanently
  // unearnable, holding the run's point ceiling out of reach. `type: 'rogue'`
  // stays supported everywhere; if the concept ever comes back, so can they.)

  // ---- EXPLORATION ------------------------------------------------------
  A('field1', 'explore', PTS.easy, 'Thick Sky', 'Fly into a dense asteroid field.',
    (g, s) => s.fieldsSeen >= 1),
  A('chart5', 'explore', PTS.easy, "Cartographer's Apprentice", 'Chart 5 bodies.',
    (g) => g.prog.surveyed >= 5),
  A('chart25', 'explore', PTS.tricky, 'Cartographer', 'Chart 25 bodies.',
    (g) => g.prog.surveyed >= 25),
  A('chart60', 'explore', PTS.hard, 'Surveyor General', 'Chart 60 bodies.',
    (g) => g.prog.surveyed >= 60),
  A('chart100', 'explore', PTS.brutal, 'Nothing Left Unnamed', 'Chart 100 bodies.',
    (g) => g.prog.surveyed >= 100),
  A('echo1', 'explore', PTS.normal, 'Recovered Log', 'Recover an echo log from a derelict.',
    (g, s) => s.echoes >= 1),
  A('echo5', 'explore', PTS.tricky, 'Oral History', 'Recover five echo logs.',
    (g, s) => s.echoes >= 5),
  A('echo12', 'explore', PTS.hard, 'Archivist', 'Recover twelve echo logs.',
    (g, s) => s.echoes >= 12),
  A('herald', 'explore', PTS.hard, 'The Herald Answers', 'Wake the Herald with a graveyard wreck.',
    (g, s) => s.herald >= 1),
  A('relay', 'explore', PTS.hard, 'Signal Locked', 'Feed the Relay Station a mineral core.',
    (g, s) => s.relay >= 1),
  A('trade1', 'explore', PTS.tricky, 'Good Business', 'Complete a trade with the Tinker Barge.',
    (g, s) => s.trades >= 1),
  A('trade5', 'explore', PTS.hard, 'Preferred Customer', 'Complete five trades.',
    (g, s) => s.trades >= 5),
  A('trade12', 'explore', PTS.brutal, 'Shareholder', 'Complete twelve trades.',
    (g, s) => s.trades >= 12),
  A('rescue1', 'explore', PTS.tricky, 'Search and Rescue', 'Dock a mayday pod before its air runs out.',
    (g, s) => s.rescues >= 1),
  A('rescue3', 'explore', PTS.brutal, 'Lifeguard', 'Save three stranded pilots.',
    (g, s) => s.rescues >= 3),
  A('rescue6', 'explore', PTS.insane, 'Coast Guard', 'Save six stranded pilots.',
    (g, s) => s.rescues >= 6),
  A('maydaySeen', 'explore', PTS.easy, 'Distress Call', 'Pick up a mayday.',
    (g, s) => s.maydays >= 1),
  A('vesper', 'explore', PTS.normal, 'Long Period', 'Sight Comet Vesper on its fall sunward.',
    (g) => !!g.tut.vesper),
  A('visitor', 'explore', PTS.tricky, 'Interstellar', 'Sight the interstellar visitor. It will not come back.',
    (g, s) => s.visitorSeen >= 1),
  A('visitorGone', 'explore', PTS.normal, 'Farewell', 'Watch the interstellar visitor leave the system.',
    (g, s) => s.visitorGone >= 1),
  A('ghost', 'explore', PTS.normal, 'Unknown Contact', 'Find whatever is still transmitting out there.',
    (g) => !!g.tut.ghost),
  A('graveyard', 'explore', PTS.normal, 'Graveyard Shift', 'Find the graveyard ring.',
    (g) => !!g.tut.graveyard),
  // These two count waves SEEN — stormWarn fires when the sun looses one,
  // whatever the player was doing about it. The rows for actually answering a
  // wave (shelter, or riding it out in the open) live under SURVIVAL, where
  // the verb belongs.
  A('storm', 'explore', PTS.normal, 'Weather Report', 'See a solar wave sweep the system.',
    (g) => !!g.tut.storm),
  A('storm4', 'explore', PTS.tricky, 'Storm Season', 'See four solar waves.',
    (g, s) => s.storms >= 4),
  A('aurora', 'explore', PTS.normal, 'Northern Lights', 'Watch a storm front light up a world.',
    (g) => !!g.tut.aurora),
  A('aurora6', 'explore', PTS.tricky, 'Light Show', 'Watch six auroras.',
    (g, s) => s.auroras >= 6),
  A('eclipse', 'explore', PTS.normal, 'Moonshadow', 'Catch a lunar eclipse crossing a world.',
    (g, s) => s.eclipses >= 1),
  A('eclipse5', 'explore', PTS.tricky, 'Shadow Play', 'Catch five eclipses.',
    (g, s) => s.eclipses >= 5),
  A('cometShower', 'explore', PTS.normal, 'Meteor Watch', 'Be there for a comet shower.',
    (g, s) => s.cometShowers >= 1),
  A('cometShower5', 'explore', PTS.tricky, 'Regular Viewer', 'Be there for five comet showers.',
    (g, s) => s.cometShowers >= 5),
  A('flareSeen', 'explore', PTS.easy, 'Duck', 'Get a solar flare warning.',
    (g, s) => s.flares >= 1),
  A('flareSeen10', 'explore', PTS.tricky, 'Active Sun', 'Get ten solar flare warnings.',
    (g, s) => s.flares >= 10),
  A('forge', 'explore', PTS.normal, 'Forge Moon', 'Find the volcanically live moon.',
    (g) => !!g.tut.volc),
  A('ironMoon', 'explore', PTS.normal, 'Magnetic Personality', 'Find the magnetic iron moon.',
    (g) => !!g.tut.iron),
  A('sulfurMoon', 'explore', PTS.normal, 'Popped', 'Vent a sulfur moon with a hard smash.',
    (g) => !!g.tut.sulfur),
  A('dustMoon', 'explore', PTS.normal, 'Smoke Screen', 'Find the dust moon and its shroud.',
    (g) => !!g.tut.dust),
  A('bandedMoon', 'explore', PTS.normal, 'Banded Together', 'Find the banded skimming moon.',
    (g) => !!g.tut.banded),
  A('geyser', 'explore', PTS.normal, 'Cryo-Geyser', 'Catch an ice world venting ammo.',
    (g, s) => s.geysers >= 1),
  A('geyser10', 'explore', PTS.tricky, 'Harvest', 'See ten cryo-geysers erupt.',
    (g, s) => s.geysers >= 10),
  // ---- planet archetypes: one row per new world's mechanic, plus a deeper
  // second rung where the mechanic repeats (see the world.js PTYPE comment)
  A('atmoBurn', 'explore', PTS.normal, 'Falling Star', "Watch a rock burn up in a living world's air.",
    (g) => !!g.tut.atmo),
  A('atmoBurn20', 'explore', PTS.tricky, 'Meteor Shower', 'Burn twenty rocks up in a terran atmosphere.',
    (g, s) => s.atmoBurns >= 20),
  A('spout', 'explore', PTS.normal, 'Waterspout', 'Catch an ocean world flinging brine ice.',
    (g, s) => s.spouts >= 1),
  A('spout10', 'explore', PTS.tricky, 'Tidewater', 'See ten waterspouts erupt.',
    (g, s) => s.spouts >= 10),
  A('crystalShard', 'explore', PTS.normal, 'Struck a Chord', 'Ring a shard loose from a crystal world.',
    (g, s) => s.shards >= 1),
  A('crystalShard8', 'explore', PTS.tricky, 'Lapidary', 'Chip eight shards off the crystal worlds.',
    (g, s) => s.shards >= 8),
  A('magma', 'explore', PTS.normal, 'Magma Ejection', 'Watch a lava world hurl molten rock.',
    (g, s) => s.magmas >= 1),
  A('magma10', 'explore', PTS.tricky, 'Foundry', 'Watch ten magma ejections.',
    (g, s) => s.magmas >= 10),
  A('ember', 'explore', PTS.normal, 'Emberkin', 'Find a world the Emberkin have colonised.',
    (g, s) => s.emberSeen >= 1),
  A('emberSpread', 'explore', PTS.tricky, 'The Bloom Spreads', 'Watch the Emberkin seed a new world.',
    (g, s) => s.emberSeeded >= 1),
  A('motes100', 'explore', PTS.tricky, 'Green Thumb', 'Collect 100 glow motes.',
    (g, s) => s.motes >= 100),
  A('motes500', 'explore', PTS.hard, 'Photosynthesis', 'Collect 500 glow motes.',
    (g, s) => s.motes >= 500),
  A('motes1500', 'explore', PTS.brutal, 'Symbiosis', 'Collect 1,500 glow motes.',
    (g, s) => s.motes >= 1500),
  A('pods3', 'explore', PTS.tricky, 'Extra Lives', 'Recover three life pods.',
    (g, s) => s.pods >= 3),
  A('pods8', 'explore', PTS.hard, 'Cat Burglar', 'Recover eight life pods.',
    (g, s) => s.pods >= 8),
  A('scrap250', 'explore', PTS.normal, 'Space Janitor', 'Collect 250 debris chunks.',
    (g, s) => s.scrap >= 250),
  A('scrap1200', 'explore', PTS.hard, 'Sanitation Department', 'Collect 1,200 debris chunks.',
    (g, s) => s.scrap >= 1200),
  A('ionScrap', 'explore', PTS.normal, 'Live Wire', 'Collect salvage a solar wave has charged.',
    (g, s) => s.ionScrap >= 1),
  A('ionScrap40', 'explore', PTS.tricky, 'Static Cling', 'Collect forty charged chunks.',
    (g, s) => s.ionScrap >= 40),
  A('tinkerMet', 'explore', PTS.normal, 'Only Friend Out Here', 'Find the Tinker Barge.',
    (g) => !!g.tut.tinker),

  // ---- PROGRESSION ------------------------------------------------------
  A('tier2', 'build', PTS.normal, 'Corvette Class', 'Reach tier 2.',
    (g) => g.prog.tier >= 2),
  A('tier3', 'build', PTS.tricky, 'Cruiser Class', 'Reach tier 3.',
    (g) => g.prog.tier >= 3),
  A('tier4', 'build', PTS.hard, 'Dreadnought', 'Reach tier 4.',
    (g) => g.prog.tier >= 4),
  A('tier5', 'build', PTS.brutal, 'Titan', 'Reach tier 5 — the top of the ladder.',
    (g) => g.prog.tier >= 5),
  // FIVE, not four: the BRAWLER and SCOUT starting kits are four abilities, so
  // a four-row would land on frame one for two specs out of three and on the
  // first pick for the other. Every count row here must sit above the biggest kit.
  A('abil5', 'build', PTS.easy, 'Loadout', 'Own five abilities at once.',
    (g, s, c) => c.owned >= 5),
  A('abil6', 'build', PTS.normal, 'Kitted Out', 'Own six abilities at once.',
    (g, s, c) => c.owned >= 6),
  A('abil8', 'build', PTS.normal, 'Deep Bench', 'Own eight abilities at once.',
    (g, s, c) => c.owned >= 8),
  A('abil10', 'build', PTS.tricky, 'Well Rounded', 'Own ten abilities at once.',
    (g, s, c) => c.owned >= 10),
  A('abil12', 'build', PTS.hard, 'Overqualified', 'Own twelve abilities at once.',
    (g, s, c) => c.owned >= 12),
  A('abil14', 'build', PTS.brutal, 'Everything on the Rack', 'Own fourteen abilities at once.',
    (g, s, c) => c.owned >= 14),
  // THESE FOUR MOVED WITH THE SIX-RANK PASS (10/25/45/65 -> 15/40/70/95).
  // Every ability is six ranks now, so the same run banks ~1.6x the ranks it
  // used to (measured over the full climb: ~44 before, ~69 after) — at the old
  // thresholds 'Master of the Craft' went from the hardest rank row in the game
  // to something every spec passes without trying, which is the freebie failure
  // mode wearing a different hat. Scaled by the measured ratio, so each row
  // still asks for what it used to ask for.
  A('ranks15', 'build', PTS.easy, 'Getting the Hang of It', 'Earn 15 ability ranks.',
    (g, s, c) => c.ranks >= 15),
  A('ranks40', 'build', PTS.normal, 'Practised', 'Earn 40 ability ranks.',
    (g, s, c) => c.ranks >= 40),
  A('ranks70', 'build', PTS.tricky, 'Seasoned', 'Earn 70 ability ranks.',
    (g, s, c) => c.ranks >= 70),
  A('ranks95', 'build', PTS.hard, 'Master of the Craft', 'Earn 95 ability ranks.',
    (g, s, c) => c.ranks >= 95),
  A('maxTrack', 'build', PTS.tricky, 'Maxed Out', 'Take a rankable ability all the way to its final rank.',
    (g, s, c) => c.maxed >= 1),
  A('maxTrack3', 'build', PTS.hard, 'Three Ceilings', 'Max out three separate abilities.',
    (g, s, c) => c.maxed >= 3),
  A('maxTrack5', 'build', PTS.brutal, 'Nothing Left to Learn', 'Max out five separate abilities.',
    (g, s, c) => c.maxed >= 5),
  A('shielded', 'build', PTS.normal, 'Screens Up', 'Unlock a regenerating shield.',
    (g) => g.st.shieldMax > 0),
  A('hull300', 'build', PTS.normal, 'Reinforced', 'Push your total health pool past 300.',
    (g) => g.st.maxHull >= 300),
  A('hull450', 'build', PTS.tricky, 'Armoured', 'Push your total health pool past 450.',
    (g) => g.st.maxHull >= 450),
  A('hull600', 'build', PTS.hard, 'Walking Fortress', 'Push your total health pool past 600.',
    (g) => g.st.maxHull >= 600),
  A('unlockVolley', 'build', PTS.normal, 'Scattergun', 'Unlock the shotgun volley.',
    (g) => g.st.hasVolley),
  // RANK 3, not rank 1 — the Deflector is in the BRAWLER starting kit, so an
  // unlock row for it would be free on frame one for that spec.
  A('unlockDeflect', 'build', PTS.normal, 'Deflector Mk III', 'Take the Deflector to its third rank.',
    (g) => g.st.deflect >= 3),
  A('unlockTether', 'build', PTS.normal, 'Recovery Tether', 'Unlock the returning-rock tether.',
    (g) => g.st.tether > 0),
  A('unlockTwin', 'build', PTS.tricky, 'Twin Grip', 'Unlock the second beam.',
    (g) => !!g.st.twinGrip),
  A('unlockBurner', 'build', PTS.normal, 'Afterburner Online', 'Unlock the afterburner.',
    (g) => g.st.afterburner > 0),
  A('unlockSlip', 'build', PTS.tricky, 'Slipstream Online', 'Unlock the short-range warp.',
    (g) => !!g.st.slipstream),
  A('unlockJink', 'build', PTS.tricky, 'Reflex Jink Online', 'Unlock the automatic dodge.',
    (g) => g.st.autoEvade > 0),
  A('unlockRecon', 'build', PTS.tricky, 'Recon Drone Online', 'Unlock long-range auto-charting.',
    (g) => g.st.recon > 0),
  A('unlockBerserk', 'build', PTS.tricky, 'Berserker Online', 'Unlock the low-hull damage bonus.',
    (g) => g.st.berserk > 0),
  A('unlockDemo', 'build', PTS.tricky, 'Demolition Online', 'Unlock detonating throw-kills.',
    (g) => g.st.demolition > 0),
  A('unlockAegis', 'build', PTS.tricky, 'Aegis Online', 'Unlock the reflecting orbit shield.',
    (g) => g.st.aegis > 0),
  A('unlockRockwall', 'build', PTS.normal, 'Rockwall Online', 'Unlock hardened orbit rocks.',
    (g) => g.st.rockwall > 0),
  A('unlockDeep', 'build', PTS.tricky, 'Deep Array Online', 'Unlock the long-range sensors.',
    (g) => g.st.sensorMul > 1.2),

  // ---- DOCKING. The whole ladder of the verb: set down, build one, keep
  // several, live out of them. `g.docks.length` is an O(1) read of a list
  // capped at CFG.DOCK_MAX, so the count rows need no counter behind them.
  A('dockFirst', 'build', PTS.easy, 'Groundside',
    'Build a dock on a world. Land rockets-down, hold still, and stay put while it goes up.',
    (g, s) => s.docksBuilt >= 1),
  A('homeFirst', 'build', PTS.easy, 'Somewhere To Come Back To',
    'Name a home port. It is where a death puts you back.',
    (g, s) => s.homesSet >= 1),
  A('docks3', 'build', PTS.normal, 'Port Authority',
    'Have three docks standing at once.',
    (g) => g.docks && g.docks.length >= 3),
  A('dockT300', 'build', PTS.tricky, 'Shore Leave',
    'Spend five minutes berthed at finished docks.',
    (g, s) => s.dockT >= 300),
  A('docksMax', 'build', PTS.hard, 'Infrastructure',
    `Have ${CFG.DOCK_MAX} docks standing at once — every berth the fleet can keep.`,
    (g) => g.docks && g.docks.length >= CFG.DOCK_MAX),
  A('dockMoon', 'explore', PTS.normal, 'Lunar Module',
    'Build a dock on a moon.',
    (g, s) => s.docksMoon >= 1),
  A('launch25', 'flight', PTS.normal, 'Cleared For Departure',
    'Launch from a dock twenty-five times.',
    (g, s) => s.launches >= 25),
  A('dockSave', 'peril', PTS.tricky, 'Limped In',
    'Berth under 15% hull and repair all the way to full without leaving.',
    (g, s) => s.dockSaves >= 1),
  A('dockStorm', 'peril', PTS.hard, 'Weathered It',
    'Sit out a solar wave berthed at a live dock, under its shield.',
    (g, s) => s.dockStormT >= 8),
  A('dockDark', 'insane', PTS.insane, 'Lighthouse at the End',
    "Build a dock on The Wanderer's Star.",
    (g) => !!(g.dock && g.dock.b.dark && g.dock.t >= CFG.DOCK_BUILD)),

  // ---- ODDITIES ---------------------------------------------------------
  A('drops25', 'silly', PTS.normal, 'Butterfingers', 'Gently put down 25 rocks instead of throwing them.',
    (g, s) => s.drops >= 25),
  A('drops100', 'silly', PTS.tricky, 'Litterbug', 'Put down 100 rocks and leave them there.',
    (g, s) => s.drops >= 100),
  A('pause25', 'silly', PTS.easy, 'Indecisive', 'Open the menu 25 times.',
    (g, s) => s.pauses >= 25),
  A('pause75', 'silly', PTS.normal, 'Analysis Paralysis', 'Open the menu 75 times.',
    (g, s) => s.pauses >= 75),
  A('readManual', 'silly', PTS.trivial, 'Read the Manual', 'Open the control schematic.',
    (g, s) => s.openCtrl >= 1),
  A('readCredits', 'silly', PTS.trivial, 'Stayed for the Credits', 'Open the credits panel.',
    (g, s) => s.openCred >= 1),
  A('achHunter', 'silly', PTS.trivial, 'Achievement Hunter', 'Open this panel. That was it. That was the achievement.',
    (g, s) => s.openAch >= 1),
  A('achAddict', 'silly', PTS.normal, 'Checking Again', 'Open this panel twenty times in one run.',
    (g, s) => s.openAch >= 20),
  A('homeHop5', 'silly', PTS.normal, 'Commitment Issues',
    'Move your home port five times in one run.',
    (g, s) => s.homesSet >= 5),
  A('dockRetire', 'silly', PTS.normal, 'Urban Sprawl',
    'Build so many docks that the oldest one gets abandoned.',
    (g, s) => s.docksRetired >= 1),
  // NOT 'homebody' — that id is the belt-hugging row further down. The track is
  // id-keyed all the way through (award's `st.got[a.id]` guard, the panel's
  // lookup), so a collision silently forfeits one row's points and XP while the
  // panel renders both as earned. devtest.js asserts uniqueness now.
  A('dockStreak300', 'silly', PTS.tricky, 'Shut-In',
    'Stay berthed for five unbroken minutes. There is a whole system out there.',
    (g, s) => s.dockStreakBest >= 300),
  A('homeLost', 'silly', PTS.normal, 'Foreclosure',
    'Lose your home port along with the world it was standing on.',
    (g, s) => s.homesLost >= 1),
  A('spin20', 'silly', PTS.normal, 'Dizzy', 'Spin the ship through twenty full turns.',
    (g, s) => s.spins >= 20),
  A('spin150', 'silly', PTS.tricky, 'Centrifuge', 'Spin the ship through 150 full turns.',
    (g, s) => s.spins >= 150),
  A('hold180', 'silly', PTS.normal, 'Attached', 'Keep one rock in the beam for three unbroken minutes.',
    (g, s) => s.holdBest >= 180),
  A('hold480', 'silly', PTS.tricky, 'Emotional Support Asteroid', 'Keep one rock in the beam for eight unbroken minutes.',
    (g, s) => s.holdBest >= 480),
  A('junk10', 'silly', PTS.normal, "One Man's Trash", 'Catch ten pieces of somebody else’s junk.',
    (g, s) => s.cJunk >= 10),
  A('junk50', 'silly', PTS.tricky, 'Antiques Dealer', 'Catch fifty pieces of junk.',
    (g, s) => s.cJunk >= 50),
  A('pacifist', 'silly', PTS.hard, 'Pacifist Run', 'Reach tier 2 without a single throw-kill.',
    (g) => g.prog.tier >= 2 && g.prog.smashes === 0),
  A('pacifist3', 'silly', PTS.brutal, 'Conscientious Objector', 'Reach tier 3 without a single throw-kill.',
    (g) => g.prog.tier >= 3 && g.prog.smashes === 0),
  A('tourist', 'silly', PTS.tricky, 'Tourist', 'Chart 15 bodies before your tenth kill.',
    (g) => g.prog.surveyed >= 15 && g.prog.smashes < 10),
  A('hoarder', 'silly', PTS.normal, 'Dragon', 'Sit on a full orbit for a straight minute.',
    (g, s) => s.fullOrbitT >= 60),
  A('hoarder5', 'silly', PTS.tricky, 'Sedentary Dragon', 'Sit on a full orbit for five straight minutes.',
    (g, s) => s.fullOrbitT >= 300),
  A('homebody', 'silly', PTS.tricky, 'Homebody', 'Spend ten minutes without leaving the belt you spawned in.',
    (g, s) => s.homeT >= 600),
  A('homebody20', 'silly', PTS.hard, 'Never Left Town', 'Spend twenty minutes near your spawn.',
    (g, s) => s.homeT >= 1200),
  A('debrisField', 'silly', PTS.normal, 'Mess You Made', 'Have 60 loose debris chunks in the world at once.',
    (g, s) => s.debrisAtOnce >= 60),
  A('debrisStorm', 'silly', PTS.tricky, 'Somebody Clean This Up', 'Have 150 loose debris chunks at once.',
    (g, s) => s.debrisAtOnce >= 150),
  A('windowShop', 'silly', PTS.easy, 'Window Shopping', 'Open the settings panel ten times.',
    (g, s) => s.openSettings >= 10),
  A('slowRide', 'silly', PTS.normal, 'Sunday Driver', 'Fly 20,000 units without ever topping 400 speed.',
    (g, s) => s.dist >= 20000 && s.topSpeed < 400),
  A('shieldFull300', 'silly', PTS.normal, 'Well Rested', 'Spend five minutes at a completely full shield.',
    (g, s) => s.shieldFullT >= 300),
  A('noPicks', 'silly', PTS.tricky, 'Set in My Ways', 'Fly ten minutes without taking a single upgrade card.',
    (g) => g.time >= 600 && g.prog.level === 0),

  // ---- INSANE -----------------------------------------------------------
  A('killPlanet', 'insane', PTS.insane, 'Planetkiller', 'Destroy an entire planet.',
    (g, s) => s.kPlanet >= 1),
  A('killPlanet3', 'insane', PTS.insane, 'Systemic Failure', 'Destroy three planets.',
    (g, s) => s.kPlanet >= 3),
  A('killGas', 'insane', PTS.insane, 'Giant Slayer', 'Destroy a gas giant.',
    (g, s) => s.kGas >= 1),
  A('moonShot', 'insane', PTS.insane, 'Moon Shot', 'Kill a planet with a moon-class impactor.',
    (g, s) => s.moonShot >= 1),

  // ---- WORLD-BREAKING. The crumble layer made killing a world a thing you
  // work at over minutes rather than a number hitting zero, and gas giants got
  // a death of their own; these are the rungs of that ladder. All of them
  // count from zero, so none can land on frame one (the freebie rule).
  A('killPlanet5', 'insane', PTS.insane, 'Cosmic Vandalism', 'Destroy five planets in one run.',
    (g, s) => s.kPlanet >= 5),
  A('killWorld10', 'insane', PTS.insane, 'And Everything In It',
    'Destroy ten worlds — planets, moons, any of it.', (g, s) => (s.kWorld || 0) >= 10),
  A('planetByPlanet', 'insane', PTS.insane, 'Immovable Meets Unstoppable',
    'Kill a planet by throwing another planet at it.', (g, s) => (s.planetByPlanet || 0) >= 1),
  A('planetByChunk', 'insane', PTS.brutal, 'Poetic Justice',
    'Kill a planet with a slab broken off a world.', (g, s) => (s.planetByChunk || 0) >= 1),
  A('ptypes4', 'combat', PTS.brutal, 'Varied Diet',
    'Destroy four different kinds of world.', (g, s) => (s.kPtypeCount || 0) >= 4),
  A('ptypesAll', 'insane', PTS.insane, 'Comparative Anatomy',
    // Off PTYPE_COUNT, not a literal 9: add a tenth archetype to PTYPE_BIT and
    // a hard-coded threshold would quietly stay winnable one world short.
    'Destroy one of every archetype in the system.', (g, s) => (s.kPtypeCount || 0) >= PTYPE_COUNT),

  // ---- GAS GIANTS. Feeding one is the cheap end; stripping one is the feat.
  A('gasFed', 'combat', PTS.easy, 'Feeding Time',
    'Let a gas giant swallow something you threw.', (g, s) => (s.gasFed || 0) >= 1),
  A('gasFed15', 'combat', PTS.tricky, 'Bottomless',
    'Feed fifteen rocks into gas giants.', (g, s) => (s.gasFed || 0) >= 15),
  A('gasFedMoon', 'combat', PTS.brutal, 'Hors D\'oeuvre',
    'Feed a whole moon to a gas giant.', (g, s) => (s.gasFedMoon || 0) >= 1),
  A('gasVent', 'combat', PTS.hard, 'Unstable',
    'Hurt a gas giant badly enough that it starts venting on its own.',
    (g, s) => (s.gasVented || 0) >= 1),
  A('killGas2', 'insane', PTS.insane, 'Twice Is a Pattern',
    'Strip two gas giants down to their cores.', (g, s) => s.kGas >= 2),
  A('killGasAll', 'insane', PTS.insane, 'Nothing Left to Weigh',
    'Strip every gas giant in the system.', (g, s) => s.kGas >= 3),
  A('killCore', 'insane', PTS.insane, 'Finish What You Started',
    'Strip a gas giant, then destroy the core it left behind.', (g, s) => (s.kCore || 0) >= 1),
  A('combo6', 'insane', PTS.brutal, 'Billiards Master', 'Chain a ×6 gravity-billiards combo.',
    (g) => (g.comboBest || 0) >= 6),
  A('combo8', 'insane', PTS.insane, 'Impossible Geometry', 'Chain a ×8 combo.',
    (g) => (g.comboBest || 0) >= 8),
  A('combo10', 'insane', PTS.insane, 'Newton Would Be Furious', 'Chain a ×10 combo.',
    (g) => (g.comboBest || 0) >= 10),
  A('parry5', 'insane', PTS.brutal, 'Five-Rock Freeze', 'Hold five rocks in one deflection window.',
    (g, s) => s.parryBest >= 5),
  A('parry6', 'insane', PTS.insane, 'Six-Shooter', 'Freeze a full six-rock volley in one window.',
    (g, s) => s.parryBest >= 6),
  A('snipe6000', 'insane', PTS.brutal, 'Sniper', 'Throw-kill something 6,000 units from where you let go.',
    (g, s) => s.snipe >= 6000),
  A('snipe10000', 'insane', PTS.insane, 'Across the System', 'Throw-kill something 10,000 units downrange.',
    (g, s) => s.snipe >= 10000),
  A('speed3000', 'insane', PTS.brutal, 'Ludicrous', 'Top 3,000 speed.',
    (g, s) => s.topSpeed >= 3000),
  A('speed4500', 'insane', PTS.insane, 'Unadvisable', 'Top 4,500 speed.',
    (g, s) => s.topSpeed >= 4500),
  A('icarus', 'insane', PTS.brutal, 'Icarus', 'Come within one and a half sun-radii of the photosphere — and leave.',
    (g, s) => s.sunMin <= 1.5 && s.sunLeft >= 1),
  A('icarus2', 'insane', PTS.insane, 'Touched the Sun', 'Reach the photosphere itself and climb back out.',
    (g, s) => s.sunMin <= 1.05 && s.sunLeft >= 1),
  A('crushDepth', 'insane', PTS.brutal, 'Crush Depth', 'Dive two-thirds of the way to a gas giant’s core and climb out.',
    (g, s) => s.gasDeep >= 1),
  A('crushDepth3', 'insane', PTS.insane, 'Cannonball', 'Survive three two-thirds gas-giant dives.',
    (g, s) => s.gasDeep >= 3),
  A('oort30', 'insane', PTS.brutal, 'Oort Walker', 'Spend thirty seconds inside the Oort cloud.',
    (g, s) => s.oortT >= 30),
  A('oort90', 'insane', PTS.insane, 'Out of Bounds', 'Spend ninety seconds inside the Oort cloud.',
    (g, s) => s.oortT >= 90),
  A('noDmg600', 'insane', PTS.brutal, 'Ghost in the Machine', 'Fly ten unbroken minutes without taking a scratch.',
    (g, s) => s.noDmgBest >= 600),
  A('noDmg1200', 'insane', PTS.insane, 'Never There', 'Fly twenty unbroken minutes without a scratch.',
    (g, s) => s.noDmgBest >= 1200),
  A('masterChart', 'insane', PTS.insane, 'Master Chart', 'Chart every single body in the system.',
    (g) => !!g.prog.masterChart),
  A('flawless', 'insane', PTS.insane, 'Flawless', 'Reach tier 5 without ever dying.',
    (g, s) => g.prog.tier >= 5 && !s.deaths),
  A('darkStar', 'insane', PTS.insane, "The Wanderer's Star", 'Find and chart the hidden dark star.',
    (g) => (g.prog.maxLivesBonus || 0) >= 1),
  A('nest5', 'insane', PTS.insane, 'Silent Sector', 'Destroy five alien nests.',
    (g, s) => s.kNest >= 5),
  A('survive60', 'insane', PTS.insane, 'The Long Watch', 'Survive a full hour.',
    (g) => g.time >= 3600),
  A('completionist', 'insane', PTS.insane, 'Completionist', 'Chart everything, wake the Herald, and power the Relay in one run.',
    (g, s) => !!g.prog.masterChart && s.herald >= 1 && s.relay >= 1),
  A('richRun', 'insane', PTS.insane, 'High Score', 'Bank 2,500 achievement points in a single run.',
    (g) => g.prog.ach.score >= 2500),

  // ---- CLASSIFIED (hidden until earned) ---------------------------------
  A('secretComet', 'secret', PTS.hard, 'Tail Grab', 'You caught Comet Vesper itself.',
    (g, s) => s.cComet >= 1),
  // Every skateable surface in the system, in one run — four one-shot flags,
  // no loop (the predicate contract)
  A('secretGrandTour', 'secret', PTS.brutal, 'Grand Tour', 'You skimmed every skateable surface in the system: bands, dunes, cloud tops and bare rock.',
    (g, s) => !!g.tut.banded && !!g.tut.dune && !!g.tut.skim && s.scrapes >= 1),
  A('secretVisitor', 'secret', PTS.insane, 'Once in a Lifetime', 'You caught the interstellar visitor before it left forever.',
    (g, s) => s.cVisitor >= 1),
  A('secretCarved', 'secret', PTS.tricky, 'Archaeology', 'You picked up the carved stone. Somebody made that.',
    (g, s) => s.cCarved >= 1),
  A('secretTinker', 'secret', PTS.hard, 'Bad Business', 'You destroyed the only friendly ship in the system.',
    (g, s) => s.kTinker >= 1),
  A('secretShepherd', 'secret', PTS.hard, 'Ring Scatterer', 'You killed the shepherd moon. The ring will never re-form.',
    (g, s) => s.kShepherd >= 1),
  A('secretRingDecay', 'secret', PTS.tricky, 'Consequences', 'You watched a ring begin to scatter without its shepherd.',
    (g, s) => s.ringDecay >= 1),
  A('secretGhost', 'secret', PTS.brutal, 'Exorcism', 'You destroyed the thing that was still transmitting.',
    (g, s) => s.kGhost >= 1),
  A('secretRelay', 'secret', PTS.hard, 'No Signal', 'You destroyed the Relay Station. Nobody is listening now.',
    (g, s) => s.kRelay >= 1),
  A('secretCarvedKill', 'secret', PTS.hard, 'Vandalism', 'You smashed the carved stone.',
    (g, s) => s.kCarved >= 1),
  A('secretPodLost', 'secret', PTS.easy, 'Too Late', 'A pod went quiet while you were somewhere else.',
    (g, s) => s.podsLost >= 1),
  A('secretPodLost3', 'secret', PTS.tricky, 'Not Your Job', 'Three pods went quiet.',
    (g, s) => s.podsLost >= 3),
  A('secretSunMoon', 'secret', PTS.insane, 'Sacrifice', 'You threw a moon into the sun.',
    (g, s) => s.sunFedBig >= 1),
  A('secretOwnGoal', 'secret', PTS.tricky, 'Own Goal', 'Your own thrown rock came back and killed you.',
    (g, s) => s.ownGoal >= 1),
  A('secretOwnGoal3', 'secret', PTS.hard, 'Slow Learner', 'Your own rocks killed you three times.',
    (g, s) => s.ownGoal >= 3),
  A('secretBroke', 'secret', PTS.tricky, 'Scorched Earth', 'Fifty kills and a three-chain combo in one run. The sky is emptier now.',
    (g) => g.prog.smashes >= 50 && (g.comboBest || 0) >= 3),
  A('secretPatient', 'secret', PTS.hard, 'The Long Game', 'You flew for an hour and a half.',
    (g) => g.time >= 5400),
  // NOT "tier 2 on the starting kit": a tier-up costs a pick, which increments
  // prog.level, so tier >= 1 with level 0 is unreachable by construction.
  A('secretScenic', 'secret', PTS.hard, 'Scenic Route', 'You flew half a million units without ever topping 900 speed.',
    (g, s) => s.dist >= 500000 && s.topSpeed < 900),
  A('secretEmberSpread', 'secret', PTS.tricky, 'Let It Burn', 'You let the Emberkin seed three worlds.',
    (g, s) => s.emberSeeded >= 3),
  A('secretStarve', 'secret', PTS.tricky, 'Empty Handed', 'You flew fifteen minutes without catching anything.',
    (g) => g.time >= 900 && g.prog.catches === 0),
  A('secretDeaths10', 'secret', PTS.normal, 'Determined', 'You died ten times and kept going.',
    (g, s) => s.deaths >= 10),
  A('secretHitParade', 'secret', PTS.hard, 'Crash Test', 'You took 500 separate hits.',
    (g, s) => s.hits >= 500),
  A('secretGasKill', 'secret', PTS.brutal, 'Lost in the Clouds', 'A gas giant finally got you.',
    (g, s) => s.dieGas >= 1),
  A('secretHeatKill', 'secret', PTS.brutal, 'Too Close', 'The sun finally got you.',
    (g, s) => s.dieHeat >= 1),
  A('secretOortKill', 'secret', PTS.brutal, 'Beyond the Edge', 'The Oort cloud finally got you.',
    (g, s) => s.dieOort >= 1),
];

export const ACH_TOTAL = ACHIEVEMENTS.length;
export const ACH_MAX_POINTS = ACHIEVEMENTS.reduce((n, a) => n + a.pts, 0);

// ---- run state --------------------------------------------------------------
// main.js hangs this on prog beside newProgress(), so it is created and
// destroyed with the run exactly like lives and upgrades are.
export function newAchState() {
  return {
    got: {},        // id -> game.time it landed
    order: [],      // ids in the order they were earned (the panel's RECENT list)
    score: 0,       // the run's points total — the number on the HUD chip
    stats: {        // the ledger. Every key defaults to 0 EXCEPT sunMin, which
      sunMin: Infinity,   // is a MINIMUM and must start above every real value
    },
  };
}

// ---- instrumentation --------------------------------------------------------
// The three verbs gameplay code calls. All are null-safe on purpose: they get
// called from physics/world/tractor paths that also run on the title screen and
// in headless soaks, where prog.ach may not exist yet, and an achievement
// counter must never be able to throw inside the sim.
function ledger(game) {
  const a = game.prog && game.prog.ach;
  return a ? a.stats : null;
}
export function bump(game, key, n = 1) {
  const s = ledger(game);
  if (s) s[key] = (s[key] || 0) + n;
}
export function mark(game, key) {
  const s = ledger(game);
  if (s) s[key] = 1;
}
// Running maximum (heaviest catch, top speed, longest snipe…).
export function best(game, key, v) {
  const s = ledger(game);
  if (s && v > (s[key] || 0)) s[key] = v;
}
// Running minimum — only sunMin uses it, and only because "how close did you
// get" is the interesting direction there.
export function least(game, key, v) {
  const s = ledger(game);
  if (s && v < (s[key] ?? Infinity)) s[key] = v;
}

// A CATCH is the single richest event in the game — one grab can be a comet, a
// core, a wreck, a moon, and a theft from an alien all at once — so the body
// classification lives here rather than as a dozen bump calls in tractor.js.
export function noteCatch(game, b, stolen) {
  const s = ledger(game);
  if (!s || !b) return;
  if (b.mass > (s.heaviest || 0)) s.heaviest = b.mass;
  if (stolen) s.steal = (s.steal || 0) + 1;
  if (b.majorComet) s.cComet = (s.cComet || 0) + 1;
  else if (b.comet) s.cIce = (s.cIce || 0) + 1;
  if (b.visitor) s.cVisitor = (s.cVisitor || 0) + 1;
  if (b.core) s.cCore = (s.cCore || 0) + 1;
  if (b.cache) s.cCache = (s.cCache || 0) + 1;
  if (b.ice) s.cIce = (s.cIce || 0) + 1;
  if (b.wreck) s.cWreck = (s.cWreck || 0) + 1;
  if (b.chunk) s.cChunk = (s.cChunk || 0) + 1;
  if (b.junk) s.cJunk = (s.cJunk || 0) + 1;
  if (b.carved) s.cCarved = (s.cCarved || 0) + 1;
  if (b.pod) s.cPod = (s.cPod || 0) + 1;
  if (b.type === 'moon') s.cMoon = (s.cMoon || 0) + 1;
  else if (b.type === 'planet') s.cPlanet = (s.cPlanet || 0) + 1;
  else if (b.type === 'station') s.cStation = (s.cStation || 0) + 1;
  else if (b.type === 'rogue') s.cRogue = (s.cRogue || 0) + 1;
  // WHERE and HOW the catch was made, not just what it was. Closing speed is
  // read here because this is the last moment before the tractor spring starts
  // rewriting the body's velocity.
  const ship = game.ship;
  if (ship && Math.hypot(b.vx - ship.vx, b.vy - ship.vy) > 700) s.catchFast = (s.catchFast || 0) + 1;
  if ((game.heatT || 0) > 0.05) s.cHot = (s.cHot || 0) + 1;
}

// A DEATH, likewise: one call from shatter classifies the corpse. `credit` is
// physics' own collision credit, so "who killed it" needs no second source of
// truth. `impactor` is whatever landed the blow, when the caller knows it —
// that's the whole basis of the moon-shot achievement.
export function noteKill(game, b, credit, impactor) {
  const s = ledger(game);
  if (!s || !b) return;
  const player = credit === 'player-throw';
  if (b.tinker) s.kTinker = (s.kTinker || 0) + 1;
  if (b.shepherd) s.kShepherd = (s.kShepherd || 0) + 1;
  if (b.ghost) s.kGhost = (s.kGhost || 0) + 1;
  if (b.relay) s.kRelay = (s.kRelay || 0) + 1;
  if (b.carved) s.kCarved = (s.kCarved || 0) + 1;
  if (credit === 'ram') s.kRam = (s.kRam || 0) + 1;
  if (!player) return;
  if (b.mass > 5e4) s.kBig = (s.kBig || 0) + 1;
  if (b.majorComet || b.comet) s.kComet = (s.kComet || 0) + 1;
  // World FLAVOUR, counted on any world-class kill: an ice moon and an ice
  // planet are the same feat to a player, so this reads ptype and not type.
  if (b.ptype === 'ice') s.kIce = (s.kIce || 0) + 1;
  else if (b.ptype === 'lava') s.kLava = (s.kLava || 0) + 1;
  else if (b.ptype === 'terran') s.kTerran = (s.kTerran || 0) + 1;
  else if (b.ptype === 'crystal') s.kCrystal = (s.kCrystal || 0) + 1;
  if (b.type === 'moon') s.kMoon = (s.kMoon || 0) + 1;
  else if (b.type === 'planet') {
    if (b.ptype === 'gas') s.kGas = (s.kGas || 0) + 1;
    else s.kPlanet = (s.kPlanet || 0) + 1;
    // A world that used to be a gas giant, killed a second time (physics
    // stamps the flag when the strip completes).
    if (b.wasGiantCore) s.kCore = (s.kCore || 0) + 1;
    // WHAT killed it. A planet thrown into a planet is the top of the ladder;
    // a slab knocked off one world used to finish another is its own story.
    if (impactor && impactor.type === 'planet') s.planetByPlanet = (s.planetByPlanet || 0) + 1;
    if (impactor && impactor.chunk) s.planetByChunk = (s.planetByChunk || 0) + 1;
  }
  // WORLDS destroyed, any class — the running tally an "and everything in it"
  // row reads. Counted here so the predicate stays a plain compare.
  if (b.type === 'moon' || b.type === 'planet' || b.type === 'rogue') {
    s.kWorld = (s.kWorld || 0) + 1;
    // Distinct ARCHETYPES killed, kept as a bitmask plus a live popcount, so
    // the "one of every kind" rows never loop inside a predicate.
    const bit = PTYPE_BIT[b.ptype];
    if (bit && !(s.kPtypeMask & bit)) {
      s.kPtypeMask |= bit;
      s.kPtypeCount = (s.kPtypeCount || 0) + 1;
    }
  }
  if (b.type === 'planet') {
    // The feat inside the feat: a planet killed by something moon-class or
    // bigger. CHUNK_MIN_MASS (3500) is the same "this is a real world, not a
    // rock" line the shedding rules use.
    if (impactor && impactor.mass >= 3500) s.moonShot = (s.moonShot || 0) + 1;
  }
  if (b.type === 'station') s.kStation = (s.kStation || 0) + 1;
  else if (b.type === 'rogue') s.kRogue = (s.kRogue || 0) + 1;
  else if (b.type === 'nest') s.kNest = (s.kNest || 0) + 1;
  // Field giants: only PLAYER-credited breaks count, so a shoal grinding
  // itself apart in the background never scores.
  if (b.giant && b.fieldRock && (credit === 'player-throw' || credit === 'player' || credit === 'ram')) {
    s.kGiant = (s.kGiant || 0) + 1;
  }
  // Deflector and Dead Stop both mark their rocks, so a kill can name the verb
  // that set it up (both flags are cleared by the throw that consumes them).
  if (b.killedByParry) s.parryKill = (s.parryKill || 0) + 1;
  if (b.killedByPrimed) s.primedKill = (s.primedKill || 0) + 1;
  // SNIPE: how far the projectile flew from the release point. releaseHeld
  // stamps the origin; anything without one (orbit volleys, chained billiards)
  // simply doesn't score a distance.
  if (impactor && impactor.throwX !== undefined) {
    const d = Math.hypot(b.x - impactor.throwX, b.y - impactor.throwY);
    if (d > (s.snipe || 0)) s.snipe = d;
  }
}

// A DEATH ends every streak the sweep is integrating. Without this the timers
// keep their values across the respawn and pay out for a stretch that included
// dying — "ten minutes untouched" would survive being blown up, and a dive that
// ended at the core of a gas giant would score as a dive you climbed out of.
export function noteDeath(game, cause) {
  const s = ledger(game);
  if (!s) return;
  s.deaths = (s.deaths || 0) + 1;
  // How it got you. Matched off the death-cause STRING because that is the one
  // thing every damage path already carries — physics has no death-kind enum,
  // and inventing one would mean touching a dozen damageShip call sites. Keep
  // these substrings in step with the causes in physics.js if they ever change.
  const c = String(cause || '');
  if (/gas giant|depths of|cloud tops/i.test(c)) s.dieGas = (s.dieGas || 0) + 1;
  else if (/corona|Melted over/i.test(c)) s.dieHeat = (s.dieHeat || 0) + 1;
  else if (/Oort/i.test(c)) s.dieOort = (s.dieOort || 0) + 1;
  s.gasDepthCur = 0;
  // …and the berth streaks with it: "five unbroken minutes docked" must not
  // survive being blown up, and a repair run that ended in a death is no save.
  s.dockStreak = 0;
  s.dockHurt = 0;
  s.clutchArmed = 0;
  s.sunIn = 0;
  s.holdT = 0;
  s.coastT = 0;
  s.fullOrbitT = 0;
  s.lastAng = undefined;
}

// ---- the sweep --------------------------------------------------------------
// Derived values every predicate might want, computed ONCE per frame so no
// predicate ever loops. Reused object — nothing may hold on to it.
const CTX = { orbitN: 0, owned: 0, ranks: 0, maxed: 0 };

let pending = null;      // unearned rows; shrinks as they land
let pendingFor = null;   // the ach state `pending` was built for (identity, not equality)

// Award one achievement: bank the points, stamp it, and queue the toast.
// main.js drains game.achQueue — the same event-flag shape as rank-ups and the
// EVENT_MSGS table, so the sim never touches the DOM or the audio engine here.
function award(game, a) {
  const st = game.prog.ach;
  if (st.got[a.id]) return;
  st.got[a.id] = Math.round(game.time);
  st.order.push(a.id);
  st.score += a.pts;
  (game.achQueue || (game.achQueue = [])).push(a);
}

export function updateAchievements(game, dt) {
  const st = game.prog && game.prog.ach;
  // The title screen never scores: driftSplash runs the physics but not
  // update(), and a run that hasn't started can't earn anything anyway.
  if (!st || !game.started) return;
  const s = st.stats;
  const ship = game.ship;

  // ---- integrated stats -------------------------------------------------
  // These ride live game state instead of instrumented call sites: the flags
  // already exist and are already maintained every frame, so integrating them
  // here keeps the hot path exactly as it was.
  if (ship.alive) {
    const sp = Math.hypot(ship.vx, ship.vy);
    if (sp > (s.topSpeed || 0)) s.topSpeed = sp;
    s.dist = (s.dist || 0) + sp * dt;
    if (!game.controls.f && !game.controls.b) s.coastT = (s.coastT || 0) + dt;
    else s.coastT = 0;
    // Spin: total turning, in whole revolutions. The nose tracks the mouse, so
    // this is a genuine "you kept whirling the cursor around" counter.
    const ang = ship.angle;
    if (s.lastAng !== undefined) {
      let d = ang - s.lastAng;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      s.spinAcc = (s.spinAcc || 0) + Math.abs(d);
      if (s.spinAcc >= Math.PI * 2) { s.spins = (s.spins || 0) + 1; s.spinAcc -= Math.PI * 2; }
    }
    s.lastAng = ang;

    if ((game.heatT || 0) > 0.05) s.heatT = (s.heatT || 0) + dt;
    if ((game.skimT || 0) > 0) s.skimT = (s.skimT || 0) + dt;
    // GAS DIVE: track the deepest point of the CURRENT dive, and only pay out
    // when the ship surfaces still alive — a dive is only a feat if you came
    // back up (noteDeath clears the running depth, so dying at the core scores
    // nothing). Depth runs 0 at the cloud tops to 1 at the core.
    if ((game.gasDiveT || 0) > 0) {
      s.gasT = (s.gasT || 0) + dt;
      if ((game.gasDiveDepth || 0) > (s.gasDepthCur || 0)) s.gasDepthCur = game.gasDiveDepth;
    } else if (s.gasDepthCur) {
      s.gasOut = (s.gasOut || 0) + 1;
      if (s.gasDepthCur >= 0.5) s.gasHalf = (s.gasHalf || 0) + 1;
      if (s.gasDepthCur >= 0.67) s.gasDeep = (s.gasDeep || 0) + 1;
      s.gasDepthCur = 0;
    }
    if (game.dustCloak) s.dustT = (s.dustT || 0) + dt;
    // ---- DOCKING. All O(1) reads of state main.js and physics already
    // maintain, so the sweep's budget is untouched: no scan, no allocation.
    const dk = game.dock;
    if (dk && dk.t >= CFG.DOCK_BUILD) {
      s.dockT = (s.dockT || 0) + dt;
      s.dockStreak = (s.dockStreak || 0) + dt;
      if (s.dockStreak > (s.dockStreakBest || 0)) s.dockStreakBest = s.dockStreak;
      // Riding a solar wave out at a live dock. The wave is system-wide, so
      // being berthed anywhere during one counts — the feat is having built
      // somewhere to be when it arrived.
      if (game.storm) s.dockStormT = (s.dockStormT || 0) + dt;
      // A SAVE: limp in under 15% hull and repair to FULL without leaving.
      // Two-stage so it can only score for a repair that actually happened —
      // arriving already full earns nothing, and noteDeath clears the arm.
      if (ship.hull <= game.st.hullMax * 0.15) s.dockHurt = 1;
      else if (s.dockHurt && ship.hull >= game.st.hullMax) {
        s.dockSaves = (s.dockSaves || 0) + 1;
        s.dockHurt = 0;
      }
    } else {
      s.dockStreak = 0;
      // The arm does NOT clear here: a build finishing, or a bump that costs
      // the berth for a moment, must not throw away a repair in progress. Only
      // completing it or dying does.
    }

    // WHERE you fly, integrated. Oort is measured from the world edge itself,
    // not the warning band, so the achievement means "inside the grinder"
    // rather than "near it"; the sun sits at the origin, so one hypot covers
    // the outbound, deep-space and inner-system rows too.
    const rc = Math.hypot(ship.x, ship.y);
    if (rc > 42000) s.oortT = (s.oortT || 0) + dt;
    if (rc > (s.farthest || 0)) s.farthest = rc;
    if (rc > 30000) s.deepT = (s.deepT || 0) + dt;
    else if (rc < 3000) s.innerT = (s.innerT || 0) + dt;

    // SUN APPROACH, in photosphere radii — and the RETURN, which is the half
    // that makes it a feat: sunLeft only ticks once you're clear again.
    const sun = game.homeStar;
    if (sun && sun.radius > 0) {
      const sr = Math.hypot(ship.x - sun.x, ship.y - sun.y) / sun.radius;
      if (sr < (s.sunMin ?? Infinity)) s.sunMin = sr;
      if (sr < 1.6) s.sunIn = 1;
      else if (sr > 3 && s.sunIn) { s.sunIn = 0; s.sunLeft = (s.sunLeft || 0) + 1; }
    }

    // Longest unbroken stretch without damage. game.lastDamage is stamped by
    // damageShip, so this needs nothing new, and a death stamps it too — the
    // streak restarts at the respawn on its own. It is floored at ZERO rather
    // than read raw: lastDamage starts at -99, which would hand a fresh run 99
    // free seconds of "peace" before it had flown anywhere.
    const quiet = game.time - Math.max(0, game.lastDamage ?? 0);
    if (quiet > (s.noDmgBest || 0)) s.noDmgBest = quiet;

    // CLUTCH: hull under a tenth, then back over half — armed low, paid on the
    // recovery, so limping along at 9% forever earns nothing.
    const hf = ship.hull / game.st.hullMax;
    if (hf <= 0.1) s.clutchArmed = 1;
    else if (hf >= 0.5 && s.clutchArmed) { s.clutchArmed = 0; s.clutch = (s.clutch || 0) + 1; }
    if (hf < 0.25) s.lowHullT = (s.lowHullT || 0) + dt;
    if (game.st.shieldMax > 0 && ship.shield >= game.st.shieldMax - 0.5) {
      s.shieldFullT = (s.shieldFullT || 0) + dt;
    }
    if (game.prog.lives <= 1) s.oneLifeT = (s.oneLifeT || 0) + dt;

    // How busy the world got around you. Both arrays are compacted every frame
    // by their own subsystems, so length is the live count and costs nothing.
    if (game.aliens.length > (s.aliensAtOnce || 0)) s.aliensAtOnce = game.aliens.length;
    if (game.debris.length > (s.debrisAtOnce || 0)) s.debrisAtOnce = game.debris.length;

    // Time spent held together as one formation, and time spent near home.
    if (game.st.maxOrbiters > 0 && game.orbit.length >= game.st.maxOrbiters) {
      s.fullOrbitT = (s.fullOrbitT || 0) + dt;
    } else s.fullOrbitT = 0;
    // Heaviest formation ever flown. The only loop in the whole sweep, and it
    // is bounded at SEVEN by st.maxOrbiters — that's why it's affordable here
    // instead of being tracked incrementally through every stow and volley.
    if (game.orbit.length) {
      let om = 0;
      for (const b of game.orbit) om += b.mass;
      if (om > (s.orbitMassBest || 0)) s.orbitMassBest = om;
    }
    if (game.spawn && Math.hypot(ship.x - game.spawn.x, ship.y - game.spawn.y) < 9000) {
      s.homeT = (s.homeT || 0) + dt;
    }

    // How long one rock has ridden the beam without being let go — plus the
    // lifetime total, which does NOT reset when you finally throw it.
    if (game.held) {
      s.holdT = (s.holdT || 0) + dt;
      s.beamTotal = (s.beamTotal || 0) + dt;
      if (s.holdT > (s.holdBest || 0)) s.holdBest = s.holdT;
    } else s.holdT = 0;

    if (game.burnerOn) s.burnT = (s.burnT || 0) + dt;
  }

  // ---- context ----------------------------------------------------------
  const c = CTX;
  c.orbitN = game.orbit.length;
  c.owned = 0; c.ranks = 0; c.maxed = 0;
  for (const a of ABILITIES) {
    const rk = game.prog.upgrades[a.id] || 0;
    if (!rk) continue;
    c.owned++; c.ranks += rk;
    // Only RANKABLE tracks count as maxed. Every ability is six ranks now so
    // the guard is always true, but it STAYS: a max-1 row arrives already at
    // its ceiling, and counting one handed SCOUT "Maxed Out" free on frame one
    // (Retro Jets was in its kit). Re-introduce a max-1 ability and this is the
    // line that keeps the trap shut.
    if (a.max > 1 && rk >= a.max) c.maxed++;
  }

  // ---- evaluate ---------------------------------------------------------
  // Rebuilt whenever the run's ach state is a different object (a fresh run),
  // which is also the only time an earned achievement can un-earn itself.
  if (pendingFor !== st) {
    pending = ACHIEVEMENTS.filter((a) => !st.got[a.id]);
    pendingFor = st;
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    const a = pending[i];
    if (a.test(game, s, c)) {
      pending.splice(i, 1);
      award(game, a);
    }
  }
}

// ---- readouts ---------------------------------------------------------------
// Secret rows stay redacted in the panel until they land (hud.js reads this).
export const isSecret = (a) => a.cat === 'secret';

// ONE-SHOT EVENT MARKS. Several discovery achievements are already announced
// by the EVENT_MSGS table in main.js — the flag fires exactly once per event
// and main drains it — so rather than instrument every subsystem a second
// time, main's drain loop feeds those same flags through here. Add a row and
// the achievement can read the counter; nothing else changes.
// ONLY flags their subsystem raises UNCONDITIONALLY belong here. Several event
// flags are set behind a `if (!game.tut.x)` guard — those fire exactly once
// ever, so a counter off them can never pass 1 and a tiered achievement reading
// it would be unreachable. Use `g.tut.x` directly for those (the `first`-style
// rows below do); use this table when you want to COUNT the event.
export const ACH_EVENT_STATS = {
  // DOCKING rides the same one-shot flags main.js already drains, exactly as
  // the discovery rows do — physics and world never grew a second announcement.
  // (launchName is NOT here: it is a first-time-only row with no `repeat`, so
  // it fires once ever; physics.updateLaunch bumps `launches` directly.)
  dockBuildName: 'docksStarted',
  dockReadyName: 'docksBuilt',
  dockedName: 'berths',
  homeSetName: 'homesSet',
  homeLostName: 'homesLost',
  dockRetiredName: 'docksRetired',
  visitorWarn: 'visitorSeen',
  visitorGone: 'visitorGone',
  eclipseName: 'eclipses',
  auroraName: 'auroras',
  stormWarn: 'storms',
  cometWarn: 'cometShowers',
  flareWarn: 'flares',
  flareHitWarn: 'flareHits',
  tinkerPaidWarn: 'trades',
  maydayWarn: 'maydays',
  maydaySavedWarn: 'rescues',
  maydayLostWarn: 'podsLost',
  heraldWakeWarn: 'herald',
  relayWarn: 'relay',
  ringDecayName: 'ringDecay',
  fortLiberatedName: 'kFort',
  fortShieldDownName: 'fortShields',
  echoMsg: 'echoes',
  golemWarn: 'golemSeen',
  wrightWarn: 'wrightsSeen',
  fieldWarn: 'fieldsSeen',
  lurkerWarn: 'lurkersSeen',
  jinkWarn: 'jinks',
  comboShow: 'combos',
  tetherShow: 'tetherThrows',
  deadStopWarn: 'deadStops',
  sulfurWarn: 'sulfurs',
  geyserWarn: 'geysers',
  spoutWarn: 'spouts',      // ocean-world waterspouts (the archetype mechanics)
  shardWarn: 'shards',      // a crystal world rang a facet loose
  magmaWarn: 'magmas',
  emberWarn: 'emberSeen',
  emberSeededName: 'emberSeeded',
  emberCleansedName: 'emberCleansed',
  scrapeWarn: 'scrapes',
};
