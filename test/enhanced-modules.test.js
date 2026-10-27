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
});




