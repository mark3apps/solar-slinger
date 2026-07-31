import { PROG, xpForPick, abilityById, ABILITIES, SPECS } from './config.js';

const el = {};
let msgTimer = null;
let prevHull = Infinity, prevShield = Infinity;
let dispHull = -1, dispShield = -1;   // eased readout values — numbers COUNT, not snap
let prevXpFrac = 0;        // XP-bar fill fraction last frame — pulse on gain
let prevCombo = 0;         // combo stamp retriggers its pop on every increment
let prevSpec = '';         // spec chip identity — restyle only when it changes
let livesSig = '';         // lives-pip signature — rebuild on change
let iconSig = '';          // acquired-upgrade chip signature — rebuild on change
let pickCb = null;         // click callback for the open upgrade card set
const lastText = new Map(); // last written string per node — DOM writes happen on change only

function setText(node, text) {
  if (lastText.get(node) !== text) { lastText.set(node, text); node.textContent = text; }
}
function setWidth(node, width) {
  if (lastText.get(node) !== width) { lastText.set(node, width); node.style.width = width; }
}

// Retrigger a one-shot CSS animation class
function flash(node, cls = 'hit') {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

// Guarded CSS-var write (used for the vitals' segment cell size)
function setVar(node, name, value) {
  const key = `${name}`;
  if (lastText.get(key) !== value) { lastText.set(key, value); node.style.setProperty(name, value); }
}

export function initHud(game) {
  for (const id of ['hud', 'fx', 'combo',
    'hullFill', 'shieldFill', 'hullNum', 'shieldNum', 'hullBar', 'shieldBar',
    'burnBar', 'burnFill', 'burnNum',
    'msg', 'speedBadge', 'deathScreen', 'deathCause', 'deathLives', 'gameoverScreen', 'gameoverCause',
    'pauseScreen', 'specLabel', 'tierLabel', 'livesText', 'xpBar', 'xpFill', 'upList2', 'bottomleft',
    'upgradeScreen', 'upTitle', 'upList', 'upHint',
    // Front-end shell: splash / pause / settings menus + the in-game menu button
    'topleft', 'splashScreen', 'settingsScreen', 'controlsScreen', 'creditsScreen',
    'menuBtn', 'setPredict', 'setMusicVol', 'setSfxVol', 'ctrlOut',
    'btnStart', 'btnSplashSettings', 'btnSplashControls', 'btnSplashCredits', 'btnSplashExit',
    'btnResume', 'btnPauseSettings', 'btnPauseControls', 'btnMainMenu', 'btnPauseExit',
    'btnSettingsBack', 'btnControlsBack', 'btnCreditsBack']) {
    el[id] = document.getElementById(id);
  }
  el.gametitle = document.querySelector('.gametitle');   // the boot scramble's target (no id)
  // Tick period on the XP bar = one upgrade pick (tracks PICKS_PER_TIER)
  el.xpBar.style.setProperty('--tick', `${100 / PROG.PICKS_PER_TIER}%`);
  void game;
}

export function message(text, dur = 3.5) {
  el.msg.textContent = text;
  el.msg.classList.remove('hidden');
  // retrigger the fade-in animation
  el.msg.style.animation = 'none';
  void el.msg.offsetHeight;
  el.msg.style.animation = '';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.msg.classList.add('hidden'), dur * 1000);
}

