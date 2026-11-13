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
  // 中文三档硬件选择菜单
  for (const profileLabel of ['笔记本 40 系列', '40 系桌面卡', '50 系列桌面卡']) {
    assert.ok(uiJs.includes(profileLabel), `UI 包含中文硬件档位：${profileLabel}`);
  }
});

test('三档硬件菜单 (rtx40_laptop / rtx40_desktop / rtx50_desktop)：全模型兼容与桌面显卡 MFG 专项测试', async (t) => {
  // 1. 验证以往带 Ti / D / Super 后缀的桌面卡正则识别修复
  for (const desktop40 of ['NVIDIA GeForce RTX 4070Ti', 'NVIDIA GeForce RTX 4090D', 'NVIDIA GeForce RTX 4080 Super']) {
    const arch = neuralModels.detectGpuArchitecture(desktop40);
    assert.equal(arch.code, 'ada', `${desktop40} 应识别为 Ada`);
    assert.equal(arch.sm, '89', `${desktop40} 应识别为 sm_89`);
    assert.equal(arch.isLaptop, false, `${desktop40} 应识别为桌面卡`);
  }
  for (const desktop50 of ['NVIDIA GeForce RTX 5070Ti', 'NVIDIA GeForce RTX 5080', 'NVIDIA GeForce RTX 5090D']) {
    const arch = neuralModels.detectGpuArchitecture(desktop50);
    assert.equal(arch.code, 'blackwell', `${desktop50} 应识别为 Blackwell`);
    assert.equal(arch.sm, '120', `${desktop50} 应识别为 sm_120`);
    assert.equal(arch.isLaptop, false, `${desktop50} 应识别为桌面卡`);
  }

  // 2. 验证 310.8.SF-v2 与 310.9.16-oct2026 在三档硬件下全部本地就绪且已验证兼容
  for (const profileId of ['rtx40_laptop', 'rtx40_desktop', 'rtx50_desktop']) {
    const models = neuralModels.listNeuralModels({
      payloadDir: PAYLOAD_DIR,
      gpuName: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      hardwareProfile: profileId
    });
    const sfV2 = models.find((m) => m.id === '310.8.SF-v2');
    const oct16 = models.find((m) => m.id === '310.9.16-oct2026');
    assert.equal(sfV2.availableOnDisk, true, `${profileId} 下 310.8.SF-v2 必须本地就绪`);
    assert.equal(sfV2.compatStatus, 'verified', `${profileId} 下 310.8.SF-v2 必须验证兼容`);
    assert.equal(oct16.availableOnDisk, true, `${profileId} 下 310.9.16-oct2026 必须本地就绪`);
    assert.equal(oct16.compatStatus, 'verified', `${profileId} 下 310.9.16-oct2026 必须验证兼容`);
  }

  // 3. 模拟游戏目录并分别测试 40 系桌面卡 (rtx40_desktop) 与 50 系桌面卡 (rtx50_desktop) 的 DLSS 5 + MFG 联合配置
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-desktop-profiles-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-desktop-userdata-'));
  t.after(() => {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const hostExeSrc = path.join(PAYLOAD_DIR, 'feeder', 'dlss5-feed-host64.exe');
  const exePath = path.join(gameDir, 'GameDesktopDX12.exe');
  fs.writeFileSync(exePath, Buffer.concat([fs.readFileSync(hostExeSrc), Buffer.from('\0D3D12CreateDevice\0')]));
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlss.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll')));

  // 测试档位 2：40 系桌面卡 (rtx40_desktop) + 310.9.16-oct2026 模型 + MFG x3
  const resDesktop40 = await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx40_desktop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.9.16-oct2026',
    mfgMode: 'x3',
    runtimeStack: 'oct2026-310.9.16',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resDesktop40.ok, true);
  assert.equal(resDesktop40.hardwareProfile, 'rtx40_desktop');
  assert.equal(resDesktop40.status.neural.currentModel.id, '310.9.16-oct2026');

  const iniDesktop40 = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8');
  // 40 系桌面卡 DLSS 5 必须解锁 100% 满血分辨率 (NRResolutionScale=1) 与 8 工作集缓冲池
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRResolutionScale'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRFollowInputRes'), '0');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRHookPoint'), '0');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRMaxWorksets'), '8');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRAutoMask'), '0');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.DLSS5', 'NRUICorrection'), '0');
  // 40 系桌面卡 MFG 必须开启 DynamicMFG=1、原生输入模式 QualityGuardMode=0、V3 高锐度插值与 Reflex 低延迟护栏
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'ForceMultiplier'), '3');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'DynamicMFG'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'QualityGuardMode'), '0');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'TemporalFix'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'ExperimentalAdaptiveQuality'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'AdaptiveQualityProfile'), '2');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'IntermediateScatterRetention'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'RaiseFrameCeiling'), '1');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'LatencyGuardMode'), '0');
  assert.equal(ini.getIni(iniDesktop40, 'RenoDX.MFGUnlock', 'ReflexModeOverride'), '0');

  // 测试档位 3：50 系列桌面卡 (rtx50_desktop) + 310.8.SF-v2 模型 + MFG x4
  const resDesktop50 = await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx50_desktop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x4',
    runtimeStack: 'oct2026-310.9.16',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resDesktop50.ok, true);
  assert.equal(resDesktop50.hardwareProfile, 'rtx50_desktop');
  assert.equal(resDesktop50.status.mfg.status, 'verified');

  const iniDesktop50 = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8');
  // 50 系桌面卡 MFG 必须开启 DynamicMFG=1、QualityGuardMode=0 并关闭所有 40 系二进制补丁，直通 Blackwell 原生硬件 Flip Metering
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'ForceMultiplier'), '4');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'DynamicMFG'), '1');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'QualityGuardMode'), '0');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'TemporalFix'), '0');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'BlackwellFrameworkKernels'), '0');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'ForceFlipMeteringOff'), '0');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'ExperimentalAdaptiveQuality'), '0');
  assert.equal(ini.getIni(iniDesktop50, 'RenoDX.MFGUnlock', 'RaiseFrameCeiling'), '1');
});

