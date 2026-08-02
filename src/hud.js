import { PROG, xpForPick, abilityRankCost, abilityById, ABILITIES, SPECS } from './config.js';
import { ACHIEVEMENTS, CATEGORIES, ACH_TOTAL, ACH_MAX_POINTS, isSecret } from './achievements.js';

const el = {};
let msgTimer = null;
let prevHull = Infinity, prevShield = Infinity;
let dispHull = -1, dispShield = -1;   // eased readout values — numbers COUNT, not snap
let prevXpFrac = 0;        // XP-bar fill fraction last frame — pulse on gain
let prevCombo = 0;         // combo stamp retriggers its pop on every increment
let prevScore = 0;         // achievement score — the chip pops on every gain
let prevSpec = '';         // spec chip identity — restyle only when it changes
let livesSig = '';         // lives-pip signature — rebuild on change
let iconSig = '';          // acquired-upgrade chip signature — rebuild on change
let abilBars = [];         // cached { fill, row, id, cost } per learned ability — the per-frame XP fills
let abilHoverId = null;    // ability row the cursor is on, or null — see abilHover
let abilHoverRow = null;   // that row's node, held so the .hover class can be lifted off it
let abilNextEl = null;     // the open readout's live "next rank" line
let abilOutH = 0;          // its measured height — re-placed per move, measured per row
let abilTracking = false;  // is the readout's mousemove listener attached?
let hudGame = null;        // the one game object, for the listeners that run outside updateHud
let hudLive = false;       // cockpit is live and pointable (syncMenus owns it)
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
    'msg', 'speedBadge', 'perfBadge', 'deathScreen', 'deathCause', 'deathLives', 'gameoverScreen', 'gameoverCause',
    'pauseScreen', 'specLabel', 'tierLabel', 'livesText', 'xpBar', 'xpFill', 'xpNext', 'upList2', 'bottomleft',
    'abilOut',
    'upgradeScreen', 'upTitle', 'upList', 'upHint',
    // Front-end shell: splash / pause / settings menus + the in-game menu button
    'topleft', 'splashScreen', 'settingsScreen', 'controlsScreen', 'creditsScreen',
    'menuBtn', 'setPredict', 'setFps', 'setPerf', 'setScale', 'setAutoScale', 'setSeed', 'seedNote',
    'setMusicVol', 'setSfxVol', 'ctrlOut', 'credVersion',
    // Achievements: the run scoreboard, its panel, and the toast rail
    'achievementsScreen', 'achList', 'achFilters', 'achOut', 'achScore', 'achCount', 'achPct',
    'achRail', 'scoreChip', 'gameoverScore',
    'btnStart', 'btnSplashSettings', 'btnSplashControls', 'btnSplashCredits', 'btnSplashExit',
    'btnResume', 'btnPauseSettings', 'btnPauseControls', 'btnPauseAch', 'btnMainMenu', 'btnPauseExit',
    'btnSettingsBack', 'btnControlsBack', 'btnCreditsBack', 'btnAchBack', 'btnGameOverAch']) {
    el[id] = document.getElementById(id);
  }
  hudGame = game;
  el.gametitle = document.querySelector('.gametitle');   // the boot scramble's target (no id)
  el.canvas = document.getElementById('game');           // read ONLY for the perf overlay's backing-store size
  // Tick period on the XP bar = one upgrade pick. The bar spans a whole tier,
  // which is PICKS_PER_TIER picks PLUS the milestone (see the span math in
  // updateHud) — divide by that same total or the ticks drift off the picks.
  el.xpBar.style.setProperty('--tick', `${100 / (PROG.PICKS_PER_TIER + 1)}%`);
  initAchPanel(game);
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

