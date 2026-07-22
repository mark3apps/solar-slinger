const el = {};
let msgTimer = null;
let pipSig = '';

// [levels key, label, current-value getter]
const TRACKS = [
  ['beam',   'BEAM',   (g) => g.st.label],
  ['orbit',  'ORBIT',  (g) => g.st.orbitCap > 0 ? `${g.orbit.length}/${g.st.maxOrbiters} ${g.st.orbitLabel.toLowerCase()}` : 'locked'],
  ['fling',  'FLING',  (g) => Math.round(g.st.fling)],
  ['hull',   'HULL',   (g) => `max ${g.st.maxHull}`],
  ['thrust', 'ENGINE', (g) => Math.round(g.st.thrust)],
];

export function initHud(game) {
  for (const id of ['hullFill', 'hullText', 'scrapText', 'tracks', 'msg',
    'deathScreen', 'deathCause', 'pauseScreen']) {
    el[id] = document.getElementById(id);
  }
  // Build one row per progression track — levels live on screen, always
  el.tracks.innerHTML = '';
  for (const [key, label] of TRACKS) {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.key = key;
    row.innerHTML = `<span class="tlabel">${label}</span><span class="pips"></span>` +
      `<span class="tnext"><span class="tnextfill"></span></span><span class="tval"></span>`;
    el.tracks.appendChild(row);
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
  const frac = Math.max(0, s.hull / st.maxHull);
  el.hullFill.style.width = `${frac * 100}%`;
  el.hullFill.classList.toggle('low', frac < 0.35);
  el.hullText.textContent = `HULL ${Math.max(0, Math.ceil(s.hull))}/${st.maxHull}`;
  el.scrapText.textContent = Math.floor(game.scrap);

  // Rebuild pips only when a level actually changes
  const sig = TRACKS.map(([key]) => st.levels[key]).join(',');
  if (sig !== pipSig) {
    pipSig = sig;
    for (const row of el.tracks.children) {
      const lvl = st.levels[row.dataset.key];
      row.querySelector('.pips').innerHTML = Array.from({ length: 6 }, (_, i) =>
        `<span class="pip${i <= lvl ? ' lit' : ''}"></span>`).join('');
    }
  }
  for (const row of el.tracks.children) {
    const track = TRACKS.find(([key]) => key === row.dataset.key);
    row.querySelector('.tval').textContent = track[2](game);
    // Progress toward the next level, live
    const frac = st.fracs[row.dataset.key];
    row.querySelector('.tnextfill').style.width = `${Math.round(frac * 100)}%`;
  }
}
