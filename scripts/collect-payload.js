'use strict';
// Private local import only: no downloads, implicit searches or release staging.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
function importPayload(source, destination) {
  if (!source || !destination) throw new Error('Usage: npm run payload -- <source-folder> <private-destination-outside-repository>');
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const src = fs.realpathSync(path.resolve(source)), dest = path.resolve(destination);
  const parent = fs.realpathSync(path.dirname(dest));
  const actualDest = fs.existsSync(dest) ? fs.realpathSync(dest) : path.join(parent, path.basename(dest));
  const inside = (base, candidate) => {
    const rel = path.relative(base, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(root, actualDest) || inside(src, actualDest) || inside(actualDest, src)) throw new Error('Private destination must be outside the repository and separate from source.');
  if (fs.existsSync(actualDest)) throw new Error('Destination exists; use a new private folder to avoid mixed versions.');
  const files = [];
  function walk(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Linked files are not accepted.');
      const next = path.join(rel, entry.name), full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, next);
      else if (entry.isFile()) files.push({ full, rel: next });
    }
  }
  walk(src);
  fs.mkdirSync(actualDest);
  const inventory = [];
  for (const file of files) {
    const target = path.join(actualDest, file.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.full, target);
    inventory.push({ path: file.rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
  }
  fs.writeFileSync(path.join(actualDest, 'LOCAL-IMPORT.json'), JSON.stringify({privateLocalUse:true, importedAt:new Date().toISOString(), source:src,
    notice:'User supplied files. Import and hashes do not establish licensing rights, authenticity or GPU compatibility.', files:inventory}, null, 2));
  return actualDest;
}
if (require.main === module) {
  try { console.log('Private import ready: ' + importPayload(process.argv[2], process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { importPayload };