// Drop the slot NOW rather than letting its timer run out. The lifetime is
// wall-clock, so a warning raised in the last second of a run would otherwise
// hang over the title screen it has nothing to do with — and the slot sits at
// 17% from the top, exactly where the splash panel's header is (the same
// collision syncMenus hides it for under a shell modal).
export function clearMessage() {
  clearTimeout(msgTimer);
  el.msg.classList.add('hidden');
  el.msg.textContent = '';
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
  bind('btnPauseAch', handlers.onOpenAchievements);
  bind('btnGameOverAch', handlers.onOpenAchievements);
  // Every shell panel backs out the same way (main.closeShellPanel)
  bind('btnSettingsBack', handlers.onCloseShell);
  bind('btnControlsBack', handlers.onCloseShell);
  bind('btnCreditsBack', handlers.onCloseShell);
  bind('btnAchBack', handlers.onCloseShell);
  bind('setPredict', handlers.onTogglePredict);
  bind('setFps', handlers.onToggleFps);
  bind('setPerf', handlers.onTogglePerf);
  bind('setAutoScale', handlers.onToggleAutoScale);
  // Render scale is a segmented group, so ONE delegated listener covers every
  // cell — adding or retuning a step is then an HTML edit plus main's step
  // table, with nothing here to keep in sync (the CONTROLS schematic's rule).
  if (el.setScale) {
    el.setScale.addEventListener('click', (e) => {
      const btn = e.target.closest('.segbtn');
      if (btn) handlers.onRenderScale(+btn.dataset.v);
    });
  }
  // World seed: `input` records what was typed, `change` (blur / Enter) is the
  // COMMIT that may re-roll the world — regenerating per keystroke would
  // rebuild the whole system on every character. The note line pins the world
  // you're already looking at.
  if (el.setSeed) {
    el.setSeed.addEventListener('input', (e) => handlers.onSeedInput(e.target.value));
    el.setSeed.addEventListener('change', () => handlers.onSeedCommit());
    el.setSeed.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  }
  bind('seedNote', handlers.onSeedPin);
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

// ---- Achievements ----------------------------------------------------------
// The panel is REBUILT on open, never per frame: it is a snapshot of a run in
// progress, the sim is frozen behind it anyway (it's a shell modal), and a
// 150-row list diffed every frame would cost more than everything else in this
// file combined. Rows come straight from the catalog, so adding an achievement
// is a catalog edit and nothing here needs to know it exists.
let achFilter = 'all';       // the category chip currently selected

// A locked SECRET row is redacted — knowing what the classified ones are would
// spoil the only category whose whole point is being surprised by it. Locked
// ordinary rows show in full: a readable locked achievement is a to-do list.
const CAT_LABEL = {};
for (const c of CATEGORIES) CAT_LABEL[c.id] = c.label;

// Catalog text is authored in this repo, not user input — but it lands in an
// ATTRIBUTE here, and apostrophes, quotes and ampersands are all over the
// descriptions. Escape rather than trust the source.
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtClock = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

// A row is COMPACT — marker, name, points — and carries its description in
// data-note for the readout strip below the list. With this many entries a
// two-line row turns the panel into a wall of prose you have to READ to scan;
// one line each in two columns fits a whole category on screen, and pointing at
// one answers "what does this take?" on demand. Same query-the-console idea as
// the CONTROLS schematic, and the same reason the rows are <button>s: focus
// walks them, so a keyboard reads the list exactly like a mouse does.
//
// A locked SECRET row is redacted — knowing what the classified ones are would
// spoil the only category whose whole point is being surprised by it. Locked
// ordinary rows show in full: a readable locked achievement is a to-do list.
function achRow(a, when) {
  const got = when !== undefined;
  const hidden = !got && isSecret(a);
  const name = hidden ? 'CLASSIFIED' : a.name;
  const desc = hidden
    ? 'Classified until you earn it. Whatever it is, you have not done it yet.'
    : a.desc;
  const meta = got
    ? `${CAT_LABEL[a.cat]} · ${a.pts} pts · earned at ${fmtClock(when)}`
    : `${CAT_LABEL[a.cat]} · ${a.pts} pts · not yet earned`;
  return `<button class="acrow${got ? ' got' : ''}${hidden ? ' redacted' : ''} ac-${a.cat}" ` +
    `type="button" data-nm="${esc(name)}" data-note="${esc(desc)}" data-meta="${esc(meta)}">` +
    `<span class="acmark"></span><span class="acname">${esc(name)}</span>` +
    `<span class="acpts">${a.pts}</span></button>`;
}

function buildAchList(game) {
  const st = game.prog.ach;
  const earnedOnly = achFilter === 'got';
  const rows = [];
  for (const cat of CATEGORIES) {
    if (achFilter !== 'all' && !earnedOnly && achFilter !== cat.id) continue;
    let inCat = ACHIEVEMENTS.filter((a) => a.cat === cat.id);
    const total = inCat.length;
    const done = inCat.reduce((n, a) => n + (st.got[a.id] !== undefined ? 1 : 0), 0);
    if (earnedOnly) inCat = inCat.filter((a) => st.got[a.id] !== undefined);
    if (!inCat.length) continue;
    rows.push(`<div class="acgrp"><span class="acghd">${cat.label}</span>` +
      `<span class="acgblurb">${cat.blurb}</span>` +
      `<span class="acgcount">${done}/${total}</span></div>`);
    // Earned first inside a category, then the order the catalog declares —
    // so what you've done reads as a trophy shelf and the rest as the to-do.
    const sorted = inCat.slice().sort((x, y) =>
      (st.got[y.id] !== undefined) - (st.got[x.id] !== undefined));
    for (const a of sorted) rows.push(achRow(a, st.got[a.id]));
  }
  el.achList.innerHTML = rows.join('')
    || '<div class="acempty">Nothing here yet — go and break something.</div>';
}

function buildAchFilters(game) {
  const st = game.prog.ach;
  const chip = (id, label, on) =>
    `<button class="acchip${on ? ' on' : ''}" data-cat="${id}">${label}</button>`;
  // ALL and EARNED bracket the category chips: with this many rows, "just show
  // me what I've actually done" is the view you want most often.
  const out = [
    chip('all', `ALL ${st.order.length}/${ACH_TOTAL}`, achFilter === 'all'),
    chip('got', `EARNED ${st.order.length}`, achFilter === 'got'),
  ];
  for (const cat of CATEGORIES) {
    const inCat = ACHIEVEMENTS.filter((a) => a.cat === cat.id);
    const done = inCat.reduce((n, a) => n + (st.got[a.id] !== undefined ? 1 : 0), 0);
    out.push(chip(cat.id, `${cat.label} ${done}/${inCat.length}`, achFilter === cat.id));
  }
  el.achFilters.innerHTML = out.join('');
}

// Fill the whole panel. Called from syncMenus the frame the panel opens, and
// again whenever the filter changes.
function refreshAchievements(game) {
  const st = game.prog.ach;
  setText(el.achScore, String(st.score));
  setText(el.achCount, `${st.order.length}/${ACH_TOTAL}`);
  setText(el.achPct, `${Math.round((st.score / ACH_MAX_POINTS) * 100)}%`);
  buildAchFilters(game);
  buildAchList(game);
  el.achList.scrollTop = 0;
}

// Both the category chips and the achievement rows are DELEGATED: each refresh
// throws away hundreds of nodes and builds hundreds more, so binding listeners
// per row would leak a listener per rebuild. `game` is captured at init, like
// initHud's.
const ACH_IDLE = ['SELECT AN ENTRY', 'Point at any achievement above to read what it takes.', ''];
function initAchPanel(game) {
  if (!el.achFilters || !el.achList || !el.achOut) return;
  el.achFilters.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cat]');
    if (!t) return;
    achFilter = t.dataset.cat;
    refreshAchievements(game);
  });
  // The readout. Mirrors the pointed-at (or focused) row's own data-* into the
  // strip — exactly the CONTROLS schematic's pattern, so a row carries its own
  // description and nothing here needs to know the catalog exists.
  const nm = el.achOut.querySelector('.aofn');
  const note = el.achOut.querySelector('.aonote');
  const meta = el.achOut.querySelector('.aometa');
  const show = (e) => {
    const t = e.target.closest('.acrow');
    if (!t) return;
    setText(nm, t.dataset.nm);
    setText(note, t.dataset.note);
    setText(meta, t.dataset.meta);
    el.achOut.classList.toggle('locked', !t.classList.contains('got'));
  };
  const clear = () => {
    setText(nm, ACH_IDLE[0]); setText(note, ACH_IDLE[1]); setText(meta, ACH_IDLE[2]);
    el.achOut.classList.remove('locked');
  };
  el.achList.addEventListener('pointerover', show);
  el.achList.addEventListener('focusin', show);
  el.achList.addEventListener('pointerleave', clear);
  el.achList.addEventListener('focusout', clear);
}

