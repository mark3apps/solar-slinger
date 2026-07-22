import { UPGRADES, shipStats } from './config.js';
import { sfxUpgrade, sfxDenied } from './sfx.js';

const el = {};
let msgTimer = null;

export function initHud(game) {
  for (const id of ['hullFill', 'hullText', 'scrapText', 'tierText', 'msg',
    'upgradePanel', 'upList', 'deathScreen', 'deathCause', 'pauseScreen']) {
    el[id] = document.getElementById(id);
  }
  buildUpgradeList(game);
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

function buildUpgradeList(game) {
  el.upList.innerHTML = '';
  for (const key of Object.keys(UPGRADES)) {
    const row = document.createElement('div');
    row.className = 'uprow';
    row.innerHTML = `
      <div class="upinfo">
        <div class="upname"></div>
        <div class="updesc"></div>
        <div class="uplevel"></div>
      </div>
      <button class="upbtn"></button>`;
    row.querySelector('.upbtn').addEventListener('click', () => buyUpgrade(game, key));
    row.dataset.key = key;
    el.upList.appendChild(row);
  }
  refreshUpgrades(game);
}

export function refreshUpgrades(game) {
  for (const row of el.upList.children) {
    const key = row.dataset.key;
    const u = UPGRADES[key];
    const lvl = game.up[key];
    const maxed = lvl >= u.levels.length - 1;
    row.querySelector('.upname').textContent = u.name;
    row.querySelector('.updesc').textContent = u.desc;
    const cur = key === 'capacity' ? u.labels[lvl] : u.levels[lvl];
    const next = maxed ? '' : (key === 'capacity' ? u.labels[lvl + 1] : u.levels[lvl + 1]);
    row.querySelector('.uplevel').textContent =
      `Lv ${lvl + 1}/${u.levels.length} — ${cur}` + (maxed ? '' : `  →  ${next}`);
    const btn = row.querySelector('.upbtn');
    if (maxed) {
      btn.textContent = 'MAXED';
      btn.disabled = true;
      btn.classList.add('maxed');
    } else {
      const cost = u.costs[lvl + 1];
      btn.textContent = `⬡ ${cost}`;
      btn.disabled = game.scrap < cost;
      btn.classList.remove('maxed');
    }
  }
}

function buyUpgrade(game, key) {
  const u = UPGRADES[key];
  const lvl = game.up[key];
  if (lvl >= u.levels.length - 1) return;
  const cost = u.costs[lvl + 1];
  if (game.scrap < cost) { sfxDenied(); return; }
  game.scrap -= cost;
  game.up[key]++;
  game.st = shipStats(game.up);
  if (key === 'hull') game.ship.hull = game.st.maxHull;
  sfxUpgrade();
  refreshUpgrades(game);
  if (key === 'capacity') message(`Tractor upgraded: can now grab ${game.st.capacityLabel.toUpperCase()}`, 4);
}

export function toggleUpgrades(game) {
  game.upOpen = !game.upOpen;
  el.upgradePanel.classList.toggle('hidden', !game.upOpen);
  if (game.upOpen) refreshUpgrades(game);
}

export function setPauseVisible(v) { el.pauseScreen.classList.toggle('hidden', !v); }

export function setDeathVisible(v, cause = '') {
  el.deathScreen.classList.toggle('hidden', !v);
  if (v) el.deathCause.textContent = cause || 'Your ship broke apart.';
}

export function updateHud(game) {
  const s = game.ship;
  const frac = Math.max(0, s.hull / game.st.maxHull);
  el.hullFill.style.width = `${frac * 100}%`;
  el.hullFill.classList.toggle('low', frac < 0.35);
  el.hullText.textContent = `HULL ${Math.max(0, Math.ceil(s.hull))}/${game.st.maxHull}`;
  el.scrapText.textContent = Math.floor(game.scrap);
  el.tierText.textContent = game.st.capacityLabel;
  if (game.upOpen && game._scrapDirty !== Math.floor(game.scrap)) {
    game._scrapDirty = Math.floor(game.scrap);
    refreshUpgrades(game);
  }
}
