'use strict';
const fs = require('fs');
const path = require('path');
const nativeAsset = /\.(dll|exe|asi|addon(?:32|64)?|zip|7z|bin|onnx|safetensors|pt|pth)$/i;
function checkRelease(root = path.resolve(__dirname, '..'), config = require('../package.json').build) {
  if (config.extraResources?.length || config.extraFiles?.length) {
    throw new Error('Community releases must not bundle unreviewed runtime resources.');
  }
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release input contains a link: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (nativeAsset.test(entry.name)) throw new Error(`Unreviewed runtime/model/archive in release input: ${full}`);
    }
  }
  for (const dir of ['src', 'assets']) walk(path.join(root, dir));
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!fs.existsSync(path.join(root, notice))) throw new Error(`Missing ${notice}`);
  }
}
module.exports = async context => checkRelease(context?.packager?.projectDir, context?.packager?.config);
module.exports.checkRelease = checkRelease;
if (require.main === module) {
  try { checkRelease(); console.log('Release inputs checked: no bundled third-party runtimes.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