// ---- Achievement toasts ----------------------------------------------------
// A landed achievement announces itself on its own rail. Lifetime is driven in
// JS rather than by a fixed CSS animation delay for one reason: HOVERING PAUSES
// IT. A notification you have to read in four seconds is a notification you
// miss, so pointing at a toast holds it open and reveals its full description;
// the clock only restarts once the pointer leaves.
//
// HOVER WITHOUT POINTER-EVENTS. The rail sits in the middle of the play area
// (right of the canvas, under the radar), so the toasts stay
// `pointer-events: none` and hover is HIT-TESTED against their rects from a
// window-level mousemove instead. Giving them real pointer-events would let a
// toast swallow the mousedown that starts a tractor grab — the canvas listener
// would simply never fire, and a rock you reached for would be missed because a
// notification happened to be in the way.
const TOAST_DWELL = 4200;       // ms on screen when never pointed at
const TOAST_LINGER = 1400;      // ms of grace once the pointer leaves
const TOAST_OUT_MS = 460;       // must match the toastOut animation in style.css
const TOAST_MAX = 4;            // a burst drops the oldest rather than growing off-screen
const toasts = [];              // live { node, timer, hover } records, oldest first
let railTracking = false;

function armToast(rec, ms) {
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    rec.node.classList.add('out');
    rec.timer = setTimeout(() => killToast(rec), TOAST_OUT_MS);
  }, ms);
}

