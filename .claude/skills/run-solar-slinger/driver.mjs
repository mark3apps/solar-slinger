#!/usr/bin/env electron
// Solar Slinger driver — launch the real game and drive it programmatically.
//
// Run it with the project's own Electron (a devDependency), NOT with node:
//   npx electron .claude/skills/run-solar-slinger/driver.mjs <<'EOF'
//   eval window.freshRun(0)
//   shot shots/run.png
//   EOF
//
// Why Electron and not a browser: the shipping shell (electron/main.js) serves
// the repo over a privileged app:// scheme because Chromium refuses ES modules
// over file://. Re-registering that scheme here means the driver needs NO dev
// server and no port — it reads the working tree straight off disk, so an edit
// is live on the next launch.
//
// Why screenshots work with a hidden window: a hidden/occluded window has its
// rAF loop throttled to nothing, but the game exposes window.tick(seconds),
// which advances the fixed-step sim AND renders one frame regardless. So the
// capture path is always "tick, then shot" — never "wait and hope".
import { app, BrowserWindow, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2).filter((a) => a !== '.');
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

// Default root: three levels up from .claude/skills/run-solar-slinger/.
let ROOT = path.resolve(opt('root', path.join(HERE, '..', '..', '..')));
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`ERROR: no index.html under ${ROOT} — pass --root <repo>`);
  process.exit(2);
}

const SHOW = flag('show');
const AUDIO = flag('audio');
const [W, H] = (opt('size', '1440x900')).split('x').map(Number);
const START_URL = opt('url', 'app://game/index.html');
const inlineCmds = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-c' || argv[i] === '--cmd') inlineCmds.push(argv[++i]);
}

// Same privileged scheme the real shell registers. `stream` is what lets the
// <audio> music beds play over app://; keep it even when muted, or a missing
// privilege changes how the page loads.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ------------------------------------------------------------- helpers ----
const out = (s) => process.stdout.write(s + '\n');
let failed = 0;
const consoleLog = [];

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}

// Split "cmd rest of line" — commands take the remainder verbatim so that
// `eval` can carry arbitrary JS (braces, quotes, semicolons) without escaping.
function parse(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const sp = t.indexOf(' ');
  return sp === -1 ? [t, ''] : [t.slice(0, sp), t.slice(sp + 1).trim()];
}

