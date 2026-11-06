'use strict';
// Genera el ejecutable/instalador de Windows: pruebas -> electron-builder (NSIS + portable) en dist/
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd, args) => {
  console.log('\n> ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error('Falló: ' + cmd + ' ' + args.join(' ')); process.exit(r.status || 1); }
};
run('npm', ['test']);
run('npx', ['electron-builder', '--win', '--x64']);
console.log('\nListo. Instalador y portable en: ' + path.join(root, 'dist'));