function killToast(rec) {
  clearTimeout(rec.timer);
  rec.node.remove();
  const i = toasts.indexOf(rec);
  if (i >= 0) toasts.splice(i, 1);
  // Stop tracking the mouse the moment the last toast goes: this listener only
  // exists while there is something to point at.
  if (!toasts.length && railTracking) {
    window.removeEventListener('mousemove', railHover);
    railTracking = false;
  }
}

function railHover(e) {
  if (!toasts.length) return;
  // Cheap reject first — one rect for the whole rail, and only then the
  // per-toast rects (at most TOAST_MAX of them).
  const r = el.achRail.getBoundingClientRect();
  const near = e.clientX >= r.left && e.clientX <= r.right &&
               e.clientY >= r.top && e.clientY <= r.bottom;
  for (const rec of toasts.slice()) {
    let on = false;
    if (near) {
      const b = rec.node.getBoundingClientRect();
      on = e.clientX >= b.left && e.clientX <= b.right &&
           e.clientY >= b.top && e.clientY <= b.bottom;
    }
    if (on === !!rec.hover) continue;
    rec.hover = on;
    rec.node.classList.toggle('hover', on);
    if (on) {
      // Caught mid-exit? Cancel the leave and bring it back rather than letting
      // it fade out from under the cursor.
      clearTimeout(rec.timer);
      rec.node.classList.remove('out');
    } else {
      armToast(rec, TOAST_LINGER);
    }
  }
}

// ---- Hovered-ability readout ----------------------------------------------
// The loadout list shows an ability's icon, rank pips and XP hairline — every
// bit of it except WHAT THE ABILITY DOES. Pointing at a row prints the catalog
// entry beside the card.
//
// Hit-tested from a window listener against the cached row rects, the SAME
// arrangement the achievement toasts use, and for the same reason: the card
// sits in the bottom-left of the play area, so giving its rows real
// pointer-events would let them swallow the mousedown that starts a tractor
// grab. Nothing here ever takes the mouse. The listener is attached only while
// there are rows to point at.
function abilTrack(on) {
  if (on === abilTracking) return;
  abilTracking = on;
  if (on) window.addEventListener('mousemove', abilHover);
  else { window.removeEventListener('mousemove', abilHover); abilHide(); }
}

function abilHide() {
  if (abilHoverId === null) return;
  abilHoverId = null;
  abilNextEl = null;
  // The node, not a re-query: after a rank lands the row this pointed at has
  // already been replaced, and querying for it would find nothing to clean up.
  if (abilHoverRow) { abilHoverRow.classList.remove('hover'); abilHoverRow = null; }
  el.abilOut.classList.add('hidden');
}

