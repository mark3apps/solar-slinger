// Electron shell for Solar Slinger.
// The game is plain ES modules with no build step; browsers (and Chromium's
// file:// origin rules) refuse to load module scripts over file://, so we
// serve the repo files over a privileged app:// scheme instead of loadFile.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { initUpdater } = require('./updater');

const ROOT = path.join(__dirname, '..');

protocol.registerSchemesAsPrivileged([
  // `stream` lets <audio>/<video> elements stream media (the music beds) over app://.
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#04050a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep any external links out of the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // ELECTRON_START_URL lets you point the shell at the live dev server
  // (python3 serve.py → http://localhost:8642) for hot-ish iteration.
  const startUrl = process.env.ELECTRON_START_URL || 'app://game/index.html';
  win.loadURL(startUrl);
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  // Auto-update (electron/updater.js): a no-op in dev; on packaged builds
  // Windows self-updates on quit, mac/linux get a check-and-notify dialog.
  initUpdater(createWindow());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
