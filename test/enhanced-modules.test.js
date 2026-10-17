'use strict';
// 增强模块 (模块 A: 神经渲染模型管理 / 模块 B: RTX 40 x3/x4 多帧生成 / 模块 C: 联合运行与诊断) 自动化测试套件

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const neuralModels = require('../src/core/neural-models');
const mfgManager = require('../src/core/mfg-manager');
const combinedManager = require('../src/core/combined-manager');
const backends = require('../src/core/backend-manager');
const ini = require('../src/core/feeder-config');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DIR = path.join(ROOT, 'payload');

test('模块 A：真实 nvngx_dlssnr.dll CUDA Fatbin 架构扫描与 RTX 4070 Laptop (sm_89) 兼容性校验', () => {
  const nrPath = path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlssnr.dll');
  const info = neuralModels.inspectNeuralModelBinary(nrPath);
  assert.equal(info.valid, true);
  assert.equal(info.isNeuralRendering, true);
  assert.equal(info.kind, 'dlss_nr');
  assert.equal(info.bitness, 64);
  assert.equal(info.version, '310.8.0.0');
  assert.equal(info.sha256, '8270b350cd82de5ce89806872cdd6b6a9249b80836b91bbeb3573470744cc206');
  assert.deepEqual(info.architectures, ['75', '86', '89', '120']);
  assert.equal(info.smCounts['89'], 15);
  assert.equal(info.modelId, '310.8.SF-v2');

  // RTX 4070 Laptop (sm_89) 应评估为已验证可用
  const compat4070 = neuralModels.evaluateModelGpuCompatibility(info, 'NVIDIA GeForce RTX 4070 Laptop GPU');
  assert.equal(compat4070.compatible, true);
  assert.equal(compat4070.status, 'verified');
  assert.equal(compat4070.badge, '已验证可用');

  // 仅包含 sm_120 的模型 (310.8.Lecram / 310.9.16 原厂版) 在 RTX 4070 Laptop 上应明确标记为不兼容
  const lecram = neuralModels.MODEL_DATABASE.find((m) => m.id === '310.8.Lecram');
  const compatLecram = neuralModels.evaluateModelGpuCompatibility(lecram, 'NVIDIA GeForce RTX 4070 Laptop GPU');
  assert.equal(compatLecram.compatible, false);
  assert.equal(compatLecram.status, 'incompatible');
  assert.equal(compatLecram.badge, '不兼容');
  assert.match(compatLecram.reason, /0xbad00001/);
});

test('模块 A：严格拒绝将传统 DLSS SR / RR / FG 改名冒充 DLSS 5 神经渲染模型', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-nr-reject-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 将传统 Super Resolution (nvngx_dlss.dll) 改名为 nvngx_dlssnr.dll 测试识别器
  const fakeFromSr = path.join(tmpDir, 'nvngx_dlssnr.dll');
  fs.copyFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll'), fakeFromSr);
  const srCheck = neuralModels.inspectNeuralModelBinary(fakeFromSr);
  assert.equal(srCheck.valid, false);
  assert.equal(srCheck.kind, 'dlss_sr');
  assert.throws(
    () => neuralModels.importNeuralModel(fakeFromSr, tmpDir),
    { code: 'errNotNeuralRenderingModel' }
  );

  // 将 Frame Generation (nvngx_dlssg.dll) 改名为 nvngx_dlssnr.dll 测试识别器
  const fakeFromFg = path.join(tmpDir, 'fake_fg_as_nr.dll');
  fs.copyFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlssg.dll'), fakeFromFg);
  const fgCheck = neuralModels.inspectNeuralModelBinary(fakeFromFg);
  assert.equal(fgCheck.valid, false);
  assert.equal(fgCheck.kind, 'dlss_fg');
  assert.throws(
    () => neuralModels.importNeuralModel(fakeFromFg, tmpDir),
    { code: 'errNotNeuralRenderingModel' }
  );
});