function abilHover(e) {
  // A shell panel, the pick card or the title screen all own the whole screen —
  // a floating readout under them would be pointing at a card nobody can see.
  if (!abilBars.length || !hudLive) { abilHide(); return; }
  // Cheap reject on the list's own rect before touching the per-row ones
  const host = el.upList2.getBoundingClientRect();
  let hit = null;
  if (e.clientX >= host.left && e.clientX <= host.right &&
      e.clientY >= host.top && e.clientY <= host.bottom) {
    for (const b of abilBars) {
      const r = b.row.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) { hit = { b, r }; break; }
    }
  }
  if (!hit) { abilHide(); return; }

  // Rebuild only when the ROW changes — but re-place on every move regardless.
  // The card is bottom-anchored and grows upward, so a rank landing (one more
  // row) or a window resize moves the anchor out from under a held hover; an
  // early return on "same row" left the panel stranded where the card used to
  // be, which on a shrunk window meant off the bottom of the screen entirely.
  if (hit.b.id !== abilHoverId) {
    const u = abilityById(hit.b.id);
    if (!u) { abilHide(); return; }
    // Light the row itself, so the card says which entry the panel is about —
    // adding the class is also what fires its one-shot sheen (see .ab2.hover).
    if (abilHoverRow) abilHoverRow.classList.remove('hover');
    abilHoverRow = hit.b.row;
    abilHoverRow.classList.add('hover');
    abilHoverId = hit.b.id;
    const rank = hudGame.prog.upgrades[u.id] || 0;
    const maxed = rank >= u.max;
    el.abilOut.innerHTML =
      `<span class="aoIc">${u.icon}</span>` +
      `<span class="aoNm">${esc(u.name)}</span>` +
      `<span class="aoRk${maxed ? ' max' : ''}">${maxed ? 'MAX' : `RANK ${rank}/${u.max}`}</span>` +
      `<span class="aoDesc">${esc(u.desc)}</span>` +
      `<span class="aoNext"></span>`;
    abilNextEl = el.abilOut.querySelector('.aoNext');
    abilNextText(hit.b);
    el.abilOut.classList.remove('hidden');
    // Measured once per row, not per move: the copy is fixed for as long as the
    // panel shows this ability, and offsetHeight forces a layout.
    abilOutH = el.abilOut.offsetHeight;
  }

  // Anchored to the card's right edge, centred on the NAME LINE — not on the
  // .ab2 block, whose XP hairline drags its midpoint down between two rows —
  // then clamped, so a row near the bottom of a tall loadout can't push the
  // panel off the screen.
  const card = el.bottomleft.getBoundingClientRect();
  const nr = hit.b.nameRow.getBoundingClientRect();
  const mid = nr.top + nr.height / 2;
  el.abilOut.style.left = `${Math.round(card.right + 14)}px`;
  el.abilOut.style.top = `${Math.round(Math.max(abilOutH / 2 + 10,
    Math.min(window.innerHeight - abilOutH / 2 - 10, mid)))}px`;
}

// The rank track keeps filling while you read it, so the line is live rather
// than a snapshot taken when the cursor arrived.
function abilNextText(b) {
  if (!abilNextEl) return;
  if (!Number.isFinite(b.cost)) { setText(abilNextEl, 'Fully ranked'); return; }
  const bank = (hudGame.prog.abilXp || {})[b.id] || 0;
  setText(abilNextEl, `NEXT RANK ${Math.round(Math.min(1, bank / b.cost) * 100)}%`);
}

export function achToast(a) {
  if (!el.achRail) return;
  const node = document.createElement('div');
  node.className = `actoast ac-${a.cat}`;
  const secret = isSecret(a);
  node.innerHTML = `<span class="atlab">${secret ? 'CLASSIFIED' : 'ACHIEVEMENT'}</span>` +
    `<span class="atname">${esc(a.name)}</span>` +
    // Points only. The XP the row also pays (main.drainAchievements) is
    // deliberately NOT shown: raw XP is an abstracted number the player never
    // reads anywhere else — the bars and the pick card are how progress
    // surfaces — so printing it here would be noise, not feedback.
    `<span class="atpts">+${a.pts}</span>` +
    `<span class="atwrap"><span class="atdesc">${esc(a.desc)}</span></span>`;
  el.achRail.appendChild(node);
  const rec = { node, timer: 0, hover: false };
  toasts.push(rec);
  armToast(rec, TOAST_DWELL);
  while (toasts.length > TOAST_MAX) killToast(toasts[0]);
  if (!railTracking) {
    window.addEventListener('mousemove', railHover);
    railTracking = true;
  }
}

// Reflect a slider without fighting an in-progress drag
function setSlider(node, v) {
  if (!node || document.activeElement === node) return;
  const val = String(Math.round(v * 100));
  if (node.value !== val) node.value = val;
}

