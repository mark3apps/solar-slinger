import { CFG } from './config.js';

const el = {};
let msgTimer = null;
let pipSig = '';
let prevHull = Infinity, prevShield = Infinity;
const trackEls = [];       // per-track {row, pips, tval, tnextfill} cached at init
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

// [levels key, label, current-value getter]
const TRACKS = [
  ['beam',   'BEAM',   (g) => g.st.label],
  ['orbit',  'ORBIT',  (g) => g.st.orbitCap > 0 ? `${g.orbit.length}/${g.st.maxOrbiters} ${g.st.orbitLabel.toLowerCase()}` : 'locked'],
  ['fling',  'FLING',  (g) => Math.round(g.st.fling)],
  ['hull',   'HULL',   (g) => `max ${g.st.maxHull}`],
  ['thrust', 'ENGINE', (g) => Math.round(g.st.thrust)],
  ['chart',  'CHART',  (g) => g.surveyTotal ? `${g.prog.surveyed}/${g.surveyTotal} worlds` : '—'],
];

export function initHud(game) {
  for (const id of ['hullFill', 'shieldFill', 'hullNum', 'shieldNum', 'hullBar', 'shieldBar',
    'scrapText', 'tracks', 'msg', 'deathScreen', 'deathCause', 'pauseScreen']) {
    el[id] = document.getElementById(id);
  }
  // Build one row per progression track — levels live on screen, always
  el.tracks.innerHTML = '';
  trackEls.length = 0;
  for (const [key, label] of TRACKS) {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.key = key;
    row.innerHTML = `<span class="tlabel">${label}</span><span class="pips"></span>` +
      `<span class="tnext"><span class="tnextfill"></span></span><span class="tval"></span>`;
    el.tracks.appendChild(row);
    trackEls.push({
      key, row,
      pips: row.querySelector('.pips'),
      tval: row.querySelector('.tval'),
      tnextfill: row.querySelector('.tnextfill'),
      val: TRACKS.find(([k]) => k === key)[2],
    });
  }
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

export function setPauseVisible(v) { el.pauseScreen.classList.toggle('hidden', !v); }

export function setDeathVisible(v, cause = '') {
  el.deathScreen.classList.toggle('hidden', !v);
  if (v) el.deathCause.textContent = cause || 'Your ship broke apart.';
}

export function updateHud(game) {
  const s = game.ship;
  const st = game.st;
  const shield = Math.max(0, s.shield || 0);
  const hullFrac = Math.max(0, Math.min(1, s.hull / st.hullMax));
  const shieldFrac = Math.max(0, Math.min(1, shield / st.shieldMax));
  setWidth(el.hullFill, `${hullFrac * 100}%`);
  setWidth(el.shieldFill, `${shieldFrac * 100}%`);
  setText(el.hullNum, `${Math.max(0, Math.ceil(s.hull))}/${st.hullMax}`);
  setText(el.shieldNum, `${Math.ceil(shield)}/${st.shieldMax}`);
  el.hullBar.classList.toggle('low', hullFrac < 0.35);
  // Charging shimmer while the recharge is actually running; alarm when down
  const charging = s.alive && shield < st.shieldMax &&
    game.time - game.lastDamage > CFG.SHIP_REGEN_DELAY;
  el.shieldBar.classList.toggle('charging', charging);
  el.shieldBar.classList.toggle('down', shield <= 0.5);
  // White flash on the bar that just took the hit
  if (s.hull < prevHull - 0.4) flash(el.hullBar);
  if (shield < prevShield - 0.4) flash(el.shieldBar);
  prevHull = s.hull; prevShield = shield;
  setText(el.scrapText, `${Math.floor(game.scrap)}`);

  // Rebuild pips only when a level actually changes
  const sig = TRACKS.map(([key]) => st.levels[key]).join(',');
  if (sig !== pipSig) {
    pipSig = sig;
    for (const t of trackEls) {
      const lvl = st.levels[t.key];
      t.pips.innerHTML = Array.from({ length: 6 }, (_, i) =>
        `<span class="pip${i <= lvl ? ' lit' : ''}"></span>`).join('');
    }
  }
  for (const t of trackEls) {
    setText(t.tval, `${t.val(game)}`);
    // Progress toward the next level, live
    setWidth(t.tnextfill, `${Math.round(st.fracs[t.key] * 100)}%`);
  }
}