test('老游戏全自动离线管线：32位 DX9 与 64位 DX10 无原生 DLSS 游戏一键部署 dgVoodoo2 + Feeder + LumeniteFX + host64 并支持无损还原', async (t) => {
  const { writePe } = require('./fixtures/pe');
  const gameDx9Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-legacy-dx9-32-'));
  const gameDx10Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-legacy-dx10-64-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-legacy-userdata-'));
  t.after(() => {
    fs.rmSync(gameDx9Dir, { recursive: true, force: true });
    fs.rmSync(gameDx10Dir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // 1. 构造 32 位 DirectX 9 老游戏（无原生 DLSS）
  writePe(path.join(gameDx9Dir, 'LegacyDX9.exe'), { bitness: 32, text: 'Direct3DCreate9' });
  const resDx9 = await combinedManager.applyCombinedConfiguration(gameDx9Dir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resDx9.ok, true);
  assert.equal(resDx9.feederDeployed, true);
  assert.equal(resDx9.mfgResult.skipped, true);
  // 验证离线 dgVoodoo2 + 32位 ReShade + dlss5-feed.addon32 + LumeniteFX + host64 全部就位
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'D3D9.dll')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'dgVoodoo.conf')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'dlss5-feed.addon32')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'reshade-shaders', 'Shaders', 'lumenite_Kernel.fx')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'host64', 'dlss5-feed-host64.exe')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'host64', 'renodx-dlss5.addon64')), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'host64', 'nvngx_dlssnr.dll')), true);
  assert.equal(await backends.restore(gameDx9Dir), true);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'D3D9.dll')), false);
  assert.equal(fs.existsSync(path.join(gameDx9Dir, 'host64')), false);

  // 2. 构造 64 位 DirectX 10 老游戏（无原生 DLSS）
  writePe(path.join(gameDx10Dir, 'LegacyDX10.exe'), { bitness: 64, text: 'D3D10CreateDevice' });
  const resDx10 = await combinedManager.applyCombinedConfiguration(gameDx10Dir, {
    hardwareProfile: 'rtx40_desktop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resDx10.ok, true);
  assert.equal(resDx10.feederDeployed, true);
  assert.equal(resDx10.mfgResult.skipped, true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'dlss5-feed.addon64')), true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'renodx-dlss5.addon64')), true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'nvngx_dlssnr.dll')), true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'reshade-shaders', 'Shaders', 'lumenite_Kernel.fx')), true);
  assert.equal(await backends.restore(gameDx10Dir), true);
  assert.equal(fs.existsSync(path.join(gameDx10Dir, 'nvngx_dlssnr.dll')), false);
});

