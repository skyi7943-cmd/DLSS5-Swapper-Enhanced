'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

// The update lookup runs in the main process against the real GitHub endpoint.
// Here the network is a stub, so the test is about what the app concludes.
function load(t, { version = '2.2.1', fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.resolve(__dirname, '../main.js');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const calls = { count: 0 };
  const stubs = {
    electron: {
      app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => root, getVersion: () => version },
      BrowserWindow: { fromWebContents: () => null },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      clipboard: { writeText() {} }
    },
    './src/core/scan.js': { scanGame: async () => ({ chosen: null, exeCandidates: [] }), scanSource: () => ({ ok: false }) }
  };
  const context = vm.createContext({
    require: name => stubs[name] || realRequire(name),
    __dirname: path.dirname(main), process, Buffer, console, setTimeout, clearTimeout,
    AbortSignal,
    fetch: async (...args) => { calls.count++; return fetchImpl(...args); }
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  return { handlers, calls };
}

const release = (tag) => ({ ok: true, json: async () => ({ tag_name: tag }) });

test('development and packaged builds never query the former author update service', async t => {
  const { handlers, calls } = load(t, { fetchImpl: async () => { throw Error('network must not run'); } });
  const first = await handlers.get('update-check')();
  const second = await handlers.get('update-check')();
  assert.equal(first.disabled, true);
  assert.equal(first.newer, false);
  assert.equal(first.current, '2.2.1');
  assert.match(first.url, /skyi7943-cmd\/DLSS5-Swapper-Enhanced/);
  assert.deepEqual(first, second);
  assert.equal(calls.count, 0);
});

test('being offline, rate-limited or blocked says nothing at all', async (t) => {
  for (const fetchImpl of [
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: true, json: async () => ({}) })
  ]) {
    const { handlers } = load(t, { fetchImpl });
    const answer = await handlers.get('update-check')();
    assert.equal(answer.newer, false, 'no notice is shown');
    assert.equal(answer.current, '2.2.1', 'and the running version is still reported');
  }
});

// A lookup that could not run reported {latest: null, newer: false}, which the
// sidebar rendered exactly like "nothing new". Someone on an old build whose
// check never completed was told nothing and had no reason to go and look.
test('a failed lookup is distinguishable from being up to date', () => {
  const failed = { current: '2.2.2', latest: null, newer: false };
  const current = { current: '2.2.3', latest: '2.2.3', newer: false };
  const behind = { current: '2.2.2', latest: '2.2.3', newer: true };

  // Exactly the branch order src/renderer/renderer.js uses.
  const shown = (a) => !a ? 'nothing' : !a.latest ? 'failed' : !a.newer ? 'nothing' : 'update';
  assert.equal(shown(failed), 'failed');
  assert.equal(shown(current), 'nothing');
  assert.equal(shown(behind), 'update');

  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  assert.match(renderer, /if \(!answer\.latest\) \{[\s\S]*updateCheckFailed/,
    'the renderer separates the two before it decides there is no news');
});