// Wire the front-end shell once. main.js owns the transitions (it holds the
// game state); hud only routes the clicks — mirroring the upgrade-modal split.
export function initMenus(handlers) {
  const bind = (id, fn) => { if (el[id]) el[id].addEventListener('click', fn); };
  bind('btnStart', handlers.onStart);
  bind('btnResume', handlers.onResume);
  bind('menuBtn', handlers.onPause);
  bind('btnMainMenu', handlers.onMainMenu);
  bind('btnSplashExit', handlers.onExit);
  bind('btnPauseExit', handlers.onExit);
  bind('btnSplashSettings', handlers.onOpenSettings);
  bind('btnPauseSettings', handlers.onOpenSettings);
  bind('btnSplashControls', handlers.onOpenControls);
  bind('btnPauseControls', handlers.onOpenControls);
  bind('btnSplashCredits', handlers.onOpenCredits);
  // All three shell panels back out the same way (main.closeShellPanel)
  bind('btnSettingsBack', handlers.onCloseShell);
  bind('btnControlsBack', handlers.onCloseShell);
  bind('btnCreditsBack', handlers.onCloseShell);
  bind('setPredict', handlers.onTogglePredict);
  initControlMap();
  // Volume sliders — the ONLY audio controls (zero = mute; no separate
  // toggles): live level on drag, and a preview tick on release so the SFX
  // level can be judged without leaving the menu.
  if (el.setMusicVol) el.setMusicVol.addEventListener('input', (e) => handlers.onMusicVol(+e.target.value / 100));
  if (el.setSfxVol) {
    el.setSfxVol.addEventListener('input', (e) => handlers.onSfxVol(+e.target.value / 100));
    el.setSfxVol.addEventListener('change', () => handlers.onSfxPreview && handlers.onSfxPreview());
  }
}

// ---- Title-screen boot sequence -------------------------------------------
// The wordmark resolves out of a glyph scramble: characters lock left to right
// while the unlocked ones flicker through junk. Substitution only — the string
// keeps its exact length (spaces included) the whole way, so the centered title
// never reflows mid-boot. The rest of the sequence is CSS (.boot on the splash).
const TITLE_A = 'SOLAR ', TITLE_B = 'SLINGER';   // the plain half and the gold <span> half
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#*<>/\\+=';
const SCRAMBLE_MS = 620;
let scrambleRaf = 0;

