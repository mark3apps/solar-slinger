// Renders icon.html's canvas to a PNG file via a hidden Electron window.
// Usage: electron render-icon.js <icon.html> <out.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const [htmlPath, outPath] = process.argv.slice(2);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1100,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(htmlPath);
  const dataUrl = await win.webContents.executeJavaScript('window.renderIcon()');
  fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', outPath);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
