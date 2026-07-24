import { PROG, xpForPick, upgradeById, UPGRADES } from './config.js';

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
    'msg', 'deathScreen', 'deathCause', 'deathLives', 'gameoverScreen', 'gameoverCause',
    'pauseScreen', 'tierLabel', 'livesText', 'xpBar', 'xpFill', 'upList2',
    'upgradeScreen', 'upTitle', 'upList', 'upHint']) {
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

export function setPauseVisible(v) { el.pauseScreen.classList.toggle('hidden', !v); }

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

// Build (or hide) the upgrade-choice modal. `choices` are the actual UPGRADE or
// PATH objects; `kind` is 'upgrade' (2 cards) or 'path' (3 milestone cards).
export function setUpgradeVisible(game, choices, kind, onPick) {
  if (!choices || !choices.length) {
    el.upgradeScreen.classList.add('hidden');
    el.upList.innerHTML = '';
    pickCb = null;
    return;
  }
  pickCb = onPick;
  const isPath = kind === 'path';
  el.upTitle.textContent = isPath ? 'TIER UP — CHOOSE A PATH' : 'CHOOSE AN UPGRADE';
  el.upHint.textContent = `Press ${choices.map((_, i) => i + 1).join(' / ')} — or click a card`;
  el.upList.innerHTML = '';
  choices.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'uprow' + (isPath ? ' path' : '');
    let sub;
    if (isPath) {
      const g = c.grant ? upgradeById(c.grant) : null;
      sub = `<div class="uplevel">Grants ${g ? g.name : 'a bonus'} + steers your upgrade pool</div>`;
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
  const s = game.ship;
  const st = game.st;
  const prog = game.prog;
  const shield = Math.max(0, s.shield || 0);
  const hullFrac = Math.max(0, Math.min(1, s.hull / st.hullMax));
  const shieldFrac = st.shieldMax > 0 ? Math.max(0, Math.min(1, shield / st.shieldMax)) : 0;
  setWidth(el.hullFill, `${hullFrac * 100}%`);
  setWidth(el.shieldFill, `${shieldFrac * 100}%`);
  setText(el.hullNum, `${Math.max(0, Math.ceil(s.hull))}/${st.hullMax}`);
  setText(el.shieldNum, `${Math.ceil(shield)}/${st.shieldMax}`);
  el.hullBar.classList.toggle('low', hullFrac < 0.35);
  // Charging shimmer while the recharge is actually running; alarm when down
  const charging = s.alive && shield < st.shieldMax &&
    game.time - game.lastDamage > st.regenDelay;
  el.shieldBar.classList.toggle('charging', charging);
  el.shieldBar.classList.toggle('down', shield <= 0.5);
  // White flash on the bar that just took the hit
  if (s.hull < prevHull - 0.4) flash(el.hullBar);
  if (shield < prevShield - 0.4) flash(el.shieldBar);
  prevHull = s.hull; prevShield = shield;

  // Progression: tier + ship class, lives (hearts)
  setText(el.tierLabel, `TIER ${st.tier} · ${(st.shipName || '').toUpperCase()}`);
  const lives = Math.max(0, prog.lives);
  setText(el.livesText, '♥'.repeat(lives) + '♡'.repeat(Math.max(0, PROG.MAX_LIVES - lives)));

  // XP bar spans the WHOLE current tier: each earned pick advances it by one
  // tick, a full bar is the tier-up milestone. At max tier it loops per pick.
  const perTier = PROG.PICKS_PER_TIER;
  const pickFrac = Math.max(0, Math.min(1, prog.xp / xpForPick(prog)));
  const atMax = st.tier >= 5;
  const done = atMax ? (prog.picksThisTier % perTier) : prog.picksThisTier;
  const barFrac = Math.min(1, (done + pickFrac) / perTier);
  setWidth(el.xpFill, `${barFrac * 100}%`);

  // Acquired upgrades — a detailed list; rebuild only when the build changes
  const sig = UPGRADES.map((u) => prog.upgrades[u.id] || 0).join(',');
  if (sig !== iconSig) {
    iconSig = sig;
    const owned = UPGRADES.filter((u) => (prog.upgrades[u.id] || 0) > 0);
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
      ? `<div class="ulhead">UPGRADES</div>${rows}`
      : '';
  }
}