function scrambleTitle() {
  const node = el.gametitle;
  if (!node) return;
  const full = TITLE_A + TITLE_B;
  const t0 = performance.now();
  cancelAnimationFrame(scrambleRaf);
  const stepFrame = (now) => {
    const p = Math.min(1, (now - t0) / SCRAMBLE_MS);
    const locked = Math.floor(p * full.length);
    let out = '';
    for (let i = 0; i < full.length; i++) {
      out += (i < locked || full[i] === ' ')
        ? full[i]
        : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    // Rebuilt as markup because the gold half is a <span> — the two-tone
    // wordmark has to survive the scramble.
    node.innerHTML = `${out.slice(0, TITLE_A.length)}<span>${out.slice(TITLE_A.length)}</span>`;
    if (p < 1) scrambleRaf = requestAnimationFrame(stepFrame);
  };
  scrambleRaf = requestAnimationFrame(stepFrame);
}

// Replay the power-on. The class is stripped and re-added (with a reflow between)
// so the CSS animations retrigger on every return to the splash, not just load.
function playBoot() {
  if (!el.splashScreen) return;
  el.splashScreen.classList.remove('boot');
  void el.splashScreen.offsetWidth;
  el.splashScreen.classList.add('boot');
  scrambleTitle();
}

// ---- The control schematic's readout ---------------------------------------
// Every key cap / mouse zone in #controlsScreen carries its own data-fn (the
// function name) and data-note (what it actually does); pointing at one mirrors
// them into the readout strip, like querying a console. Delegated from the panel
// so the markup stays the single source of truth — adding a control is an HTML
// edit, nothing here needs to know it exists. Keyboard users get the same thing
// through focus, which is why the caps are <button>s and not decorative spans.
const CTRL_IDLE = ['SELECT A CONTROL', 'Point at any key or mouse button above to read what it does.'];
function initControlMap() {
  const panel = el.controlsScreen;
  if (!panel || !el.ctrlOut) return;
  const fn = el.ctrlOut.querySelector('.cofn');
  const note = el.ctrlOut.querySelector('.conote');
  const show = (e) => {
    const t = e.target.closest('[data-fn]');
    if (!t) return;
    setText(fn, t.dataset.fn);
    setText(note, t.dataset.note || '');
    panel.querySelectorAll('.lit').forEach((n) => n.classList.remove('lit'));
    t.classList.add('lit');
  };
  const clear = () => {
    setText(fn, CTRL_IDLE[0]);
    setText(note, CTRL_IDLE[1]);
    panel.querySelectorAll('.lit').forEach((n) => n.classList.remove('lit'));
  };
  panel.addEventListener('pointerover', show);
  panel.addEventListener('focusin', show);
  panel.addEventListener('pointerleave', clear);
  panel.addEventListener('focusout', clear);
}

// Reflect a slider without fighting an in-progress drag
function setSlider(node, v) {
  if (!node || document.activeElement === node) return;
  const val = String(Math.round(v * 100));
  if (node.value !== val) node.value = val;
}

// Reflect a switch's on/off state (only touches the DOM on a real change).
function setToggle(node, on) {
  if (!node || node.classList.contains('on') === !!on) return;
  node.classList.toggle('on', !!on);
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

// Derive which shell overlay is showing from the game flags, and keep the
// settings switches in step with live state. Called every frame from updateHud
// (guarded so the DOM is only touched when something actually flips).
let menuSig = '';
let prevSplash = false, prevModal = false;
function syncMenus(game) {
  // A shell modal (settings / controls / credits) fully REPLACES the panel it
  // was opened over (splash or pause), so both hide while one is up — otherwise
  // the panel beneath peeks out around its edges.
  const settings = !!game.settingsOpen;
  const controls = !!game.controlsOpen;
  const credits = !!game.creditsOpen;
  const modal = settings || controls || credits;
  const splash = !game.started && !modal;
  const pause = game.started && game.paused && !modal;
  const menuBtn = game.started && !game.paused && !modal &&
    !game.choosingUpgrade && !game.gameOver && game.ship.alive;
  const sig = `${+splash}${+pause}${+settings}${+controls}${+credits}${+menuBtn}${+game.started}`;
  if (sig !== menuSig) {
    menuSig = sig;
    el.splashScreen.classList.toggle('hidden', !splash);
    el.pauseScreen.classList.toggle('hidden', !pause);
    el.settingsScreen.classList.toggle('hidden', !settings);
    el.controlsScreen.classList.toggle('hidden', !controls);
    el.creditsScreen.classList.toggle('hidden', !credits);
    el.menuBtn.classList.toggle('hidden', !menuBtn);
    // The gameplay HUD is meaningless on the title screen — hide it until START.
    el.topleft.classList.toggle('hidden', !game.started);
    el.bottomleft.classList.toggle('hidden', !game.started);
    el.xpBar.classList.toggle('hidden', !game.started);
    el.tierLabel.classList.toggle('hidden', !game.started);
    // Blur the frozen world into a soft backdrop behind the splash (incl. the
    // settings modal opened from it); cleared the instant the game begins.
    document.body.classList.toggle('preGame', !game.started);
    // Power-on animation whenever the title screen comes UP — on load and on
    // MAIN MENU out of a run, but NOT when a shell panel closes back onto it
    // (the console is already booted; re-running it there reads as a glitch).
    if (splash && !prevSplash && !prevModal) playBoot();
    prevSplash = splash; prevModal = modal;
  }
  setToggle(el.setPredict, game.predict);
  setSlider(el.setMusicVol, game.musicVol);
  setSlider(el.setSfxVol, game.sfxVol);
}

export function setDeathVisible(v, cause = '', lives = 0) {
  el.deathScreen.classList.toggle('hidden', !v);
  if (v) {
    el.deathCause.textContent = cause || 'Your ship broke apart.';
    el.deathLives.textContent = `${lives} ${lives === 1 ? 'life' : 'lives'} left — press R to respawn`;
  }
}

export function setGameOverVisible(v, cause = '') {
  el.gameoverScreen.classList.toggle('hidden', !v);
  if (v) el.gameoverCause.textContent = cause || 'Your ship broke apart.';
}

// Build (or hide) the choice modal. `kind` is 'spec' (run-opening specialization
// cards), 'tier' (a new ability at a tier-up), or 'upgrade' (deepen an owned one).
const UP_TITLES = { spec: 'CHOOSE YOUR SPECIALIZATION', tier: 'TIER UP — CHOOSE AN ABILITY', upgrade: 'CHOOSE AN UPGRADE' };
export function setUpgradeVisible(game, choices, kind, onPick) {
  if (!choices || !choices.length) {
    el.upgradeScreen.classList.add('hidden');
    el.upList.innerHTML = '';
    pickCb = null;
    return;
  }
  pickCb = onPick;
  const isSpec = kind === 'spec';
  el.upTitle.textContent = UP_TITLES[kind] || 'CHOOSE AN UPGRADE';
  el.upHint.textContent = `Press ${choices.map((_, i) => i + 1).join(' / ')} — or click a card`;
  // Spec cards lay out as three tall banners; ability cards stay stacked rows
  el.upList.classList.toggle('speccols', isSpec);
  el.upList.innerHTML = '';
  choices.forEach((c, i) => {
    const row = document.createElement('div');
    // ac-<spec> sets the card's identity color (spec cards by id, abilities by owner spec)
    const acc = isSpec ? c.id : c.spec;
    row.className = 'uprow' + (acc ? ` ac-${acc}` : '');
    let sub;
    if (isSpec) {
      const kit = (c.start || []).map((id) => abilityById(id)?.name).filter(Boolean).join(' · ');
      sub = `<div class="uplevel">Start: ${kit}</div>`;
    } else {
      const cur = game.prog.upgrades[c.id] || 0;
      sub = `<div class="uplevel">${cur > 0 ? `Rank ${cur} → ${cur + 1}` : 'New ability'} · max ${c.max}</div>`;
    }
    row.innerHTML =
      `<div class="upnum">${i + 1}</div>` +
      `<div class="upicon">${c.icon || '◦'}</div>` +
      `<div class="upinfo"><div class="upname">${c.name}</div>` +
      `<div class="updesc">${c.desc}</div>${sub}</div>`;
    row.addEventListener('click', () => { if (pickCb) pickCb(i); });
    el.upList.appendChild(row);
  });
  el.upgradeScreen.classList.remove('hidden');
}

// ---- Mood-reactive cockpit chrome -----------------------------------------
// The music director's live mood vector (calm / world / sun / danger — music.js
// publishes it as game.mood) tints the cockpit frame and its edge wash, so the
// shell breathes with the soundtrack instead of sitting at one violet forever.
// CHROME ONLY: the instruments keep their semantic colors (hull green, shield
// blue, lives pink) so they still read at a glance. The lowhull / heat alarm
// classes override --fr outright in CSS — an alarm always outranks a mood — and
// mood is all zeros until game.started, so the title screen stays plain violet.
const MOOD_CALM = [176, 112, 255];    // --chrome, the violet everything-chrome
const MOOD_SUN = [255, 176, 74];      // corona amber, sibling of the gold trim
const MOOD_DANGER = [255, 92, 122];   // the ember/pink end of the palette
const mixRgb = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function moodChrome(game) {
  const m = game.mood;
  if (!m) return;
  const cl = (v) => Math.max(0, Math.min(1, v || 0));
  const sun = cl(m.sun), danger = cl(m.danger), world = cl(m.world);
  // Danger is blended LAST so it wins a tie: burning up next to a nest should
  // read as a threat, not as a sunrise.
  let c = mixRgb(MOOD_CALM, MOOD_SUN, sun * 0.85);
  c = mixRgb(c, MOOD_DANGER, danger * 0.9);
  // Worlds only lift the glow — a hue shift there would collide with the cyan
  // the sensors already own.
  const intensity = Math.min(1, Math.max(sun, danger) * 0.9 + world * 0.22);
  setVar(el.hud, '--mood', `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
  setVar(el.hud, '--moodI', intensity.toFixed(2));
}

export function updateHud(game) {
  syncMenus(game);
  moodChrome(game);
  // Dev sim-speed badge (window.speed / ?dev hotkeys): hidden at 1x so normal
  // play never shows it; while fast-forwarding it also owns up to the achieved
  // rate whenever the machine can't keep up with the target.
  const scale = game.timeScale || 1;
  el.speedBadge.classList.toggle('hidden', scale === 1);
  if (scale !== 1) {
    const act = game.speedActual || scale;
    const lag = act < scale * 0.9;
    setText(el.speedBadge, lag ? `SIM ×${scale} — running ×${act.toFixed(1)}` : `SIM ×${scale}`);
    el.speedBadge.classList.toggle('lag', lag);
  }
  const s = game.ship;
  const st = game.st;
  const prog = game.prog;
  const shield = Math.max(0, s.shield || 0);
  const hasShield = st.shieldMax > 0;   // the shield is an upgrade — no bar until it's unlocked
  const hullFrac = Math.max(0, Math.min(1, s.hull / st.hullMax));
  const shieldFrac = hasShield ? Math.max(0, Math.min(1, shield / st.shieldMax)) : 0;
  setWidth(el.hullFill, `${hullFrac * 100}%`);
  setWidth(el.shieldFill, `${shieldFrac * 100}%`);
  // Both gauges share one points-per-pixel scale, so their LENGTHS tell the
  // story of the split pool: unlocking the shield visibly carves the hull bar.
  // --cell is that scale × 20: one segment divider every 20 points, so the
  // cells line up across both gauges and stay honest as the pool grows.
  const unit = 330 / (st.hullMax + st.shieldMax);
  setWidth(el.hullBar, `${Math.round(st.hullMax * unit)}px`);
  setWidth(el.shieldBar, `${Math.round(st.shieldMax * unit)}px`);
  setVar(el.topleft, '--cell', `${(unit * 20).toFixed(2)}px`);
  // The readouts chase their targets over a few frames (count-up/count-down);
  // setText still only touches the DOM when the rounded value changes.
  if (dispHull < 0) dispHull = s.hull;
  if (dispShield < 0) dispShield = shield;
  dispHull += (s.hull - dispHull) * 0.22;
  dispShield += (shield - dispShield) * 0.22;
  if (Math.abs(dispHull - s.hull) < 0.5) dispHull = s.hull;
  if (Math.abs(dispShield - shield) < 0.5) dispShield = shield;
  setText(el.hullNum, `${Math.max(0, Math.ceil(dispHull))}/${st.hullMax}`);
  setText(el.shieldNum, `${Math.max(0, Math.ceil(dispShield))}/${st.shieldMax}`);
  el.hullBar.classList.toggle('low', hullFrac < 0.35);
  // The SHLD bar exists only once the shield is unlocked — hide it entirely
  // otherwise, or a shieldMax of 0 would read as a permanently "down" shield.
  el.shieldBar.classList.toggle('hidden', !hasShield);
  // Charging shimmer while the recharge is actually running; alarm when down
  const charging = hasShield && s.alive && shield < st.shieldMax &&
    game.time - game.lastDamage > st.regenDelay;
  el.shieldBar.classList.toggle('charging', charging);
  el.shieldBar.classList.toggle('down', hasShield && shield <= 0.5);
  // White flash on the bar that just took the hit — and the whole viewport
  // answers the blow: a red hurt vignette for hull, a cyan ripple for shield.
  // The two classes share #fx::before, so clear both before retriggering
  // (hull wins when both drop in one frame — it's the graver signal).
  const hullHit = game.started && s.hull < prevHull - 0.4;
  const shieldHit = game.started && shield < prevShield - 0.4;
  if (hullHit) flash(el.hullBar);
  if (shieldHit) flash(el.shieldBar);
  if (hullHit || shieldHit) {
    el.fx.classList.remove('hurt', 'shieldHit');
    void el.fx.offsetWidth;
    el.fx.classList.add(hullHit ? 'hurt' : 'shieldHit');
  }
  prevHull = s.hull; prevShield = shield;

  // Sustained-state alarms live as classes on #hud so the cockpit frame,
  // vignette, and cluster can all react together (CSS keys off them).
  el.hud.classList.toggle('lowhull', game.started && s.alive && hullFrac < 0.35);
  el.hud.classList.toggle('heat', game.started && s.alive && (game.heatT || 0) > 0.45);

  // Afterburner fuel (scout): the BURN bar exists only once the ability is
  // owned — main.js owns the tank (game.burnerFuel / burnerOn).
  const hasBurner = st.afterburner > 0;
  el.burnBar.classList.toggle('hidden', !hasBurner);
  if (hasBurner) {
    const fuel = Math.max(0, Math.min(1, game.burnerFuel ?? 1));
    setWidth(el.burnFill, `${fuel * 100}%`);
    setText(el.burnNum, `${Math.round(fuel * 100)}%`);
    el.burnBar.classList.toggle('burning', !!game.burnerOn);
    // Below the engage threshold the tank can't light — dim it so the wait reads
    el.burnBar.classList.toggle('low', !game.burnerOn && fuel < 0.25);
  }

  // Combo stamp: throw-kill chains slam a multiplier onto the screen
  const comboLive = game.started && (game.combo || 0) >= 2 && game.comboT > 0;
  el.combo.classList.toggle('hidden', !comboLive);
  if (comboLive) {
    setText(el.combo, `×${game.combo}`);
    if (game.combo !== prevCombo) flash(el.combo, 'pop');
  }
  prevCombo = comboLive ? game.combo : 0;

  // Progression: chosen spec (identity chip), tier + ship class, lives (pips)
  if (prog.spec !== prevSpec) {
    prevSpec = prog.spec;
    const spec = SPECS.find((sp) => sp.id === prog.spec);
    el.specLabel.className = spec ? `ac-${spec.id}` : 'hidden';
    if (spec) setText(el.specLabel, `${spec.icon} ${spec.name}`);
  }
  setText(el.tierLabel, `TIER ${st.tier} · ${(st.shipName || '').toUpperCase()}`);
  const lives = Math.max(0, prog.lives);
  const lSig = `${lives}/${PROG.MAX_LIVES}`;
  if (lSig !== livesSig) {
    livesSig = lSig;
    el.livesText.innerHTML = Array.from({ length: PROG.MAX_LIVES }, (_, i) =>
      `<span class="lp${i < lives ? ' on' : ''}${lives === 1 && i === 0 ? ' last' : ''}"></span>`).join('');
  }

  // XP bar spans the WHOLE current tier and climbs right up to the tier-up. The
  // span is PICKS_PER_TIER small picks PLUS the milestone pick itself (+1): the
  // milestone costs its own pick's XP, so without that +1 the bar would hit full
  // after the last small pick and then PIN there — no feedback — while the
  // milestone's XP silently accrues (that read as "it stops upgrading"). With it,
  // a FULL bar is exactly the tier-up. At max tier there's no milestone, so it
  // just loops every PICKS_PER_TIER picks.
  const perTier = PROG.PICKS_PER_TIER;
  const pickFrac = Math.max(0, Math.min(1, prog.xp / xpForPick(prog)));
  const atMax = st.tier >= 5;
  const span = atMax ? perTier : perTier + 1;
  const done = atMax ? (prog.picksThisTier % perTier) : prog.picksThisTier;
  const barFrac = Math.min(1, (done + pickFrac) / span);
  setWidth(el.xpFill, `${barFrac * 100}%`);
  // XP coming in makes the bar spark — every scrap pickup / kill answers back
  if (barFrac > prevXpFrac + 0.0005) flash(el.xpBar, 'gain');
  prevXpFrac = barFrac;

  // Acquired abilities — a detailed list; rebuild only when the build changes
  const sig = ABILITIES.map((u) => prog.upgrades[u.id] || 0).join(',');
  if (sig !== iconSig) {
    iconSig = sig;
    const owned = ABILITIES.filter((u) => (prog.upgrades[u.id] || 0) > 0);
    const rows = owned.map((u) => {
      const rk = prog.upgrades[u.id];
      const rankEl = u.max > 1
        ? `<span class="ui-rk">${Array.from({ length: u.max }, (_, i) =>
            `<span class="rp${i < rk ? ' on' : ''}"></span>`).join('')}</span>`
        : `<span class="ui-on">ON</span>`;
      return `<div class="uprow2"><span class="ui-ic">${u.icon}</span>` +
        `<span class="ui-nm">${u.name}</span>${rankEl}</div>`;
    }).join('');
    el.upList2.innerHTML = owned.length
      ? `<div class="ulhead">ABILITIES</div>${rows}`
      : '';
  }
}
