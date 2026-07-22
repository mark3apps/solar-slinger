import { GROWTH, TIERS } from './config.js';

const el = {};
let msgTimer = null;

export function initHud(game) {
  for (const id of ['hullFill', 'hullText', 'scrapText', 'beamText', 'orbitText',
    'flingText', 'thrustText', 'msg', 'upgradePanel', 'upList',
    'deathScreen', 'deathCause', 'pauseScreen']) {
    el[id] = document.getElementById(id);
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

// Read-only ship systems view (upgrades are automatic — this shows progress)
function trackRow(name, level, value, how) {
  const pips = Array.from({ length: 6 }, (_, i) =>
    `<span class="pip${i <= level ? ' lit' : ''}"></span>`).join('');
  return `<div class="uprow">
    <div class="upinfo">
      <div class="upname">${name} <span class="pips">${pips}</span></div>
      <div class="uplevel">${value}</div>
      <div class="updesc">${how}</div>
    </div>
  </div>`;
}

export function refreshStats(game) {
  const st = game.st, p = game.prog;
  const nextCap = st.tier < TIERS.caps.length - 1
    ? ` — next tier at ${Math.round(TIERS.caps[st.tier + 1] / 1000)}k` : ' — MAX';
  el.upList.innerHTML =
    trackRow('TRACTOR BEAM', st.levels.beam,
      `grabs ${st.label.toLowerCase()} (${Math.round(st.capacity / 100) / 10}k capacity${nextCap})`,
      `${p.catches} catches — grows every time you tractor something; heavy catches grow it faster`) +
    trackRow('ORBIT SHIELD', Math.max(-1, st.levels.beam - 1),
      st.orbitCap > 0
        ? `holds ${st.maxOrbiters} × ${st.orbitLabel.toLowerCase()} (right-click while holding)`
        : 'locked — strengthen the beam to unlock',
      'orbiting rocks block incoming fire; left-click empty space to fling one') +
    trackRow('FLING DRIVE', st.levels.fling,
      `launch speed ${Math.round(st.fling)}`,
      `${p.smashes} smashes — grows every time one of your throws destroys something`) +
    trackRow('HULL', st.levels.hull,
      `max integrity ${st.maxHull}`,
      `${Math.round(p.scrapCollected)} scrap absorbed — collecting scrap heals and toughens you`) +
    trackRow('ENGINES', st.levels.thrust,
      `thrust ${Math.round(st.thrust)}`,
      `${Math.round(p.dv / 1000)}k delta-v spent — flying hard makes you faster`);
}

export function toggleUpgrades(game) {
  game.upOpen = !game.upOpen;
  el.upgradePanel.classList.toggle('hidden', !game.upOpen);
  if (game.upOpen) refreshStats(game);
}

export function setPauseVisible(v) { el.pauseScreen.classList.toggle('hidden', !v); }

export function setDeathVisible(v, cause = '') {
  el.deathScreen.classList.toggle('hidden', !v);
  if (v) el.deathCause.textContent = cause || 'Your ship broke apart.';
}

export function updateHud(game) {
  const s = game.ship;
  const st = game.st;
  const frac = Math.max(0, s.hull / st.maxHull);
  el.hullFill.style.width = `${frac * 100}%`;
  el.hullFill.classList.toggle('low', frac < 0.35);
  el.hullText.textContent = `HULL ${Math.max(0, Math.ceil(s.hull))}/${st.maxHull}`;
  el.scrapText.textContent = Math.floor(game.scrap);
  el.beamText.textContent = st.label;
  el.orbitText.textContent = st.orbitCap > 0
    ? `${game.orbit.length}/${st.maxOrbiters} (${st.orbitLabel.toLowerCase()})`
    : 'locked';
  el.flingText.textContent = Math.round(st.fling);
  el.thrustText.textContent = Math.round(st.thrust);
  if (game.upOpen) refreshStats(game);
}
