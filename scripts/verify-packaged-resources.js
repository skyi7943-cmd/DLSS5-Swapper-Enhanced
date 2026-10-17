'use strict';
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
function verifyPackagedResources(appOutDir) {
  const resources = path.join(appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
  const forbidden = files.filter(file => /\.(dll|exe|asi|addon(?:32|64)?|zip|7z|bin|onnx|safetensors|pt|pth)$/i.test(file));
  if (forbidden.length) throw new Error(`Unreviewed packaged runtimes: ${forbidden.join(', ')}`);
  const copyright = asar.extractFile(archive, 'LICENSE').toString();
  if (!copyright.includes('Copyright (c) 2026 Rakan Alkhaldi')) throw new Error('Original MIT copyright missing from package');
  if (!files.includes('/THIRD_PARTY_NOTICES.md')) throw new Error('Third party notices missing from package');
  for (const name of ['payload', 'addons', 'overlay', 'app.asar.unpacked']) {
    if (fs.existsSync(path.join(resources, name))) throw new Error(`Unreviewed extra resources: ${name}`);
  }
  return { asarEntries: files.length, thirdPartyGameRuntimes: 0, originalMitCopyrightRetained: true };
}
module.exports = async context => { console.log('Packaged resources verified:', verifyPackagedResources(context.appOutDir)); };
module.exports.verifyPackagedResources = verifyPackagedResources;
if (require.main === module) console.log(verifyPackagedResources(process.argv[2] || path.resolve(__dirname, '../dist/win-unpacked')));
