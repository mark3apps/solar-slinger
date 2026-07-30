# Audio credits

All audio under `assets/audio/` is royalty-free. The music is **CC-BY** (attribution
required — keep this file, and keep the credit line shown on the in-game settings
screen). The sound effects are **CC0** (public domain, no attribution required, but
credited here anyway).

## Music (`assets/audio/music/`)

All by **Scott Buckley** (<https://www.scottbuckley.com.au>), License **CC-BY 4.0** —
one composer on purpose, so every mood stays in the same ethereal voice.
Transcoded from the artist's original 320 kbps MP3s to 160 kbps AAC (`afconvert`);
no other changes. The music director ([src/music.js](../../src/music.js)) plays ONE
track at a time, rotating within a mood playlist and crossfading between moods.

| File | Track | Playlist | Source page |
|---|---|---|---|
| `adrift-among-infinite-stars.m4a` | Adrift Among Infinite Stars | calm | `/library/adrift/` |
| `meanwhile.m4a` | Meanwhile | calm | `/library/meanwhile/` |
| `shadows-and-dust.m4a` | Shadows and Dust | calm | `/library/shadows-and-dust/` |
| `permafrost.m4a` | Permafrost | calm | `/library/permafrost/` |
| `hymn-to-the-dawn.m4a` | Hymn to the Dawn | world | `/library/hymn-to-the-dawn/` |
| `the-distant-sun.m4a` | Monomyth: The Distant Sun | world | `/library/the-distant-sun/` |
| `decoherence.m4a` | Decoherence | sun | `/library/decoherence/` |
| `incantation.m4a` | Incantation | sun | `/library/incantation/` |
| `machina.m4a` | Machina | danger | `/library/machina/` |
| `nightfall.m4a` | Nightfall | danger | `/library/nightfall/` |

Required attribution:

> Music by Scott Buckley — released under CC-BY 4.0. <https://www.scottbuckley.com.au>
> ('Adrift Among Infinite Stars', 'Meanwhile', 'Shadows and Dust', 'Permafrost',
> 'Hymn to the Dawn', 'Monomyth: The Distant Sun', 'Decoherence', 'Incantation',
> 'Machina', 'Nightfall')

## Sound effects (`assets/audio/sfx/`)

All **CC0 1.0** (public domain):

- **Kenney** (<https://kenney.nl>):
  - `explosionCrunch_*`, `lowFrequency_explosion_*`, `impactMetal_*`, `forceField_*`,
    `laserSmall_*`, `laserRetro_*`, `doorOpen_*`, `doorClose_*`, `spaceEngineLow_*`,
    `spaceEngine_*`, `engineCircular_*`, `thrusterFire_*` — from
    [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
  - `click_*`, `confirmation_*`, `error_*`, `glass_*`, `bong_*`, `drop_*` — from
    [Interface Sounds](https://kenney.nl/assets/interface-sounds)
- **rubberduck** — `alarm_01.ogg`, `alarm_03.ogg`, `saw.ogg`, `rolling.ogg` from
  [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops)
- **SketchMan3** — `wind-whoosh-loop.ogg` from
  [Wind Whoosh Loop](https://opengameart.org/content/wind-whoosh-loop)
- **pauliuw** — `jet-engine.mp3` from
  [Engine sounds(2)](https://opengameart.org/content/engine-sounds2)
- **artisticdude** — `swish-7/8/9.m4a` from
  [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack)
  (transcoded WAV → AAC)
- **Spiceman** — `sonar_ping.mp3` from
  [Sonar Ping](https://opengameart.org/content/sonar-ping)
- **AntumDeluge** — `fire-1.m4a` from
  [Fire Crackling](https://opengameart.org/content/fire-crackling)
  (transcoded WAV → AAC)

Every sound in the game is one of these recordings — the continuous loops
(engine, tractor beam, corona fire, hull grind, volley charge) run on the
loop-authored files above with game-state-driven gain/pitch. The tiny synth
helpers left in [src/sfx.js](../../src/sfx.js) are decode-window fallbacks only.
