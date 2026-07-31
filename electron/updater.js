// Auto-update layer for the Electron shell. Lives entirely on this side of the
// packaging boundary — the game (src/) has no idea updates exist.
//
// Builds ship UNSIGNED (see scripts/adhoc-sign-mac.js), which splits the world:
// - Windows (NSIS) + Linux AppImage: full auto-update via electron-updater.
//   Signing is not required — integrity comes from the sha512 in latest*.yml on
//   the release. Downloads in the background, installs on quit (NSIS runs the
//   new installer; AppImage swaps the file in place — no root either way);
//   a dialog offers "Restart now". AppImage is detected via process.env.APPIMAGE
//   (set by the AppImage runtime — absent means we're not running from one).
// - macOS: Squirrel.Mac refuses to swap an unsigned/ad-hoc-signed bundle, so
//   electron-updater CANNOT install here until a real Developer ID is configured
//   (Developer ID + notarization + a mac `zip` target is the unlock — then the
//   mac branch below can join the full-auto path). Until then we check the
//   GitHub releases API and offer to open the download page.
// - Linux (deb/rpm): the install is root-owned; an in-place swap would need a
//   pkexec password prompt mid-game. Same check-and-notify as macOS — deb/rpm
//   users who want self-update should grab the AppImage instead.
//
// The full-auto path needs four things to keep working, all wired already:
// 1. The `build.publish` block in package.json — it makes electron-builder embed
//    app-update.yml in the app (the feed pointer) and emit the dist/latest*.yml
//    feeds (latest.yml for win, latest-linux[-arm64].yml per AppImage arch).
// 2. The release workflow uploading latest*.yml + *.blockmap to the GitHub
//    release — electron-updater reads the version/sha512 from the yml there,
//    and blockmaps enable differential downloads (missing = full download).
// 3. A public repo — both electron-updater's feed and the API check below are
//    unauthenticated.
// 4. SPACE-FREE artifact names (nsis/appImage artifactName in package.json) —
//    GitHub renames uploaded assets with dots where the yml expects dashes,
//    which 404s every check. See CLAUDE.md "Desktop packaging".
// Removing any of them silently reverts those platforms to manual updates.
//
// Failure law: update checks must be INVISIBLE when they fail. Offline, DNS
// down, API rate-limited — the game just runs. Never surface an error dialog.
'use strict';

const { app, dialog, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = 'mark3apps/solar-slinger';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// First check waits out the launch (don't compete with world gen + audio decode
// for the first impression); re-checks catch a window left open for days.
const FIRST_CHECK_MS = 15 * 1000;
const RECHECK_MS = 4 * 60 * 60 * 1000;

let win = null;
let promptedVersion = null; // one prompt per version per run — never nag

// ---------------------------------------------------------------- prefs
// Tiny JSON blob in userData for "Skip this version" (notify platforms only —
// the full-auto path installs silently on quit, there's nothing to skip).

const prefsPath = () => path.join(app.getPath('userData'), 'update-prefs.json');

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); }
  catch { return {}; }
}

function writePrefs(prefs) {
  try { fs.writeFileSync(prefsPath(), JSON.stringify(prefs)); }
  catch { /* a failed pref write must not break anything */ }
}

// ---------------------------------------------------------------- helpers

function parentWindow() {
  return win && !win.isDestroyed() ? win : undefined;
}

function isNewer(a, b) {
  // plain x.y.z compare; anything unparseable is "not newer" (fail closed)
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// ---------------------------------------------------------------- full auto
// Windows NSIS + Linux AppImage: electron-updater drives the whole cycle
// (its platform pick is automatic — NsisUpdater / AppImageUpdater); we only
// decorate it with a dialog.

function initFullUpdater() {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  // Quit = install, even if the user clicked "Later" — this is the actual
  // "it updates itself" promise; the dialog is just an accelerator.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { /* failure law: silent */ });

  autoUpdater.on('update-downloaded', async (info) => {
    if (promptedVersion === info.version) return;
    promptedVersion = info.version;
    const { response } = await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      title: 'Update ready',
      message: `Solar Slinger v${info.version} is ready.`,
      detail: 'It installs itself when you quit — or restart now to jump straight in.',
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, RECHECK_MS);
}

// ---------------------------------------------------------------- mac/linux
// Check-and-notify: the strongest thing an unsigned mac build / root-owned
// linux package can honestly offer. One click lands on the release page.

async function checkAndNotify() {
  let latest;
  try {
    const res = await net.fetch(API_LATEST, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    latest = await res.json();
  } catch { return; } // failure law: silent

  const version = String(latest.tag_name || '').replace(/^v/, '');
  if (!isNewer(version, app.getVersion())) return;
  if (promptedVersion === version) return;
  if (readPrefs().skipVersion === version) return;
  promptedVersion = version;

  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    title: 'Update available',
    message: `Solar Slinger v${version} is out (you have v${app.getVersion()}).`,
    detail: 'This build can’t update itself in place, so it’s a quick manual download.',
    buttons: ['Open download page', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(latest.html_url || RELEASES_URL);
  else if (response === 2) writePrefs({ ...readPrefs(), skipVersion: version });
}

// ---------------------------------------------------------------- entry

function initUpdater(browserWindow) {
  win = browserWindow;
  // Dev runs (npm start, ELECTRON_START_URL) are not installs — nothing to
  // update, and a stray "update available" dialog mid-iteration is noise.
  if (!app.isPackaged) return;

  const fullAuto = process.platform === 'win32' ||
    (process.platform === 'linux' && !!process.env.APPIMAGE);
  if (fullAuto) {
    initFullUpdater();
  } else {
    setTimeout(() => { checkAndNotify(); }, FIRST_CHECK_MS);
    setInterval(() => { checkAndNotify(); }, RECHECK_MS);
  }
}

module.exports = { initUpdater };
