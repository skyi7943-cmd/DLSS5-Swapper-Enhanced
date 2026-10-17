'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectHardwareEnvironment, parseGpuRows, LAPTOP_1080P_PROFILE } = require('../src/core/hardware-environment');
const combined = require('../src/core/combined-manager');
const mfg = require('../src/core/mfg-manager');
const neural = require('../src/core/neural-models');
const { CommunityClient } = require('../src/community-client');
const { checkRelease } = require('../scripts/release-guard');
const { importPayload } = require('../scripts/collect-payload');
const { writePe } = require('./fixtures/pe');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyi-fork-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('failed or malformed hardware detection stays unknown, including after a successful query', async () => {
  for (const run of [async () => { throw Error('not installed'); }, async () => '', async () => 'invalid,data']) {
    const hw = await detectHardwareEnvironment(true, { run });
    assert.equal(hw.gpu.name, 'Unknown GPU');
    for (const key of ['driver', 'vramTotalMB', 'vramUsedMB', 'vramFreeMB', 'powerDefaultW', 'powerMaxW']) assert.equal(hw.gpu[key], null);
    assert.equal(hw.display.refreshRateHz, null);
    assert.equal(hw.detection.source, 'unavailable');
    assert.equal(mfg.evaluateMfgGpuSupport(hw.gpu.name).nativeX2, false);
  }
});
test('GPU CSV preserves unknown fields and zero usage and exposes multiple adapters', async () => {
  const output = 'NVIDIA GeForce RTX 4070 Laptop GPU, 617.42, 8188, 0, 8188, N/A, [Not Supported]\nNVIDIA GeForce RTX 5090, 617.42, 32768, 123, 32645, 450, 600';
  const rows = parseGpuRows(output);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].vramUsedMB, 0);
  assert.equal(rows[0].powerMaxW, null);
  assert.equal(rows[1].vramTotalMB, 32768);
  const hw = await detectHardwareEnvironment(true, { run: async () => output });
  assert.equal(hw.gpus.length, 2);
  assert.match(hw.detection.adapterSelection, /not confirmed/);
  const failed = await detectHardwareEnvironment(true, { run: async () => { throw Error('lost device'); } });
  assert.equal(failed.gpu.vramTotalMB, null);
});
test('165Hz profile is a suggestion and VRAM heuristics cannot validate safety', () => {
  assert.equal(LAPTOP_1080P_PROFILE.refreshRateHz, 165);
  assert.equal(LAPTOP_1080P_PROFILE.neuralMode, 'off');
  assert.equal(LAPTOP_1080P_PROFILE.mfgMode, 'x2');
  const unknown = combined.estimateVramBudget();
  assert.equal(unknown.isEstimate, true);
  assert.equal(unknown.headroomMB, null);
  assert.equal(unknown.usagePercent, null);
  assert.equal(unknown.level, 'unknown');
  const high = combined.estimateVramBudget({ neuralMode: 'legacy', mfgMode: 'x4', vramTotalMB: 6000 });
  assert.ok(high.usagePercent > 100);
  assert.equal(high.level, 'critical');
  assert.match(high.summary, /估算，非测量/);
  assert.equal(combined.estimateVramBudget({ resolution: '3840x2160', vramTotalMB: 8192 }).level, 'unknown');
});
test('known NR model hash / SM coverage does not verify game execution', () => {
  const model = neural.MODEL_DATABASE.find(model => model.id === '310.8.SF-v2');
  assert.equal(neural.evaluateModelGpuCompatibility(model).status, 'untested');
  assert.equal(neural.evaluateModelGpuCompatibility(model, 'NVIDIA GeForce RTX 4070 Laptop GPU').status, 'experimental');
  assert.notEqual(mfg.evaluateMfgGpuSupport('NVIDIA GeForce RTX 5090').modeBadges.x4.status, 'verified');
});
test('enhanced panels render unknown hardware, all seven checks, and Off drafts without fabricated verification', () => {
  const vm = require('vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/renderer/enhanced-ui.js'), 'utf8'), { window });
  const html = window.enhancedUi.buildThreePanelsHtml('C:/fixture', { neural: {}, mfg: {}, diagnostics: {
    coExecution: { vramBudget: combined.estimateVramBudget() }
  } }, {});
  for (const label of ['Neural Rendering Manager', 'Multi Frame Generation Manager', 'Compatibility & Diagnostics',
    '1. 模块 DLL', '2. Streamline', '3. 运动矢量', '4. HUD', '5. RTX', '6. Reflex', '7. 游戏退出']) assert.ok(html.includes(label), label);
  assert.match(html, /Neural: OFF \+ MFG: OFF/);
  assert.match(html, /未知 GPU/);
  assert.match(html, /估算，非安全验证/);
  assert.doesNotMatch(html, /8188|sm_89|已验证生效|RTX 4070 Laptop GPU/);
  assert.match(window.enhancedUi.renderStatusBadge('untested', '已验证可用'), /enh-badge-untested/);
});

