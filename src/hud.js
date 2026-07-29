import { PROG, xpForPick, abilityById, ABILITIES } from './config.js';

const el = {};
let msgTimer = null;
let prevHull = Infinity, prevShield = Infinity;
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
function flash(bar) {
  bar.classList.remove('hit');
  void bar.offsetWidth;
  bar.classList.add('hit');
}

export function initHud(game) {
  for (const id of ['hullFill', 'shieldFill', 'hullNum', 'shieldNum', 'hullBar', 'shieldBar',
    'burnBar', 'burnFill', 'burnNum',
    'msg', 'speedBadge', 'deathScreen', 'deathCause', 'deathLives', 'gameoverScreen', 'gameoverCause',
    'pauseScreen', 'tierLabel', 'livesText', 'xpBar', 'xpFill', 'upList2',
    'upgradeScreen', 'upTitle', 'upList', 'upHint',
    // Front-end shell: splash / pause / settings menus + the in-game menu button
    'topleft', 'splashScreen', 'settingsScreen', 'menuBtn', 'setSound', 'setPredict',
    'btnStart', 'btnSplashSettings', 'btnSplashExit',
    'btnResume', 'btnPauseSettings', 'btnMainMenu', 'btnPauseExit', 'btnSettingsBack']) {
    el[id] = document.getElementById(id);
  }
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
  bind('btnSettingsBack', handlers.onCloseSettings);
  bind('setSound', handlers.onToggleSound);
  bind('setPredict', handlers.onTogglePredict);
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
function syncMenus(game) {
  // Settings is a modal that fully REPLACES the panel it was opened over
  // (splash or pause), so both hide while it's up — otherwise the panel beneath
  // peeks out around its edges.
  const settings = !!game.settingsOpen;
  const splash = !game.started && !settings;
  const pause = game.started && game.paused && !settings;
  const menuBtn = game.started && !game.paused && !settings &&
    !game.choosingUpgrade && !game.gameOver && game.ship.alive;
  const sig = `${+splash}${+pause}${+settings}${+menuBtn}${+game.started}`;
  if (sig !== menuSig) {
    menuSig = sig;
    el.splashScreen.classList.toggle('hidden', !splash);
    el.pauseScreen.classList.toggle('hidden', !pause);
    el.settingsScreen.classList.toggle('hidden', !settings);
    el.menuBtn.classList.toggle('hidden', !menuBtn);
    // The gameplay HUD is meaningless on the title screen — hide it until START.
    el.topleft.classList.toggle('hidden', !game.started);
    // Blur the frozen world into a soft backdrop behind the splash (incl. the
    // settings modal opened from it); cleared the instant the game begins.
    document.body.classList.toggle('preGame', !game.started);
  }
  setToggle(el.setSound, game.soundOn);
  setToggle(el.setPredict, game.predict);
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
  el.upList.innerHTML = '';
  choices.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'uprow' + (isSpec ? ' path' : '');
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

export function updateHud(game) {
  syncMenus(game);
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
  setText(el.hullNum, `${Math.max(0, Math.ceil(s.hull))}/${st.hullMax}`);
  setText(el.shieldNum, `${Math.ceil(shield)}/${st.shieldMax}`);
  el.hullBar.classList.toggle('low', hullFrac < 0.35);
  // The SHLD bar exists only once the shield is unlocked — hide it entirely
  // otherwise, or a shieldMax of 0 would read as a permanently "down" shield.
  el.shieldBar.classList.toggle('hidden', !hasShield);
  // Charging shimmer while the recharge is actually running; alarm when down
  const charging = hasShield && s.alive && shield < st.shieldMax &&
    game.time - game.lastDamage > st.regenDelay;
  el.shieldBar.classList.toggle('charging', charging);
  el.shieldBar.classList.toggle('down', hasShield && shield <= 0.5);
  // White flash on the bar that just took the hit
  if (s.hull < prevHull - 0.4) flash(el.hullBar);
  if (shield < prevShield - 0.4) flash(el.shieldBar);
  prevHull = s.hull; prevShield = shield;

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

  // Progression: tier + ship class, lives (hearts)
  setText(el.tierLabel, `TIER ${st.tier} · ${(st.shipName || '').toUpperCase()}`);
  const lives = Math.max(0, prog.lives);
  setText(el.livesText, '♥'.repeat(lives) + '♡'.repeat(Math.max(0, PROG.MAX_LIVES - lives)));

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