test('破解版与老版本 DLSS 专项兼容：深层 2.x/3.x 自动升级、DLSS 1.x 自动切换 Feeder、破解补丁 dxgi.dll 防覆盖保护与一键还原', async (t) => {
  const { writePe } = require('./fixtures/pe');
  const { scanGame } = require('../src/core/scan');
  const installRoutes = require('../src/shared/install-routes');
  const pe = require('../src/core/pe');

  const crackedUeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-cracked-ue-'));
  const crackedDlss1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-cracked-dlss1-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-cracked-userdata-'));
  t.after(() => {
    fs.rmSync(crackedUeDir, { recursive: true, force: true });
    fs.rmSync(crackedDlss1Dir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // 场景 1：UE4/UE5 破解版游戏（含 steamclient_loader.exe、Game_org.exe 备份、破解补丁 dxgi.dll 以及深层插件目录 2.3.0.0 旧版 DLSS）
  const binDir = path.join(crackedUeDir, 'Game', 'Binaries', 'Win64');
  const deepDlssDir = path.join(crackedUeDir, 'Engine', 'Plugins', 'Runtime', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64');
  writePe(path.join(crackedUeDir, 'steamclient_loader.exe'), { bitness: 64, text: 'D3D12CreateDevice' });
  writePe(path.join(binDir, 'CrackedGame_org.exe'), { bitness: 64, text: 'D3D12CreateDevice', extraSize: 4096 });
  writePe(path.join(binDir, 'CrackedGame.exe'), { bitness: 64, text: 'D3D12CreateDevice', extraSize: 4096 });

  // 模拟联机/学习补丁占用的 dxgi.dll（非 ReShade）
  const crackDxgiPath = path.join(binDir, 'dxgi.dll');
  writePe(crackDxgiPath, { bitness: 64, version: [1, 0, 0, 1], productName: 'OnlineFix Crack Proxy' });
  const crackDxgiBytes = fs.readFileSync(crackDxgiPath);

  // 模拟深层插件目录中的旧版 DLSS 2.3.0.0
  const deepDlssPath = path.join(deepDlssDir, 'nvngx_dlss.dll');
  writePe(deepDlssPath, { bitness: 64, version: [2, 3, 0, 0], productName: 'NVIDIA DLSS' });
  const oldDlssBytes = fs.readFileSync(deepDlssPath);

  const scan1 = await scanGame(crackedUeDir);
  assert.equal(scan1.chosen.name, 'CrackedGame.exe', '应自动过滤 steamclient_loader.exe 并降权 CrackedGame_org.exe，准确选中主程序');
  assert.equal(scan1.primaryDlss.version, '2.3.0.0');

  const res1 = await combinedManager.applyCombinedConfiguration(crackedUeDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'off',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(res1.ok, true);
  // 验证破解补丁 dxgi.dll 完好无损，且 ReShade 自动改用 d3d12.dll 注入
  assert.deepEqual(fs.readFileSync(crackDxgiPath), crackDxgiBytes, '严禁覆盖破解补丁自带的 dxgi.dll');
  assert.equal(fs.existsSync(path.join(binDir, 'd3d12.dll')), true, 'ReShade 应自动回退使用 d3d12.dll');
  assert.equal(pe.versionMentions(path.join(binDir, 'd3d12.dll'), 'ReShade'), true);
  // 验证深层目录的旧版 2.3.0.0 nvngx_dlss.dll 已自动原位升级至 310.9.1.0，且同步部署了 nvngx_dlssnr.dll
  assert.equal(pe.getFileVersion(deepDlssPath), '310.9.1.0', '深层插件目录中的旧版 DLSS 2.3.0.0 应自动升级至 310.9.1.0');
  assert.equal(fs.existsSync(path.join(deepDlssDir, 'nvngx_dlssnr.dll')), true, '深层插件目录应同步额外部署 nvngx_dlssnr.dll');
  assert.equal(res1.status.diagnostics.coExecution.dlssCompat.mode, 'upgraded_from_low');
  assert.equal(res1.status.diagnostics.coExecution.dlssCompat.avoidedConflict, 'dxgi.dll');

  // 验证一键卸载后深层旧版 2.3.0.0 DLSS 与破解补丁目录 100% 恢复原状
  assert.equal(await backends.restore(crackedUeDir), true);
  assert.deepEqual(fs.readFileSync(deepDlssPath), oldDlssBytes, '还原后深层 nvngx_dlss.dll 必须恢复为 2.3.0.0 原文件');
  assert.equal(fs.existsSync(path.join(deepDlssDir, 'nvngx_dlssnr.dll')), false);
  assert.equal(fs.existsSync(path.join(binDir, 'd3d12.dll')), false);
  assert.deepEqual(fs.readFileSync(crackDxgiPath), crackDxgiBytes);

  // 场景 2：早期 RTX 破解版游戏（自带远古 DLSS 1.x 如 1.2.10.0 + XeSS 组件）
  writePe(path.join(crackedDlss1Dir, 'EarlyRtxGame.exe'), { bitness: 64, text: 'D3D12CreateDevice' });
  const dlss1Path = path.join(crackedDlss1Dir, 'nvngx_dlss.dll');
  writePe(dlss1Path, { bitness: 64, version: [1, 2, 10, 0], productName: 'NVIDIA DLSS v1' });
  writePe(path.join(crackedDlss1Dir, 'libxess.dll'), { bitness: 64, version: [1, 3, 0, 0], productName: 'Intel XeSS' });

  const scan2 = await scanGame(crackedDlss1Dir);
  assert.equal(installRoutes.nativeDlssPresent(scan2), false, 'DLSS 1.x 因 ABI 不兼容应被视为非原生 2.x+ DLSS');
  assert.equal(installRoutes.nativeUpscalerPresent(scan2), true, '应检测到原生 XeSS/FSR2 组件');
  const routes2 = installRoutes.routesFor({
    ...scan2.chosen,
    hasNativeDlss: installRoutes.nativeDlssPresent(scan2),
    hasNativeUpscaler: installRoutes.nativeUpscalerPresent(scan2)
  });
  assert.equal(routes2.includes('optiscaler'), true, '拥有 XeSS/FSR2 的无 DLSS 2+ 破解游戏应解锁 OptiScaler 路由');

  const res2 = await combinedManager.applyCombinedConfiguration(crackedDlss1Dir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'off',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.feederDeployed, true, 'DLSS 1.x 游戏应自动走 Feeder + 光流管线');
  assert.equal(fs.existsSync(path.join(crackedDlss1Dir, 'dlss5-feed.addon64')), true);

  // 场景 3：《虐杀原形 (Prototype)》类引擎：主程序无直接 D3D 导入，同目录同时存在含 DirectDrawCreate 字符串的 binkw32.dll 与真实渲染模块 prototypeenginef.dll
  const protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-proto-'));
  try {
    writePe(path.join(protoDir, 'prototypef.exe'), { bitness: 32, size: 128 * 1024 });
    writePe(path.join(protoDir, 'binkw32.dll'), { bitness: 32, text: 'DirectDrawCreate' });
    writePe(path.join(protoDir, 'prototypeenginef.dll'), { bitness: 32, text: 'Direct3DCreate9', size: 256 * 1024 });
    const scanProto = await scanGame(protoDir);
    assert.equal(scanProto.chosen.name, 'prototypef.exe');
    assert.equal(scanProto.chosen.api, 'd3d9', '应忽略 binkw32.dll 的 DirectDraw 字符串，准确识别 prototypeenginef.dll 的 DirectX 9');
    assert.equal(scanProto.chosen.via, 'renderer-module:prototypeenginef.dll');
  } finally {
    fs.rmSync(protoDir, { recursive: true, force: true });
  }

  // 场景 4：《马克思佩恩 2 (Max Payne 2)》类引擎：主程序内嵌 DxDiag 硬件检测字符串 Direct3DCreate9，真实渲染模块位于 e2driver/e2_d3d8_driver_mfc.dll
  const mp2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-mp2-'));
  try {
    writePe(path.join(mp2Dir, 'maxpayne2.exe'), { bitness: 32, text: 'Direct3DCreate9', extraSize: 64 * 1024 });
    writePe(path.join(mp2Dir, 'BugReport.exe'), { bitness: 32, text: 'Direct3DCreate9' });
    writePe(path.join(mp2Dir, 'e2driver', 'e2_d3d8_driver_mfc.dll'), { bitness: 32, text: 'Direct3DCreate8' });
    const scanMp2 = await scanGame(mp2Dir);
    assert.equal(scanMp2.chosen.name, 'maxpayne2.exe');
    assert.equal(scanMp2.chosen.api, 'd3d8', '应识别 e2driver/e2_d3d8_driver_mfc.dll 的真实 DirectX 8 渲染器，而非主程序 DxDiag 的 Direct3DCreate9 字符串');
    assert.equal(scanMp2.chosen.via, 'engine-module:e2driver/e2_d3d8_driver_mfc.dll');
  } finally {
    fs.rmSync(mp2Dir, { recursive: true, force: true });
  }
});

test('v2.3.1 老游戏全面兼容审计：32位 DDraw/D3D8/D3D9/OpenGL 包装与桥接、dgVoodoo 防溢出伪全屏、Steam 安装脚本零 UAC 虚拟注册表、编辑器过滤与无损还原', async (t) => {
  const { writePe } = require('./fixtures/pe');
  const { scanGame, inspectReShade } = require('../src/core/scan');
  const compatibility = require('../src/core/compatibility');
  const applyCore = require('../src/core/apply');
  const legacyInstallScript = require('../src/core/legacy-installscript');
  const library = require('../src/library');

  // 1. 验证 dgVoodoo 32 位专属配置（VRAM=1024 防 32 位 4GB 溢出、FullscreenAttributes=fake 防视频切换闪退、低分辨率枚举补充）
  const dg32 = ini.configureDgVoodoo('', { bitness: 32, api: 'd3d8' });
  assert.equal(ini.getIni(dg32, 'DirectX', 'VRAM'), '1024');
  assert.equal(ini.getIni(dg32, 'GeneralExt', 'FullscreenAttributes'), 'fake');
  assert.match(ini.getIni(dg32, 'DirectXExt', 'ExtraEnumeratedResolutions'), /640x480/);
  const dg64 = ini.configureDgVoodoo('', { bitness: 64, api: 'd3d9' });
  assert.equal(ini.getIni(dg64, 'DirectX', 'VRAM'), '4096');

  // 2. 验证 Steam installscript.vdf + 关联 .reg 脚本解析与 VirtualHKLM 预置
  const vdfTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-vdf-reg-'));
  t.after(() => fs.rmSync(vdfTemp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(vdfTemp, 'support'), { recursive: true });
  fs.writeFileSync(path.join(vdfTemp, 'support', 'largestring.reg'), [
    'REGEDIT4',
    '',
    '[HKEY_LOCAL_MACHINE\\SOFTWARE\\NovaLogic\\Delta Force: Xtreme\\1.00.0000]',
    '"CDKIID"="TEST_CDKIID_TOKEN_12345"',
    '"Build"=dword:00000010'
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(path.join(vdfTemp, '32660_install.vdf'), [
    '"Installscript"',
    '{',
    '  "Registry"',
    '  {',
    '    "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\NovaLogic\\\\Delta Force: Xtreme\\\\1.00.0000"',
    '    {',
    '      "string"',
    '      {',
    '        "Path" "%INSTALLDIR%"',
    '      }',
    '    }',
    '  }',
    '  "Run Process"',
    '  {',
    '    "Large String"',
    '    {',
    '      "Process 1" "%windir%\\\\REGEDIT.exe"',
    '      "Command 1" "/s \\"%INSTALLDIR%\\\\support\\\\largestring.reg\\""',
    '    }',
    '  }',
    '}'
  ].join('\r\n'), 'utf8');

  const regCalls = [];
  const seedRes = legacyInstallScript.seedInstallScriptRegistry(vdfTemp, vdfTemp, (args) => {
    regCalls.push(args);
    return '';
  });
  assert.equal(seedRes.seededKeys, 2);
  assert.ok(regCalls.some((a) =>
    a[0] === 'add' &&
    a[1] === 'HKCU\\Software\\DLSS5Swapper\\VirtualHKLM\\NovaLogic\\Delta Force: Xtreme\\1.00.0000' &&
    a.includes('Path') &&
    a.includes(vdfTemp.replace(/[\\/]+$/, ''))
  ), '应将 %INSTALLDIR% 展开后写入 HKCU VirtualHKLM');
  assert.ok(regCalls.some((a) =>
    a[0] === 'add' &&
    a[1] === 'HKCU\\Software\\DLSS5Swapper\\VirtualHKLM\\NovaLogic\\Delta Force: Xtreme\\1.00.0000' &&
    a.includes('CDKIID') &&
    a.includes('TEST_CDKIID_TOKEN_12345')
  ), '应解析关联 .reg 脚本并写入 CDKIID 校验串');

  // 3. 验证地图编辑器 (dfxmed.exe) / 升级器 (REVUPDAT.EXE) 过滤、winmm.dll 免误判与 ReShade32.dll 识别
  const dfxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-dfx-scan-'));
  t.after(() => fs.rmSync(dfxDir, { recursive: true, force: true }));
  writePe(path.join(dfxDir, 'DFX.EXE'), { bitness: 32, text: 'Direct3DCreate9', size: 64 * 1024 });
  writePe(path.join(dfxDir, 'dfxmed.exe'), { bitness: 32, text: 'Direct3DCreate9', size: 128 * 1024 });
  writePe(path.join(dfxDir, 'REVUPDAT.EXE'), { bitness: 32, text: 'DirectDrawCreate', size: 128 * 1024 });
  writePe(path.join(dfxDir, 'winmm.dll'), { bitness: 32, text: 'Direct3DCreate8 Direct3DCreate9' });
  fs.copyFileSync(path.join(PAYLOAD_DIR, 'reshade-vulkan', 'ReShade32.dll'), path.join(dfxDir, 'ReShade32.dll'));

  const scanDfx = await scanGame(dfxDir);
  assert.equal(scanDfx.chosen.name, 'DFX.EXE', '应排除升级器并对 *med.exe 地图编辑器降权，准确选中游戏主程序 DFX.EXE');
  assert.equal(scanDfx.chosen.api, 'd3d9');
  const rsCheck = inspectReShade(dfxDir);
  assert.equal(rsCheck.installed, true);
  assert.equal(rsCheck.file, 'ReShade32.dll');
  assert.equal(rsCheck.kind, 'preloader');

  // 4. 验证 Steam GoldSrc 共享基底包去重优先级 (Counter-Strike StateFlags=4 优先于 Half-Life StateFlags=68)
  const sharedHlDir = path.join(vdfTemp, 'Half-Life');
  const deduped = library.dedupe([
    { launcher: 'Steam', id: '70', name: 'Half-Life', dir: sharedHlDir, stateFlags: 68 },
    { launcher: 'Steam', id: '10', name: 'Counter-Strike', dir: sharedHlDir, stateFlags: 4 }
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, '10');
  assert.equal(deduped[0].name, 'Counter-Strike');

  // 5. 验证 32 位 DirectDraw 老游戏完整部署 (DDraw.dll + D3DImm.dll + winmm.dll + dlss5-zh-cn.addon32 + dgVoodoo.conf + dxgi.dll + host64) 与兼容性守卫及无损还原
  const scratchBase = fs.existsSync('E:\\Antigravity_Scratch') ? 'E:\\Antigravity_Scratch' : ROOT;
  const ddrawDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-dlss5-legacy-ddraw-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-ddraw-userdata-'));
  t.after(() => {
    fs.rmSync(ddrawDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  const ddrawExe = path.join(ddrawDir, 'Df2.exe');
  writePe(ddrawExe, { bitness: 32, text: 'DirectDrawCreate' });

  const resDdraw = await combinedManager.applyCombinedConfiguration(ddrawDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'off',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(resDdraw.ok, true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'DDraw.dll')), true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'D3DImm.dll')), true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'winmm.dll')), true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'dlss5-zh-cn.addon32')), true);
  const deployedDgConf = fs.readFileSync(path.join(ddrawDir, 'dgVoodoo.conf'), 'utf8');
  assert.equal(ini.getIni(deployedDgConf, 'DirectX', 'VRAM'), '1024');
  assert.equal(ini.getIni(deployedDgConf, 'GeneralExt', 'FullscreenAttributes'), 'fake');

  // 再次检查兼容性守卫与安全钩子选择器，确认已部署 dgVoodoo 的 DDraw/D3D9 不会触发伪冲突
  assert.doesNotThrow(() => compatibility.assertLoaderCompatible({
    gameDir: ddrawDir,
    exePath: ddrawExe,
    api: 'ddraw',
    bitness: 32,
    route: 'feeder',
    reshadeProxy: 'dxgi'
  }, null));
  const safeHook = applyCore.selectSafeReShadeHook(ddrawDir, 'ddraw', 'dxgi', 32);
  assert.equal(safeHook.hook, 'dxgi.dll');

  assert.equal(await backends.restore(ddrawDir), true);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'DDraw.dll')), false);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'D3DImm.dll')), false);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'winmm.dll')), false);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'dlss5-zh-cn.addon32')), false);
  assert.equal(fs.existsSync(path.join(ddrawDir, 'host64')), false);
});