function telemetry(t, overrides = {}) {
  const dir = fixture(t), now = Date.now();
  const data = { pid: 100, processBirth: '123456', heartbeat: Math.floor(now / 1000),
    applied: true, appliedMultiplier: 4, actualFramesPresented: 480,
    providerVerified: true, appliedFrameGenerationOn: true, setOptionsAccepted: true,
    getStateSeen: true, getStateResult: 0, activeFrameGeneration: 'dlssg', ...overrides };
  fs.writeFileSync(path.join(dir, 'RTXMFG-Universal.status.json'), JSON.stringify(data));
  return { dir, now, verify: options => mfg.verifyMfgRuntimeStatus(dir, dir, {
    now, expectedMultiplier: 4, isCurrentSession: () => true, ...options
  }) };
}
test('matching current-session presentation telemetry verifies the selected mode without claiming FPS', t => {
  const f = telemetry(t);
  const result = f.verify();
  assert.equal(result.verifiedActive, true);
  assert.equal(result.effectiveMultiplier, 4);
  assert.equal(result.fpsVerified, false);
});
test('negative, stale, dead, mismatched, pending and non-presenting telemetry fails closed', t => {
  for (const override of [{ applied: false }, { applied: 'true' }, { actualFramesPresented: 0 },
    { appliedMultiplier: 3 }, { pending: true }, { restartRequired: true }, { providerVerified: false },
    { getStateResult: 21 }, { setOptionsAccepted: false }, { activeFrameGeneration: 'none' },
    { heartbeat: 1 }, { heartbeat: Math.floor(Date.now() / 1000) + 120 }, { error: 'patch failed' }]) {
    const f = telemetry(t, override);
    assert.equal(f.verify().verifiedActive, false, JSON.stringify(override));
    assert.equal(f.verify().effectiveMultiplier, null);
  }
  const f = telemetry(t);
  assert.equal(f.verify({ isCurrentSession: () => false }).verifiedActive, false);
  assert.equal(f.verify({ expectedMultiplier: 1 }).verifiedActive, false);
  assert.equal(f.verify({ configuredAt: new Date(f.now + 10000).toISOString() }).verifiedActive, false);
  assert.equal(f.verify({ configuredAt: 'invalid' }).verifiedActive, false);
  fs.utimesSync(path.join(f.dir, 'RTXMFG-Universal.status.json'), new Date(0), new Date(0));
  assert.equal(f.verify().verifiedActive, false);
});
test('success text logs cannot override a negative JSON snapshot or combine unrelated evidence', t => {
  const f = telemetry(t, { applied: false });
  fs.writeFileSync(path.join(f.dir, 'ReShade.log'), 'verified mapped DLSS-G provider\ntemporal fix applied\neffective multiplier: 4x, presented frames: 480');
  assert.equal(f.verify().verifiedActive, false);
  fs.writeFileSync(path.join(f.dir, 'RTXMFG-Universal.status.json'), '{broken');
  assert.equal(f.verify().verifiedActive, false);
  fs.unlinkSync(path.join(f.dir, 'RTXMFG-Universal.status.json'));
  assert.equal(f.verify().verifiedActive, false);
});
test('public 007 x4 snapshot is not verified even if treated as fresh and live', t => {
  const original = require('../test-results/real-game/mode_x4/RTXMFG-Universal.status.json');
  assert.equal(original.applied, false);
  const f = telemetry(t, { ...original, heartbeat: Math.floor(Date.now() / 1000) });
  assert.equal(f.verify().verifiedActive, false);
  assert.equal(f.verify().effectiveMultiplier, null);
});
test('inspect with an unknown GPU and x4 configured cannot label x4 as effective', async t => {
  const dir = fixture(t);
  writePe(path.join(dir, 'game.exe'), { text: 'D3D12CreateDevice\0' });
  fs.writeFileSync(path.join(dir, 'renodx-mfgunlock.addon64'), 'fixture, not executable');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[RenoDX.MFGUnlock]\nEnabled=1\nForceMultiplier=4\n');
  fs.copyFileSync(path.resolve(__dirname, '../test-results/real-game/mode_x4/RTXMFG-Universal.status.json'), path.join(dir, 'RTXMFG-Universal.status.json'));
  const result = await mfg.inspectGameMfgStatus(dir);
  assert.notEqual(result.status, 'verified');
  assert.doesNotMatch(result.effectiveMultiplier, /已验证生效/);
  assert.equal(result.currentConfig.multiplier, 4);
});
test('unconfigured community performs no network calls', async t => {
  let calls = 0;
  const client = new CommunityClient({ file: path.join(fixture(t), 'community.json'), fetchImpl: async () => { calls++; } });
  await assert.rejects(client.request('GET', '/v1/cards'), { code: 'community_disabled' });
  assert.equal(calls, 0);
});
test('release guard rejects resource bundles and executable/model assets', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'LICENSE'), 'notice');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'notice');
  checkRelease(root, {});
  assert.throws(() => checkRelease(root, { extraResources: [{ from: 'payload' }] }), /must not bundle/);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'nvngx_dlssnr.dll'), 'fixture');
  assert.throws(() => checkRelease(root, {}), /Unreviewed/);
});
test('explicit private import preserves files and notices without staging release payload', t => {
  const root = fixture(t), src = path.join(root, 'source'), dest = path.join(root, 'private');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'LICENSE.txt'), 'original notice');
  assert.equal(importPayload(src, dest), dest);
  assert.equal(fs.readFileSync(path.join(dest, 'LICENSE.txt'), 'utf8'), 'original notice');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'LOCAL-IMPORT.json'))).privateLocalUse, true);
  assert.throws(() => importPayload(src, dest), /exists/);
  assert.throws(() => importPayload(src, path.join(src, 'nested')), /outside/);
  assert.throws(() => importPayload(src, path.resolve(__dirname, '../payload')), /outside/);
});