// Reflect a text field without fighting live typing — same activeElement guard
// as setSlider, and for the same reason: rewriting the value under a cursor
// would jump the caret to the end on every frame.
function setInput(node, v) {
  if (!node || document.activeElement === node) return;
  if (node.value !== v) node.value = v;
}

// Reflect a segmented choice (render scale). Same guarded-write discipline as
// setToggle — it walks its cells only when the selected value actually moves.
function setSeg(node, v) {
  if (!node) return;
  const key = String(v);
  if (lastText.get(node) === key) return;
  lastText.set(node, key);
  for (const b of node.children) {
    const on = b.dataset.v === key;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
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
  const achieve = !!game.achievementsOpen;
  const modal = settings || controls || credits || achieve;
  const splash = !game.started && !modal;
  const pause = game.started && game.paused && !modal;
  const menuBtn = game.started && !game.paused && !modal &&
    !game.choosingUpgrade && !game.gameOver && game.ship.alive;
  // Same condition = "the cockpit is live and yours to point at". The hovered-
  // ability readout rides it (recomputed every frame, unlike the class writes
  // below, which are signature-gated) so a floating panel can't sit under the
  // pick card or a shell modal.
  hudLive = menuBtn;
  if (!hudLive) abilHide();
  const sig = `${+splash}${+pause}${+settings}${+controls}${+credits}${+achieve}${+menuBtn}${+game.started}`;
  if (sig !== menuSig) {
    menuSig = sig;
    el.splashScreen.classList.toggle('hidden', !splash);
    el.pauseScreen.classList.toggle('hidden', !pause);
    el.settingsScreen.classList.toggle('hidden', !settings);
    el.controlsScreen.classList.toggle('hidden', !controls);
    el.creditsScreen.classList.toggle('hidden', !credits);
    el.achievementsScreen.classList.toggle('hidden', !achieve);
    // Rebuilt ON OPEN and only then (see the buildAchList comment). The sig
    // guard means this runs on the transition, not every frame the panel is up.
    if (achieve) refreshAchievements(game);
    // A shell modal fully REPLACES the panel it opened over (the same law that
    // makes the three shell panels mutually exclusive) — and that includes the
    // DEATH and GAME OVER panels, which are centered .panels too: without this
    // they show through around the modal's edges, which reads as broken. It
    // matters now because ACHIEVEMENTS is reachable from the game-over screen.
    // The message slot goes with them for the same reason: it sits at 17% from
    // the top, exactly where a panel's header is. Their own state is restored
    // from the live flags when the modal closes.
    if (modal) {
      el.deathScreen.classList.add('hidden');
      el.gameoverScreen.classList.add('hidden');
      el.msg.classList.add('hidden');
    } else if (prevModal) {
      el.gameoverScreen.classList.toggle('hidden', !game.gameOver);
      el.deathScreen.classList.toggle('hidden',
        !(game.started && !game.gameOver && !game.ship.alive && game.deathShown));
      if (game.gameOver) gameOverScore(game.prog);   // the log itself scores points
    }
    el.menuBtn.classList.toggle('hidden', !menuBtn);
    // The gameplay HUD is meaningless on the title screen — hide it until START.
    el.topleft.classList.toggle('hidden', !game.started);
    // The XP rail and the tier line live INSIDE the pilot card now, so hiding
    // the card hides them — they no longer need toggles of their own. (The
    // hover readout is NOT inside it; the hudLive gate above drops that one.)
    el.bottomleft.classList.toggle('hidden', !game.started);
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
  setToggle(el.setFps, game.showFps);
  setToggle(el.setPerf, game.showPerf);
  // The SETTING, not the effective scale: the control must keep showing the
  // ceiling the player chose even while auto quality is running below it (the
  // perf overlay is where the effective one is reported).
  setSeg(el.setScale, game.renderScale);
  setToggle(el.setAutoScale, game.autoScale);
  setSlider(el.setMusicVol, game.musicVol);
  setSlider(el.setSfxVol, game.sfxVol);
  setInput(el.setSeed, game.seedText);
  // The seed note names the world you're actually in (click it to pin that
  // one). A pin that doesn't match the live world can only be waiting on the
  // next run — say so, rather than letting the field look like it did nothing.
  if (el.seedNote) {
    const pending = game.seedPin != null && game.seedPin !== game.worldSeed;
    setText(el.seedNote, `World ${game.worldSeed}${pending ? ' · new seed applies next run' : ' · click to keep it'}`);
  }
  // Version lands asynchronously (a package.json fetch) — setText is diffed, so
  // this costs exactly one DOM write whenever it finally resolves.
  if (el.credVersion) setText(el.credVersion, game.version ? `Solar Slinger v${game.version}` : 'Solar Slinger');
}

export function setDeathVisible(v, cause = '', lives = 0) {
  el.deathScreen.classList.toggle('hidden', !v);
  if (v) {
    el.deathCause.textContent = cause || 'Your ship broke apart.';
    el.deathLives.textContent = `${lives} ${lives === 1 ? 'life' : 'lives'} left — press R to respawn`;
  }
}

// A run ends on a NUMBER, not just a cause of death — the final score is the
// one thing that says how this flight went compared with the last. Redrawn
// rather than written once, because the score can still move after the run
// ends (opening the achievement log is itself worth points).
function gameOverScore(prog) {
  const st = prog && prog.ach;
  el.gameoverScore.innerHTML = st
    ? `<span class="gosnum">${st.score}</span><span class="goslab">FINAL SCORE</span>` +
      `<span class="gosdet">${st.order.length} of ${ACH_TOTAL} achievements</span>`
    : '';
}

export function setGameOverVisible(v, cause = '', prog = null) {
  el.gameoverScreen.classList.toggle('hidden', !v);
  if (!v) return;
  el.gameoverCause.textContent = cause || 'Your ship broke apart.';
  gameOverScore(prog);
}

// Build (or hide) the choice modal. `kind` is 'spec' (run-opening specialization
// cards), 'tier' (the tier-up milestone) or 'upgrade' (the between-tier pick) —
// the last two both offer NEW abilities; deepening never comes through here.
// Both ability kinds title as LEARN — a card is always a new ability now, and
// only the milestone one also carries the tier.
const UP_TITLES = { spec: 'CHOOSE YOUR SPECIALIZATION', tier: 'TIER UP — LEARN AN ABILITY', upgrade: 'LEARN AN ABILITY' };
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
      // Cards only ever offer abilities you don't own, so the sub-line sells the
      // TRACK it opens: how deep it goes, and that it deepens on its own from
      // here (there is no rank-up card to come back for).
      sub = `<div class="uplevel">New ability · ${c.max} ranks, earned automatically</div>`;
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

// ---- The perf overlay (Settings: FPS counter / Performance metrics) --------
// Two independent toggles feeding one badge: FPS is the top line, the metrics
// block is everything under it. Both off costs a single classList check — the
// string is never built. Refreshed at ~5 Hz rather than per frame BECAUSE per-
// frame digits are unreadable (they strobe faster than you can focus on them),
// and it keeps the mote sum — the only loop here — off the hot path.
// main.js owns the sampling (game.perf); this only formats it.
const PERF_MS = 200;
let perfNext = 0;
function perfBadge(game) {
  const on = game.showFps || game.showPerf;
  el.perfBadge.classList.toggle('hidden', !on);
  if (!on) return;
  const now = performance.now();
  if (now < perfNext) return;
  perfNext = now + PERF_MS;
  const p = game.perf || {};
  const lines = [];
  if (game.showFps) lines.push(`${Math.round(p.fps || 0)} FPS`);
  if (game.showPerf) {
    let motes = 0;
    for (const g of game.glowPockets) motes += g.motes ? g.motes.length : 0;
    lines.push(`frame ${(p.frameMs || 0).toFixed(1)}  sim ${(p.simMs || 0).toFixed(1)}  draw ${(p.drawMs || 0).toFixed(1)} ms`);
    lines.push(`steps ${p.steps || 0} · bodies ${game.bodies.length} · debris ${game.debris.length}`);
    lines.push(`fx ${game.particles.length} · aliens ${game.aliens.length} · motes ${motes} · orbit ${game.orbit.length}`);
    // RENDER SCALE, with the real backing-store size beside it. Auto-degrade is
    // deliberately quiet in play (no toast, no flash — it exists so a struggling
    // machine stops struggling), so this line is the ONLY place a drop below the
    // chosen ceiling is visible. Say "auto" when it's running under the setting.
    const eff = game.renderScaleEff || 1;
    const auto = eff < (game.renderScale || 1) ? ' auto' : '';
    const cw = el.canvas ? el.canvas.width : 0, ch = el.canvas ? el.canvas.height : 0;
    lines.push(`scale ${Math.round(eff * 100)}%${auto} · ${cw}×${ch}`);
  }
  setText(el.perfBadge, lines.join('\n'));
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
  perfBadge(game);
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
  // Achievement score. Hidden until the run scores its first point — a zero on
  // the cockpit before you've done anything is just clutter; the moment it
  // appears IS the first achievement. It pops on every gain, like the XP bar.
  const score = prog.ach ? prog.ach.score : 0;
  el.scoreChip.classList.toggle('hidden', score <= 0);
  if (score > 0) {
    if (score !== prevScore) flash(el.scoreChip, 'pop');
    setText(el.scoreChip, `★ ${score}`);
  }
  prevScore = score;
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
  // The rail's number, in the vitals' label/number grammar. It reads the NEXT
  // PICK, not the tier: the picks are what the segment dividers mark, and the
  // next one is the reward actually in reach.
  setText(el.xpNext, `NEXT ${Math.round(pickFrac * 100)}%`);
  // XP coming in makes the bar spark — every scrap pickup / kill answers back
  if (barFrac > prevXpFrac + 0.0005) flash(el.xpBar, 'gain');
  prevXpFrac = barFrac;

  // Acquired abilities — a detailed list, each with its own XP bar: ranks are
  // AUTOMATIC now (config.growAbilities), so every learned ability is a track
  // you can watch fill toward its next rank. The rows are rebuilt only when the
  // build changes (a new ability, or a rank landing); the FILLS then ride every
  // frame off cached element refs, since they move continuously.
  const sig = ABILITIES.map((u) => prog.upgrades[u.id] || 0).join(',');
  if (sig !== iconSig) {
    iconSig = sig;
    const owned = ABILITIES.filter((u) => (prog.upgrades[u.id] || 0) > 0);
    const rows = owned.map((u) => {
      const rk = prog.upgrades[u.id];
      const maxed = rk >= u.max;
      // Every ability is six ranks (config's catalog law), so every row draws
      // pips — there is no longer a single-unlock row wearing an ON badge.
      const rankEl = `<span class="ui-rk">${Array.from({ length: u.max }, (_, i) =>
        `<span class="rp${i < rk ? ' on' : ''}"></span>`).join('')}</span>`;
      // A maxed track has nothing left to earn — its bar reads solid rather
      // than sitting at a fraction that will never move.
      return `<div class="ab2" data-ab="${u.id}">` +
        `<div class="uprow2"><span class="ui-ic">${u.icon}</span>` +
        `<span class="ui-nm">${u.name}</span>${rankEl}</div>` +
        `<div class="ui-xp${maxed ? ' max' : ''}"><span class="ui-xpf"></span></div></div>`;
    }).join('');
    el.upList2.innerHTML = owned.length
      ? `<div class="ulhead">ABILITIES</div>${rows}`
      : '';
    // Cache the fills, their rows and their current thresholds so the per-frame
    // pass is a width write and nothing else — no queries, no cost lookups. The
    // rows are for the hover readout's hit test, which runs off the same cache.
    abilBars = owned.map((u) => {
      const row = el.upList2.querySelector(`.ab2[data-ab="${u.id}"]`);
      return {
        row,                                    // hit target (row + its XP hairline)
        nameRow: row.querySelector('.uprow2'),  // what the readout centres on
        fill: row.querySelector('.ui-xpf'),
        id: u.id,
        cost: abilityRankCost(u, prog.upgrades[u.id]),
      };
    });
    // Every cached node the open readout was pointing at just died with the
    // innerHTML write; drop it and let the next mousemove re-open on the row
    // that is actually under the cursor now.
    abilHide();
    abilTrack(abilBars.length > 0);
  }
  const bank = prog.abilXp || {};
  for (const b of abilBars) {
    // A maxed track's cost is Infinity — that divides to 0, so it's pinned full
    // explicitly (the .max class dims it; the width is what makes it READ full).
    const frac = Number.isFinite(b.cost)
      ? Math.max(0, Math.min(1, (bank[b.id] || 0) / b.cost))
      : 1;
    setWidth(b.fill, `${(frac * 100).toFixed(1)}%`);
    if (b.id === abilHoverId) abilNextText(b);
  }
}