async function run(win, cmd, rest) {
  const wc = win.webContents;
  switch (cmd) {
    case 'wait':
    case 'sleep':
      await new Promise((r) => setTimeout(r, Number(rest) || 0));
      return;

    case 'waitfor': {
      // Poll a JS expression until truthy. The game boots async (module graph
      // + worker), so every session should start with a waitfor on window.game.
      const [expr, ms] = [rest.replace(/\s+\d+$/, ''), Number(rest.match(/\s+(\d+)$/)?.[1]) || 30000];
      const t0 = Date.now();
      for (;;) {
        let ok = false;
        try { ok = await wc.executeJavaScript(`!!(${expr})`, true); } catch { /* still loading */ }
        if (ok) { out(`waitfor: ${expr} -> true (${Date.now() - t0}ms)`); return; }
        if (Date.now() - t0 > ms) throw new Error(`waitfor timed out after ${ms}ms: ${expr}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    case 'eval': {
      // Wrapped so the page can hand back structured data; anything
      // non-serializable degrades to a string instead of throwing.
      const v = await wc.executeJavaScript(
        `(async () => { const __v = await (${rest}); try { return JSON.parse(JSON.stringify(__v)); } catch { return String(__v); } })()`,
        true,
      );
      out(JSON.stringify(v ?? null));
      return;
    }

    case 'script': {
      // `eval` takes the rest of ONE line, so anything with real structure has
      // to live in a file. Usage: script <path> [jsonArgs]
      // The file's body runs as an async IIFE; whatever it returns is printed
      // as JSON, and `ARGS` holds the parsed second argument.
      // Split on the JSON, NOT on the first space — this repo lives at
      // "…/Solar system/…" and splitting on whitespace truncated every path at
      // "Solar", so every suite failed with ENOENT on a directory that half
      // exists. Args always begin with `{`, so that is the reliable delimiter.
      // A quoted path is honoured too, for paths containing a literal " {".
      let file, args = 'null';
      if (rest.startsWith('"') || rest.startsWith("'")) {
        const q = rest[0], end = rest.indexOf(q, 1);
        file = rest.slice(1, end);
        args = rest.slice(end + 1).trim() || 'null';
      } else {
        const j = rest.indexOf(' {');
        file = (j === -1 ? rest : rest.slice(0, j)).trim();
        args = j === -1 ? 'null' : rest.slice(j + 1).trim();
      }
      const src = fs.readFileSync(path.resolve(file), 'utf8');
      const v = await wc.executeJavaScript(
        `(async () => { globalThis.ARGS = ${args};
           const __v = await (async () => {\n${src}\n})();
           try { return JSON.parse(JSON.stringify(__v)); } catch { return String(__v); } })()`,
        true,
      );
      out(JSON.stringify(v ?? null));
      return;
    }

    case 'shot': {
      const p = path.resolve(rest || 'shot.png');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const img = await wc.capturePage();
      fs.writeFileSync(p, img.toPNG());
      const { width, height } = img.getSize();
      out(`shot: ${p} (${width}x${height})`);
      return;
    }

    case 'move': {
      const [x, y] = rest.split(/\s+/).map(Number);
      // The ship's nose tracks the cursor, so a move IS a control input.
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      return;
    }

    case 'click': {
      const [x, y] = rest.split(/\s+/).map(Number);
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 30));
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return;
    }

    case 'key': {
      const [code, mode = 'press'] = rest.split(/\s+/);
      if (mode !== 'up') { wc.sendInputEvent({ type: 'keyDown', keyCode: code }); wc.sendInputEvent({ type: 'char', keyCode: code }); }
      if (mode !== 'down') wc.sendInputEvent({ type: 'keyUp', keyCode: code });
      return;
    }

    case 'type':
      for (const ch of rest) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        await new Promise((r) => setTimeout(r, 8));
      }
      return;

    case 'goto':
      await wc.loadURL(rest);
      return;

    case 'reload':
      wc.reload();
      await new Promise((r) => wc.once('did-finish-load', r));
      return;

    case 'console':
      out(consoleLog.length ? consoleLog.join('\n') : '(no console output)');
      return;

    case 'clearconsole':
      consoleLog.length = 0;
      return;

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

// ---------------------------------------------------------------- main ----
app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: W,
    height: H,
    show: SHOW,
    backgroundColor: '#04050a',
    autoHideMenuBar: true,
    // paintWhenInitiallyHidden keeps the compositor alive for capturePage on a
    // window that is never shown; backgroundThrottling:false stops Chromium
    // from parking timers when the window is not frontmost.
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: flag('offscreen') },
  });
  // Muted by default: this driver is usually run on a developer's own machine
  // and 24 music beds firing out of a hidden window is a genuinely bad time.
  if (!AUDIO) win.webContents.setAudioMuted(true);

  // Electron 43 passes a single event object; the old positional signature is
  // deprecated and prints a warning on every launch.
  win.webContents.on('console-message', (e) => {
    consoleLog.push(`[${e.level}] ${e.message}${e.sourceId ? ` (${e.sourceId}:${e.lineNumber})` : ''}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.error(`ERROR: renderer gone: ${d.reason}`); failed++; });

  await win.loadURL(START_URL);

  const stdinText = await readStdin();
  const lines = [...stdinText.split('\n'), ...inlineCmds];
  const cmds = lines.map(parse).filter(Boolean);
  if (!cmds.length) {
    out('no commands given — pipe them on stdin or pass -c "<cmd>". Commands:');
    out('  waitfor <expr> [ms] | wait <ms> | eval <js> | shot <path>');
    out('  move <x> <y> | click <x> <y> | key <code> [down|up] | type <text>');
    out('  goto <url> | reload | console | clearconsole');
  }

  for (const [cmd, rest] of cmds) {
    try {
      await run(win, cmd, rest);
    } catch (e) {
      console.error(`ERROR [${cmd} ${rest}]: ${e.message}`);
      failed++;
      break;
    }
  }

  if (failed) console.error(`\n${failed} command(s) failed`);
  app.exit(failed ? 1 : 0);
});

app.on('window-all-closed', () => app.quit());