test('v2.3.2 单层 DLSS 5 (NRPasses=1) 画质强化与省卡调优引擎、免重装热更新及学习版目录识别验证', async (t) => {
  const singlePassTuning = require('../src/core/singlepass-tuning');
  const library = require('../src/library');
  const { writePe } = require('./fixtures/pe');

  // 1. 验证四套预设与自定义参数均严格锁定 NRPasses=1，且解除皮肤独立截断锁 + 开启零耗时精细细节塑形
  const boostEco = singlePassTuning.normalizeSinglePassTuning({ preset: 'boost_eco' }, 'rtx40_laptop');
  assert.equal(boostEco.nrPasses, 1);
  assert.equal(boostEco.workResolution, 75);
  assert.equal(boostEco.metrics.pixelComputeSavedPercent, 44);
  assert.ok(boostEco.metrics.visualBoostPercent >= 25);

  const iniBoost = singlePassTuning.applyTuningToConsumerIni('', boostEco, { hardwareProfile: 'rtx40_laptop' });
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRPasses'), '1');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRIntensity'), '1.35');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRLocalStructure'), '1.3');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRSkinIndependent'), '0', '微结构 > 1.0x 时必须自动设为 0 以免被截断回 1.0');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRLookMode'), '1', '必须激活零额外通道的精细细节塑形管线');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRLookDetail'), '1.35');
  assert.equal(ini.getIni(iniBoost, 'RenoDX.DLSS5', 'NRResolutionScale'), '0.75');

  const ultraEco = singlePassTuning.normalizeSinglePassTuning({ preset: 'ultra_eco' }, 'rtx40_laptop');
  assert.equal(ultraEco.workResolution, 67);
  assert.equal(ultraEco.metrics.pixelComputeSavedPercent, 55);
  assert.equal(ultraEco.maxWorksets, 2);

  // 2. 验证显存预算估算随单层省卡档位动态下降（未传调优参数时保持原值不变）
  const baseVram = combinedManager.estimateVramBudget({
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    hardwareProfile: 'rtx40_desktop'
  });
  const ecoVram = combinedManager.estimateVramBudget({
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    hardwareProfile: 'rtx40_desktop',
    singlePassTuning: { preset: 'boost_eco' }
  });
  assert.equal(baseVram.neuralOverheadMB, 920);
  assert.ok(ecoVram.neuralOverheadMB < baseVram.neuralOverheadMB, '开启单层省卡调优后神经渲染显存开销必须显著降低');

  // 3. 验证 64 位无原生 DLSS 游戏与 32 位跨进程 host64 游戏的免重装极速热更新与无损卸载
  const scratchBase = fs.existsSync('E:\\Antigravity_Scratch') ? 'E:\\Antigravity_Scratch' : ROOT;
  const game64Dir = fs.mkdtempSync(path.join(scratchBase, '.tmp-dlss5-v232-64-'));
  const game32Dir = fs.mkdtempSync(path.join(scratchBase, '.tmp-dlss5-v232-32-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-v232-userdata-'));
  t.after(() => {
    fs.rmSync(game64Dir, { recursive: true, force: true });
    fs.rmSync(game32Dir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  writePe(path.join(game64Dir, 'StudyGameDX11.exe'), { bitness: 64, text: 'D3D11CreateDevice' });
  const apply64 = await combinedManager.applyCombinedConfiguration(game64Dir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'off',
    singlePassTuning: { preset: 'boost_eco' },
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(apply64.ok, true);
  assert.equal(apply64.status.singlePassTuning.installed, true);
  assert.equal(apply64.status.singlePassTuning.preset, 'boost_eco');

  // 免重装实时热更新切换至 ultra_eco 再切换至自定义参数
  const hotRes64 = await combinedManager.applySinglePassTuning(game64Dir, {
    preset: 'custom',
    intensity: 1.48,
    structure: 1.38,
    localTone: 1.25,
    detailBoost: 1.42,
    workResolution: 68,
    workUpscale: 1,
    sharpness: 0.42,
    holdStrength: 0.35,
    motionCost: 'fast'
  });
  assert.equal(hotRes64.ok, true);
  const inspected64 = combinedManager.inspectSinglePassTuning(game64Dir, { hardwareProfile: 'rtx40_laptop' });
  assert.equal(inspected64.installed, true);
  assert.equal(inspected64.preset, 'custom');
  assert.equal(inspected64.workResolution, 68);
  assert.equal(inspected64.intensity, 1.48);
  const preset64Text = fs.readFileSync(path.join(game64Dir, 'ReShadePreset.ini'), 'utf8');
  assert.equal(ini.getIni(preset64Text, 'DLSS5_Feed.fx', 'GEOM_ENABLE'), '0', '省卡光流模式下应关闭多通道几何相机求解器');
  assert.equal(await backends.restore(game64Dir), true);

  // 32 位跨进程 host64 热更新验证
  writePe(path.join(game32Dir, 'ClassicStudy32.exe'), { bitness: 32, text: 'Direct3DCreate9' });
  await combinedManager.applyCombinedConfiguration(game32Dir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    mfgMode: 'off',
    singlePassTuning: { preset: 'ultra_eco' },
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  const hostIni = fs.readFileSync(path.join(game32Dir, 'host64', 'ReShade.ini'), 'utf8');
  const feedCfg32 = fs.readFileSync(path.join(game32Dir, 'dlss5-feed.cfg'), 'utf8');
  assert.equal(ini.getIni(hostIni, 'RenoDX.DLSS5', 'NRPasses'), '1');
  assert.equal(ini.getIni(hostIni, 'RenoDX.DLSS5', 'NRResolutionScale'), '0.67');
  assert.equal(ini.getIni(hostIni, 'RenoDX.DLSS5', 'NRLookDetail'), '1.4');
  assert.match(feedCfg32, /work_resolution=67/);
  assert.match(feedCfg32, /work_sharpness=0\.45/);
  assert.equal(await backends.restore(game32Dir), true);

  // 4. 验证中文学习版 / 免安装游戏库目录自动扫描识别
  assert.equal(library.LIBRARY_NAME.test('学习版'), true);
  assert.equal(library.LIBRARY_NAME.test('单机游戏'), true);
  assert.equal(library.LIBRARY_NAME.test('免安装游戏'), true);
  const studyLibRoot = fs.mkdtempSync(path.join(scratchBase, '.tmp-study-lib-'));
  t.after(() => fs.rmSync(studyLibRoot, { recursive: true, force: true }));
  const subGameDir = path.join(studyLibRoot, '黑神话学习版测试');
  fs.mkdirSync(subGameDir, { recursive: true });
  writePe(path.join(subGameDir, 'b1-Win64-Shipping.exe'), { bitness: 64, text: 'D3D12CreateDevice', size: 256 * 1024 });
  const foundGames = library.folder(studyLibRoot, 'My folders', true);
  assert.equal(foundGames.length, 1);
  assert.equal(foundGames[0].dir, subGameDir);
});

test('v2.3.3 桌面端纯净度守卫、游戏内 Home 菜单参数防覆盖与 MinGW/MSVC ABI 闪退回归防护', async (t) => {
  const { writePe } = require('./fixtures/pe');

  // 1. 桌面端软件界面必须保持精简纯净，不包含单层调优滑块面板与 IPC 通道
  const uiJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'enhanced-ui.js'), 'utf8');
  const uiCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'enhanced-ui.css'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(uiJs.includes('enh-tuning-card'), false, '桌面 UI 不应渲染单层调优卡片');
  assert.equal(uiJs.includes('data-tune-slider'), false, '桌面 UI 不应渲染调优滑块');
  assert.equal(uiCss.includes('.enh-tuning-card'), false, '桌面 CSS 不应残留单层调优样式');
  assert.equal(mainJs.includes('enhanced-apply-tuning'), false, '主进程不应暴露桌面调优 IPC');
  assert.equal(preloadJs.includes('enhancedApplyTuning'), false, '预加载脚本不应暴露桌面调优 API');
  assert.equal(uiJs.includes(`ENHANCED v${pkg.version}`), true, `界面徽章应同步更新为 ENHANCED v${pkg.version}`);

  // 2. C++ 游戏内 Home 插件源码严禁直接调用按值返回 ImVec2/ImVec4 的 ImGui 函数（防止 MinGW/MSVC sret 寄存器不匹配导致按 Home 闪退）
  const cppSrc = fs.readFileSync(path.join(ROOT, 'overlay', 'zh-cn-overlay.cpp'), 'utf8');
  const cppCodeOnly = cppSrc.replace(/\/\/.*$/gm, '');
  for (const forbidden of [
    'GetContentRegionAvail',
    'GetContentRegionMax',
    'GetWindowContentRegionMin',
    'GetWindowContentRegionMax',
    'GetWindowPos(',
    'GetWindowSize(',
    'GetCursorPos(',
    'GetCursorStartPos(',
    'GetCursorScreenPos(',
    'GetItemRectMin(',
    'GetItemRectMax(',
    'GetItemRectSize(',
    'CalcTextSize('
  ]) {
    assert.equal(cppCodeOnly.includes(forbidden), false, `zh-cn-overlay.cpp 严禁调用按值返回结构体的 ${forbidden}`);
  }

  // 校验 payload 与 vendor/enhanced-cache 中的 64/32 位中文插件哈希完全同步，防止打包时被旧缓存覆盖
  for (const name of ['dlss5-zh-cn.addon64', 'dlss5-zh-cn.addon32']) {
    const p1 = path.join(PAYLOAD_DIR, 'enhanced', 'zh-cn', name);
    const p2 = path.join(ROOT, 'vendor', 'enhanced-cache', 'zh-cn', name);
    assert.equal(fs.existsSync(p1), true, `${name} 必须存在于 payload/enhanced/zh-cn`);
    if (fs.existsSync(p2)) {
      assert.deepEqual(fs.readFileSync(p1), fs.readFileSync(p2), `${name} 在 payload 与 vendor/enhanced-cache 中必须字节级一致`);
    }
  }

  // 3. 验证用户在游戏内 Home 菜单自定义参数写入 ReShade.ini 后，再次在桌面端点击应用配置不会覆盖用户的游戏内自定义值
  const scratchBase = fs.existsSync('E:\\Antigravity_Scratch') ? 'E:\\Antigravity_Scratch' : ROOT;
  const gameDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-dlss5-v233-preserve-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-v233-userdata-'));
  t.after(() => {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  writePe(path.join(gameDir, 'PBZTest.exe'), { bitness: 64, text: 'D3D12CreateDevice', size: 128 * 1024 });
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlss.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll')));

  // 首次安装：应自动初始化单层强效·省卡基线 (NRPasses=1, NRIntensity=1.35, NRResolutionScale=0.75)
  await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'off',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  let iniText = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8');
  assert.equal(ini.getIni(iniText, 'RenoDX.DLSS5', 'NRPasses'), '1');
  assert.equal(ini.getIni(iniText, 'RenoDX.DLSS5', 'NRIntensity'), '1.35');
  assert.equal(ini.getIni(iniText, 'RenoDX.DLSS5', 'NRResolutionScale'), '0.75');

  // 模拟玩家在游戏内按 Home 键将 NRIntensity 调为 1.62、NRResolutionScale 调为 0.67
  iniText = ini.setIni(iniText, 'RenoDX.DLSS5', 'NRIntensity', '1.62');
  iniText = ini.setIni(iniText, 'RenoDX.DLSS5', 'NRResolutionScale', '0.67');
  fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), iniText, 'utf8');

  // 玩家随后在桌面端开启 MFG x3 并点击保存应用：必须保留玩家在游戏内 Home 菜单调好的 1.62 与 0.67
  await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  const iniAfter = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8');
  assert.equal(ini.getIni(iniAfter, 'RenoDX.DLSS5', 'NRIntensity'), '1.62', '必须保留玩家在游戏内 Home 菜单调节的强度');
  assert.equal(ini.getIni(iniAfter, 'RenoDX.DLSS5', 'NRResolutionScale'), '0.67', '必须保留玩家在游戏内 Home 菜单调节的工作分辨率');
  assert.equal(ini.getIni(iniAfter, 'RenoDX.MFGUnlock', 'ForceMultiplier'), '3');
  assert.equal(await backends.restore(gameDir), true);
});

test('v2.3.4 ANR 超省显存通用多帧生成（实验性）离线完整性、跨厂牌 x2~x6 兼容、串联共存、破解避让与零残留还原验证', async (t) => {
  const runtimeComponents = require('../src/core/runtime-components');
  const { scanGame } = require('../src/core/scan');
  const { writePe } = require('./fixtures/pe');

  const scratchBase = fs.existsSync('E:\\Antigravity_Scratch') ? 'E:\\Antigravity_Scratch' : ROOT;
  const cacheDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-anr-cache-'));
  const gameDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-anr-game-'));
  const reverseDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-anr-reverse-'));
  const crackDir = fs.mkdtempSync(path.join(scratchBase, '.tmp-anr-crack-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-v234-userdata-'));
  t.after(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(reverseDir, { recursive: true, force: true });
    fs.rmSync(crackDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // 1. 离线组件解压、SHA-256 严格校验与代理 DLL 指纹识别
  const extractedBase = await runtimeComponents.ensureAnrFg(cacheDir);
  const extractedOptiDll = path.join(extractedBase, 'game', 'dxgi.dll');
  const extractedAnrDll = path.join(extractedBase, 'game', 'OptiScaler', 'custom', 'Apex Neural Rendering FG', 'dlssg', 'nvngx_dlssg.dll');
  assert.equal(fs.existsSync(extractedOptiDll), true);
  assert.equal(fs.existsSync(extractedAnrDll), true);
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(extractedOptiDll), true);
  const anrCheck = mfgManager.inspectDlssgBinary(extractedAnrDll);
  assert.equal(anrCheck.valid, true);
  assert.equal(anrCheck.isAnrProvider, true);
  assert.equal(anrCheck.supportsMfgX5X6, true);

  // 2. 跨显卡架构评估：RTX 40 / RTX 30 / AMD RDNA3 / Intel Arc 均支持 ANR x2~x6，GTX 1060 (无 FP16) 必须诚实拦截
  for (const gpuName of [
    'NVIDIA GeForce RTX 4070 Laptop GPU',
    'NVIDIA GeForce RTX 3060 Ti',
    'AMD Radeon RX 7800 XT',
    'Intel Arc B580 Graphics'
  ]) {
    const sup = mfgManager.evaluateMfgGpuSupport(gpuName, '617.42', null, 'anr-fg');
    assert.equal(sup.anrCompatible, true, `${gpuName} 应支持 ANR FG`);
    assert.equal(sup.modeBadges.x5.status, 'experimental', `${gpuName} 未运行时验证前 x5 应标为实验性支持`);
    assert.equal(sup.modeBadges.x6.status, 'experimental', `${gpuName} 未运行时验证前 x6 应标为实验性支持`);
  }
  const gtx10 = mfgManager.evaluateMfgGpuSupport('NVIDIA GeForce GTX 1060 6GB', '560.94', null, 'anr-fg');
  assert.equal(gtx10.anrCompatible, false);
  assert.equal(gtx10.modeBadges.x2.status, 'incompatible', 'GTX 10 系列缺失原生 FP16 应拦截 ANR FG');

  // 3. 显存预算评估：默认原生 MFG 数值 100% 不变，切换 ANR 后插帧显存开销降低 ~62%+ 且支持 x5/x6
  const nativeVram = combinedManager.estimateVramBudget({
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x4',
    hardwareProfile: 'rtx40_laptop'
  });
  const anrVram = combinedManager.estimateVramBudget({
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x4',
    mfgBackend: 'anr-fg',
    hardwareProfile: 'rtx40_laptop'
  });
  assert.equal(nativeVram.mfgOverheadMB, 660, '默认原生 MFG 显存预算必须保持 660 MB 不变');
  assert.equal(anrVram.mfgOverheadMB, 195, 'ANR x4 插帧显存预算应降至约 195 MB');
  assert.equal(anrVram.level, 'safe', '8GB 笔记本在 ANR x4 + DLSS 5 下显存应回到安全绿区');

  // 4. 联合部署 DLSS 5 + ANR FG (x5)：验证 Apex OptiScaler (dxgi.dll) -> ReShade64.dll 零冲突串联与配置落盘
  writePe(path.join(gameDir, 'CyberTest64.exe'), { bitness: 64, text: 'D3D12CreateDevice', size: 192 * 1024 });
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlss.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll')));
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlssg.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlssg.dll')));

  const comboRes = await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x5',
    mfgBackend: 'anr-fg',
    anrSceneCut: true,
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(comboRes.ok, true);
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(path.join(gameDir, 'dxgi.dll')), true, 'dxgi.dll 应为 Apex OptiScaler');
  assert.equal(fs.existsSync(path.join(gameDir, 'ReShade64.dll')), true, 'ReShade 应部署为 ReShade64.dll 供 OptiScaler 串联加载');
  assert.equal(fs.existsSync(path.join(gameDir, 'renodx-dlss5.addon64')), true);
  assert.equal(fs.existsSync(path.join(gameDir, 'dlss5-zh-cn.addon64')), true);
  assert.equal(fs.existsSync(path.join(gameDir, 'renodx-mfgunlock.addon64')), false, 'ANR 模式下不应混装原生 MFG 解锁插件');

  const optiIni = fs.readFileSync(path.join(gameDir, 'OptiScaler.ini'), 'utf8');
  assert.equal(ini.getIni(optiIni, 'FrameGen', 'FGInput'), 'nvngxfg');
  assert.equal(ini.getIni(optiIni, 'FrameGen', 'FGNvngxReplacement'), 'Apex Neural Rendering FG');
  assert.equal(ini.getIni(optiIni, 'DLSSG', 'InterpolationCount'), '4', 'x5 对应插帧数 InterpolationCount=4');
  assert.equal(ini.getIni(optiIni, 'DLSSG', 'OverrideInterpolationCount'), 'true');
  assert.equal(ini.getIni(optiIni, 'Plugins', 'LoadReshade'), 'true', '必须开启 LoadReshade=true 串联 DLSS 5 与中文 Home 菜单');

  const nrFgIni = fs.readFileSync(path.join(gameDir, 'OptiScaler', 'custom', 'Apex Neural Rendering FG', 'dlssg', 'nr_fg.ini'), 'utf8');
  assert.match(nrFgIni, /scene_cut\s*=\s*1/);
  assert.match(nrFgIni, /max_generated\s*=\s*5/);

  // 确认扫描器不会把 OptiScaler/custom/.../nvngx_dlssg.dll 误判为游戏原厂 DLSS-G 文件
  const scannedCombo = await scanGame(gameDir);
  assert.equal(
    scannedCombo.dlssFiles.some((f) => /optiscaler/i.test(path.relative(gameDir, f.path))),
    false,
    'scanGame 必须排除 OptiScaler 子目录下的自定义 nvngx_dlssg.dll'
  );

  // 5. 模拟运行时生成 nr_fg-001.log 与 OptiScaler.log，验证遥测诚实切换为“已运行时验证”并验证零残留清理
  const anrLogDir = path.join(gameDir, 'OptiScaler', 'custom', 'Apex Neural Rendering FG', 'dlssg');
  fs.writeFileSync(
    path.join(anrLogDir, 'nr_fg-001.log'),
    '[ANR] GPU path table: fp16_dp4a\n[ANR] path fp16_dp4a after: 0.42ms\n[ANR] 4 generated frames go through the output pass: ok\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(gameDir, 'OptiScaler.log'),
    '[info] DLSSG Interpolation Count set to: 4\n[info] DispatchCallback frameID: 120, numGeneratedFrames: 4\n',
    'utf8'
  );
  const inspectedLive = await combinedManager.inspectCombinedStatus(gameDir, {
    hardwareProfile: 'rtx40_laptop',
    mfgBackend: 'anr-fg',
    payloadDir: PAYLOAD_DIR,
    userDataDir,
    gpuInfo: { gpus: ['NVIDIA GeForce RTX 4070 Laptop GPU'] }
  });
  assert.equal(inspectedLive.mfg.currentConfig.backend, 'anr-fg');
  assert.equal(inspectedLive.mfg.currentConfig.mode, 'x5');
  assert.equal(inspectedLive.mfg.runtimeVerification.verifiedActive, true);
  assert.equal(inspectedLive.mfg.runtimeVerification.effectiveMultiplier, 5);
  assert.equal(inspectedLive.mfg.status, 'verified');

  // 6. 从 ANR 切换回 NVIDIA 原生 MFG 解锁 (x3)：必须自动清理 OptiScaler 并将 ReShade64.dll 还原回 dxgi.dll
  const switchNative = await combinedManager.applyCombinedConfiguration(gameDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x3',
    mfgBackend: 'auto',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(switchNative.ok, true);
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(path.join(gameDir, 'dxgi.dll')), false, '切回原生 MFG 后 dxgi.dll 应恢复为 ReShade');
  assert.equal(fs.existsSync(path.join(gameDir, 'ReShade64.dll')), false, 'ReShade64.dll 应已无损迁移回 dxgi.dll');
  assert.equal(fs.existsSync(path.join(gameDir, 'OptiScaler')), false, 'OptiScaler 目录及运行时日志应彻底清除');
  assert.equal(fs.existsSync(path.join(gameDir, 'renodx-mfgunlock.addon64')), true);

  // 一键完整还原：除备份历史目录 _DLSS5_Backup 外，游戏目录只剩最初的 3 个原始文件
  assert.equal(await backends.restore(gameDir), true);
  assert.deepEqual(
    fs.readdirSync(gameDir).filter((f) => f !== '_DLSS5_Backup').sort(),
    ['CyberTest64.exe', 'nvngx_dlss.dll', 'nvngx_dlssg.dll'].sort(),
    '一键还原后不应遗留任何插件、配置或日志目录'
  );

  // 7. 逆向安装顺序验证：先单独安装 ANR FG (x4)，随后再单独安装 DLSS 5 神经渲染，自动完成串联
  writePe(path.join(reverseDir, 'ReverseGame.exe'), { bitness: 64, text: 'D3D12CreateDevice', size: 160 * 1024 });
  fs.writeFileSync(path.join(reverseDir, 'nvngx_dlss.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll')));
  fs.writeFileSync(path.join(reverseDir, 'nvngx_dlssg.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlssg.dll')));

  await mfgManager.applyMfgConfiguration(reverseDir, {
    mode: 'x4',
    backend: 'anr-fg',
    anrSceneCut: false,
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(path.join(reverseDir, 'dxgi.dll')), true);

  await combinedManager.applyCombinedConfiguration(reverseDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(path.join(reverseDir, 'dxgi.dll')), true, '后装 DLSS 5 不得覆盖已有 ANR dxgi.dll');
  assert.equal(fs.existsSync(path.join(reverseDir, 'ReShade64.dll')), true, '后装 DLSS 5 应自动部署为 ReShade64.dll');
  const revOptiIni = fs.readFileSync(path.join(reverseDir, 'OptiScaler.ini'), 'utf8');
  assert.equal(ini.getIni(revOptiIni, 'Plugins', 'LoadReshade'), 'true', '后装 DLSS 5 必须自动回写 LoadReshade=true');
  assert.equal(await backends.restore(reverseDir), true);

  // 8. 学习版破解补丁避让验证：dxgi.dll 已被外部补丁占用时，ANR 自动退避至 winmm.dll，绝不覆盖破解文件
  writePe(path.join(crackDir, 'StudyAction64.exe'), { bitness: 64, text: 'D3D12CreateDevice', size: 160 * 1024 });
  const crackBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512, 0x2a), Buffer.from('CODEX_STUDY_DXGI_HOOK')]);
  fs.writeFileSync(path.join(crackDir, 'dxgi.dll'), crackBytes);
  fs.writeFileSync(path.join(crackDir, 'nvngx_dlss.dll'), fs.readFileSync(path.join(PAYLOAD_DIR, 'streamline', 'nvngx_dlss.dll')));

  const crackRes = await combinedManager.applyCombinedConfiguration(crackDir, {
    hardwareProfile: 'rtx40_laptop',
    neuralMode: 'latest_compatible',
    neuralModelId: '310.8.SF-v2',
    mfgMode: 'x6',
    mfgBackend: 'anr-fg',
    payloadDir: PAYLOAD_DIR,
    userDataDir
  });
  assert.equal(crackRes.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(crackDir, 'dxgi.dll')), crackBytes, '严禁覆盖原有的学习版 dxgi.dll 补丁');
  assert.equal(runtimeComponents.isAnrOptiScalerProxy(path.join(crackDir, 'winmm.dll')), true, 'ANR 应自动退避使用 winmm.dll 注入');
  assert.equal(fs.existsSync(path.join(crackDir, 'ReShade64.dll')), true);
  assert.equal(await backends.restore(crackDir), true);
  assert.deepEqual(fs.readFileSync(path.join(crackDir, 'dxgi.dll')), crackBytes, '还原后原版学习补丁 dxgi.dll 仍完好无损');
  assert.equal(fs.existsSync(path.join(crackDir, 'winmm.dll')), false);
});






