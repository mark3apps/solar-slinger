// electron-builder afterPack hook: ad-hoc sign the mac app bundle.
//
// CI has no Apple signing certificate, so electron-builder skips signing and the
// packaged app keeps Electron's original linker signature (Identifier=Electron, no
// resource seal). Rebranding the bundle invalidates that seal, and Apple Silicon
// refuses to launch apps with an invalid signature — Gatekeeper reports the DMG as
// "damaged" with no right-click-Open bypass. A fresh ad-hoc signature over the whole
// bundle makes the app launchable (users still clear quarantine, see release notes).
//
// afterPack runs before electron-builder's own sign step, so if a real Developer ID
// identity is ever configured this ad-hoc signature is simply overwritten.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