test('模块 B：RTX 4070 Laptop MFG 能力检测、严禁未验证提前标为已支持、以及 dlssg-to-fsr3 伪装拦截', (t) => {
  const gpuSupport = mfgManager.evaluateMfgGpuSupport('NVIDIA GeForce RTX 4070 Laptop GPU', '617.42');
  assert.equal(gpuSupport.architecture.code, 'ada');
  assert.equal(gpuSupport.architecture.sm, '89');
  assert.equal(gpuSupport.nativeX2, true);
  assert.equal(gpuSupport.nativeX3X4, false);
  assert.equal(gpuSupport.unlockRequiredForX3X4, true);
  // x3 / x4 在未经运行时验证前必须是 experimental 而非 verified
  assert.equal(gpuSupport.modeBadges.x3.status, 'experimental');
  assert.equal(gpuSupport.modeBadges.x4.status, 'experimental');

  // 检验正版 310.9.16 与 310.9.1 nvngx_dlssg.dll
  const dlssg310_9_16 = path.join(PAYLOAD_DIR, 'enhanced', 'streamline-2.14.16', 'nvngx_dlssg.dll');
  const check16 = mfgManager.inspectDlssgBinary(dlssg310_9_16);
  assert.equal(check16.valid, true);
  assert.equal(check16.version, '310.9.16.0');
  assert.equal(check16.supportsMfgX3X4, true);

  // 伪造 dlssg_to_fsr3 替换文件，必须被识别为伪装包装器并拦截
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-fake-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const fakeDlssg = path.join(tmpDir, 'nvngx_dlssg.dll');
  fs.writeFileSync(fakeDlssg, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1024), Buffer.from('dlssg_to_fsr3_amd_is_better')]));
  const fakeCheck = mfgManager.inspectDlssgBinary(fakeDlssg);
  assert.equal(fakeCheck.valid, false);
  assert.equal(fakeCheck.isFakeWrapper, true);
});

