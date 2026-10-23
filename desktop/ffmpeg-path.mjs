// Native executables cannot be spawned from inside an ASAR archive: Electron's
// fs reports the packed copy as accessible, but spawn fails with ENOTDIR. Only
// the unpacked copy is a real file, so never offer the packed path.
export function spawnableBundledPath(bundled) {
  return String(bundled || '').trim().replace(/\.asar([\\/])/i, '.asar.unpacked$1');
}