test('模块 C：模拟 64位 DX12 游戏从模式 A 到 F 的完整配置、双插件协同、运行时日志验证与一键无损还原', async (t) => {
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-enhanced-e2e-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-userdata-'));
  t.after(() => {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // 构造一个带真实 64位 PE 头与 D3D12CreateDevice 标识的受控单机测试程序及原始 nvngx_dlss.dll
  const hostExeSrc = path.join(PAYLOAD_DIR, 'feeder', 'dlss5-feed-host64.exe');
  const exePath = path.join(gameDir, 'GameDX12.exe');
  const exeBytes = Buffer.concat([fs.readFileSync(hostExeSrc), Buffer.from('\0D3D12CreateDevice\0')]);
  fs.writeFileSync(exePath, exeBytes);

  const origDlssPath = path.join(gameDir, 'nvngx_dlss.dll');
  const origDlssBytes = fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll'));
  fs.writeFileSync(origDlssPath, origDlssBytes);

  // 模式 A：初始未启用状态检查
  const statusA = await combinedManager.inspectCombinedStatus(gameDir, { payloadDir: PAYLOAD_DIR, userDataDir });
  assert.equal(statusA.ok, true);
  assert.equal(statusA.neural.mode, 'off');
  assert.equal(statusA.mfg.currentConfig.mode, 'off');
  assert.equal(statusA.diagnostics.combinedStatus, 'untested');

  // 模式 B：仅开启标准 NVIDIA FG x2
  const resB = await combinedManager.applyCombinedConfiguration(gameDir, {
    neuralMode: 'off',
    mfgMode: 'x2',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resB.ok, true);
  assert.equal(resB.status.mfg.currentConfig.mode, 'x2');
  assert.equal(resB.status.mfg.currentConfig.multiplier, 2);

  // 模式 C & E：同时开启 DLSS 5 (Latest Compatible Model 310.8.SF-v2) + NVIDIA MFG x3
  const resE = await combinedManager.applyCombinedConfiguration(gameDir, {
    neuralMode: 'latest_compatible',
    mfgMode: 'x3',
    runtimeStack: 'oct2026-310.9.16',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resE.ok, true);
  assert.equal(resE.status.neural.mode, 'latest_compatible');
  assert.equal(resE.status.neural.currentModel.id, '310.8.SF-v2');
  assert.equal(resE.status.mfg.currentConfig.mode, 'x3');
  assert.equal(resE.status.mfg.currentConfig.multiplier, 3);
  // 此时尚未产生游戏运行时遥测日志，MFG x3 状态必须为 experimental 而非 verified
  assert.equal(resE.status.mfg.status, 'experimental');
  assert.equal(resE.status.mfg.statusBadge, '实验性支持');

  // 验证 ReShade.ini 中 RuntimeSelectionMode=1 已自动开启，避免双插件 NGX 上下文冲突
  const reshadeIniText = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8');
  assert.equal(ini.getIni(reshadeIniText, 'RenoDX.MFGUnlock', 'ForceMultiplier'), '3');
  assert.equal(ini.getIni(reshadeIniText, 'RenoDX.MFGUnlock', 'TemporalFix'), '1');
  assert.equal(ini.getIni(reshadeIniText, 'RenoDX.MFGUnlock', 'RuntimeSelectionMode'), '1');
  assert.equal(resE.status.diagnostics.coExecution.slChainCheck.ok, true);

  // 模式 F：切换至 DLSS 5 + MFG x4 并模拟真实运行时日志写回，测试运行时生效验证
  await combinedManager.applyCombinedConfiguration(gameDir, {
    neuralMode: 'latest_compatible',
    mfgMode: 'x4',
    runtimeStack: 'oct2026-310.9.16',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  fs.writeFileSync(path.join(gameDir, 'ReShade.log'), [
    '16:45:01.100 [INFO] [RenoDX.MFGUnlock] verified mapped DLSS-G provider 310.9.16.0',
    '16:45:01.112 [INFO] [RenoDX.MFGUnlock] PopulateParameters 0x1B0 patch applied',
    '16:45:01.125 [INFO] [RenoDX.MFGUnlock] Blackwell framework-kernel path active, temporal fix applied',
    '16:45:02.500 [INFO] [RenoDX.MFGUnlock] slDLSSGGetState: requested multiplier: 4x, effective multiplier: 4x, presented frames: 480'
  ].join('\n'), 'utf8');

  const statusF = await combinedManager.inspectCombinedStatus(gameDir, { payloadDir: PAYLOAD_DIR, userDataDir });
  assert.equal(statusF.mfg.runtimeVerification.verifiedActive, true);
  assert.equal(statusF.mfg.runtimeVerification.effectiveMultiplier, 4);
  assert.equal(statusF.mfg.status, 'verified');
  assert.equal(statusF.mfg.statusBadge, '已验证可用');
  assert.equal(statusF.diagnostics.combinedBadge, '已验证可用');
  assert.equal(statusF.diagnostics.coExecution.vramBudget.totalAddedOverheadMB, 680 + 660);

  // 清理模拟运行的 ReShade.log 后执行一键还原，验证所有注入文件被移除且原版文件 100% 恢复
  fs.unlinkSync(path.join(gameDir, 'ReShade.log'));
  const restored = await backends.restore(gameDir);
  assert.equal(restored, true);
  assert.equal(fs.existsSync(path.join(gameDir, 'nvngx_dlssnr.dll')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'renodx-mfgunlock.addon64')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'renodx-dlss5.addon64')), false);
  assert.equal(fs.existsSync(origDlssPath), true);
  assert.equal(fs.statSync(origDlssPath).size, origDlssBytes.length);
});

test('Phase 5 UI：前端包含三大功能区域与明确区分的四级状态徽章', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const uiJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'enhanced-ui.js'), 'utf8');
  const uiCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'enhanced-ui.css'), 'utf8');

  assert.match(html, /href="enhanced-ui\.css"/);
  assert.match(html, /src="enhanced-ui\.js"/);
  assert.match(html, /data-view="enhanced"/);
  assert.match(html, /id="view-enhanced"/);

  // 三大核心功能区域标题与无障碍标签
  assert.match(uiJs, /Neural Rendering Manager/);
  assert.match(uiJs, /Multi Frame Generation Manager/);
  assert.match(uiJs, /Compatibility & Diagnostics/);

  // 四级状态徽章样式与文案
  for (const cls of ['enh-badge-verified', 'enh-badge-experimental', 'enh-badge-incompatible', 'enh-badge-untested']) {
    assert.ok(uiCss.includes(cls), `CSS 包含 ${cls}`);
    assert.ok(uiJs.includes(cls), `JS 包含 ${cls}`);
  }
  for (const label of ['已验证可用', '实验性支持', '不兼容', '尚未测试']) {
    assert.ok(uiJs.includes(label), `UI 明确区分状态：${label}`);
  }
});

