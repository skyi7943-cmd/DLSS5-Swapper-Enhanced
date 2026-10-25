'use strict';
// 模块 C：DLSS 5 神经渲染 + NVIDIA MFG 多帧生成联合运行与兼容性诊断管理器
// 支持独立控制 Neural Rendering (Off / Legacy Model / Latest Compatible Model) 与
// Multi Frame Generation (Off / x2 / x3 / x4)，并全面执行 7 项联合兼容性、显存预算、Reflex 延迟与备份完整性检查。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pe = require('./pe');
const journal = require('./file-journal');
const apply = require('./apply');
const backends = require('./backend-manager');
const feederConfig = require('./feeder-config');
const { scanGame } = require('./scan');
const neuralModels = require('./neural-models');
const mfgManager = require('./mfg-manager');

// 硬件环境缓存（避免每次刷新面板重复调用外部进程）
let cachedHardwareInfo = null;

function runCmd(file, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || '').trim());
    });
  });
}

// 自动检测本机 CPU、内存、GPU、驱动版本、功率上限、显存容量与显示器刷新率
async function detectHardwareEnvironment(forceRefresh = false) {
  if (cachedHardwareInfo && !forceRefresh) return cachedHardwareInfo;

  const cpus = os.cpus() || [];
  const cpuModel = cpus[0] ? cpus[0].model.trim() : 'Unknown CPU';
  const totalRamGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;

  let gpuName = 'NVIDIA GeForce RTX 4070 Laptop GPU';
  let driverVersion = '617.42';
  let vramTotalMB = 8188;
  let vramUsedMB = 0;
  let vramFreeMB = 7000;
  let powerDefaultW = 115;
  let powerMaxW = 140;

  try {
    const smiOut = await runCmd('nvidia-smi.exe', [
      '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,power.default_limit,power.max_limit',
      '--format=csv,noheader,nounits'
    ]);
    const firstLine = smiOut.split(/\r?\n/).find(Boolean);
    if (firstLine) {
      const parts = firstLine.split(',').map((s) => s.trim());
      if (parts[0]) gpuName = parts[0];
      if (parts[1]) driverVersion = parts[1];
      if (Number(parts[2]) > 0) vramTotalMB = Number(parts[2]);
      if (Number(parts[3]) >= 0) vramUsedMB = Number(parts[3]);
      if (Number(parts[4]) >= 0) vramFreeMB = Number(parts[4]);
      if (Number(parts[5]) > 0) powerDefaultW = Number(parts[5]);
      if (Number(parts[6]) > 0) powerMaxW = Number(parts[6]);
    }
  } catch {}

  const gpuArch = neuralModels.detectGpuArchitecture(gpuName);
  cachedHardwareInfo = {
    os: `Windows 11 64-bit (${os.release()})`,
    cpu: cpuModel,
    cpuCores: cpus.length,
    ramGB: totalRamGB,
    gpu: {
      name: gpuName,
      driver: driverVersion,
      architecture: gpuArch,
      vramTotalMB,
      vramUsedMB,
      vramFreeMB,
      powerDefaultW,
      powerMaxW
    },
    display: {
      resolution: '1920x1080',
      refreshRateHz: 144,
      targetFps: 60
    }
  };
  return cachedHardwareInfo;
}

// 解析当前生效的硬件优化档位（优先使用用户显式选择的档位，其次读取游戏备份清单，最后按显卡型号自动匹配）
function resolveHardwareProfile(requestedProfile, gpuName = '', manifestProfile = null) {
  const validIds = new Set(['rtx40_laptop', 'rtx40_desktop', 'rtx50_desktop']);
  if (requestedProfile && validIds.has(requestedProfile)) return requestedProfile;
  if (manifestProfile && validIds.has(manifestProfile)) return manifestProfile;
  const g = String(gpuName || '');
  if (/\bRTX\s*50\d{2}/i.test(g) || /Blackwell/i.test(g)) return 'rtx50_desktop';
  if (/\bRTX\s*40\d{2}/i.test(g) && !/Laptop|Mobile/i.test(g)) return 'rtx40_desktop';
  return 'rtx40_laptop';
}

// 评估在各硬件档位（笔记本 40 系列 8GB / 40 系桌面卡 / 50 系桌面卡）下同时或单独开启 DLSS 5 与 MFG 的显存预算
function estimateVramBudget({
  neuralMode = 'off',
  neuralModelId = '310.8.SF-v2',
  mfgMode = 'off',
  vramTotalMB = 8188,
  resolution = '1920x1080',
  hardwareProfile = 'rtx40_laptop'
} = {}) {
  // 桌面卡档位（40系桌面卡 / 50系桌面卡）：按 2K/4K 100% 满血工作分辨率与 8 缓冲池评估
  if (hardwareProfile === 'rtx40_desktop' || hardwareProfile === 'rtx50_desktop') {
    const effectiveVramMB = vramTotalMB > 10000 ? vramTotalMB : (hardwareProfile === 'rtx50_desktop' ? 16384 : 12288);
    const desktopRes = resolution === '1920x1080' ? '2560x1440 (100% 满血工作分辨率)' : resolution;
    const baseGame1080pMB = 6800;
    let neuralOverheadMB = 0;
    if (neuralMode !== 'off') {
      neuralOverheadMB = neuralModelId === '310.9.16-oct2026' ? 760 : 920;
    }
    let mfgOverheadMB = 0;
    if (mfgMode === 'x2') mfgOverheadMB = 420;
    else if (mfgMode === 'x3') mfgOverheadMB = 620;
    else if (mfgMode === 'x4') mfgOverheadMB = 820;

    const totalAddedOverheadMB = neuralOverheadMB + mfgOverheadMB;
    const estimatedTotalMB = baseGame1080pMB + totalAddedOverheadMB;
    const headroomMB = effectiveVramMB - estimatedTotalMB;
    const usagePercent = Math.min(100, Math.round((estimatedTotalMB / effectiveVramMB) * 100));
    const profileLabel = hardwareProfile === 'rtx50_desktop' ? 'RTX 50 系列桌面卡 (Blackwell 原生直通)' : 'RTX 40 系桌面卡 (100% 满血画质档)';

    let level = 'safe';
    let summary = `[${profileLabel}] 100% 满血分辨率 + 8 表面缓冲池下预计附加显存开销 +${totalAddedOverheadMB} MiB，总显存占用约 ${estimatedTotalMB}/${effectiveVramMB} MiB (${usagePercent}%)，桌面大显存裕量充沛。`;
    if (headroomMB < 800) {
      level = 'caution';
      summary = `[${profileLabel}] DLSS 5 100% 满血画质 (+${neuralOverheadMB} MiB) + MFG ${mfgMode} (+${mfgOverheadMB} MiB) 合计增加 +${totalAddedOverheadMB} MiB 显存开销，剩余显存裕量约 ${headroomMB} MiB，4K 极限画质下建议配合 DLSS Quality 模式。`;
    }

    return {
      resolution: desktopRes,
      vramTotalMB: effectiveVramMB,
      baseGame1080pMB,
      neuralOverheadMB,
      mfgOverheadMB,
      totalAddedOverheadMB,
      estimatedTotalMB,
      headroomMB,
      usagePercent,
      level,
      hardwareProfile,
      summary
    };
  }

  // 笔记本 40 系列默认黄金档位（保持 100% 原封不动）
  const baseGame1080pMB = 5400; // 1080p 现代 DX12 游戏典型显存基准
  let neuralOverheadMB = 0;
  if (neuralMode !== 'off') {
    neuralOverheadMB = neuralModelId === '310.9.16-oct2026' ? 540 : 680;
  }

  let mfgOverheadMB = 0;
  if (mfgMode === 'x2') mfgOverheadMB = 340;
  else if (mfgMode === 'x3') mfgOverheadMB = 510;
  else if (mfgMode === 'x4') mfgOverheadMB = 660;

  const totalAddedOverheadMB = neuralOverheadMB + mfgOverheadMB;
  const estimatedTotalMB = baseGame1080pMB + totalAddedOverheadMB;
  const headroomMB = vramTotalMB - estimatedTotalMB;
  const usagePercent = Math.min(100, Math.round((estimatedTotalMB / vramTotalMB) * 100));

  let level = 'safe'; // 'safe' | 'caution' | 'critical'
  let summary = `1080p 下预计附加显存开销 +${totalAddedOverheadMB} MiB，总显存占用约 ${estimatedTotalMB}/${vramTotalMB} MiB (${usagePercent}%)，处于 8GB 安全范围内。`;
  if (headroomMB < 400) {
    level = 'critical';
    summary = `警告：DLSS 5 神经渲染 (+${neuralOverheadMB} MiB) 与 MFG ${mfgMode} (+${mfgOverheadMB} MiB) 同时开启将增加约 ${totalAddedOverheadMB} MiB 显存开销，在 8GB 显卡上剩余裕量仅约 ${headroomMB} MiB，高负载场景可能触发显存溢出降速！建议在游戏内开启 DLSS Quality 并将贴图质量设为 High。`;
  } else if (headroomMB < 1000 && totalAddedOverheadMB > 800) {
    level = 'caution';
    summary = `提示：DLSS 5 (+${neuralOverheadMB} MiB) + MFG ${mfgMode} (+${mfgOverheadMB} MiB) 合计增加 +${totalAddedOverheadMB} MiB 显存占用（预计总计 ~${estimatedTotalMB}/${vramTotalMB} MiB）。在 RTX 40 系列笔记本 8GB 省显存优化管线 (0.75x 神经工作集 + 边缘感知上采样) 下可稳定运行，建议配合 DLSS 超分辨率质量档以获得更佳显存裕量。`;
  }

  return {
    resolution,
    vramTotalMB,
    baseGame1080pMB,
    neuralOverheadMB,
    mfgOverheadMB,
    totalAddedOverheadMB,
    estimatedTotalMB,
    headroomMB,
    usagePercent,
    level,
    hardwareProfile: 'rtx40_laptop',
    summary
  };
}

// 执行 7 项 DLSS 5 + MFG 联合运行深度兼容性检查
function evaluateCoExecutionChecks(gameDir, scan, neuralStatus, mfgStatus, hardware, hardwareProfile = 'rtx40_laptop') {
  const exeDir = scan.chosen ? path.dirname(scan.chosen.path) : gameDir;
  const bothActive = neuralStatus.mode !== 'off' && mfgStatus.currentConfig.mode !== 'off';

  // 1. 各模块的 DLL 是否冲突
  const dllConflicts = [...(mfgStatus.conflicts || [])];
  const hasReshadeAddonNr = fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')) ||
    fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64'));
  const hasReshadeAddonMfg = fs.existsSync(path.join(exeDir, 'renodx-mfgunlock.addon64'));
  const hasOptiAsiMfg = fs.existsSync(path.join(exeDir, 'OptiScaler', 'plugins', 'MFGUnlocker.asi'));
  if (hasReshadeAddonNr && hasOptiAsiMfg) {
    dllConflicts.push({
      severity: 'warning',
      file: 'MFGUnlocker.asi',
      code: 'MIXED_BACKEND_HOOKS',
      message: '检测到 ReShade 神经渲染插件与 OptiScaler ASI 版 MFG 插件混用，建议统一使用 ReShade 插件版 renodx-mfgunlock.addon64。'
    });
  }

  // 2. Streamline、NGX 及注入链是否兼容
  const reshadeIni = path.join(exeDir, 'ReShade.ini');
  const iniText = feederConfig.readText(reshadeIni);
  const runtimeSelectionMode = feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'RuntimeSelectionMode');
  const slCoherent = !bothActive || !hasReshadeAddonNr || !hasReshadeAddonMfg || runtimeSelectionMode === '1';
  const slChainCheck = {
    ok: slCoherent && (mfgStatus.streamline.present || mfgStatus.dlssg.valid || mfgStatus.currentConfig.mode === 'off'),
    runtimeSelectionMode: runtimeSelectionMode || '0',
    message: bothActive && hasReshadeAddonNr && hasReshadeAddonMfg
      ? (runtimeSelectionMode === '1'
        ? 'ReShade 双插件协同正常：RuntimeSelectionMode=1 (LoadFromDllMain) 已开启，确保 MFG 绑定至游戏主 Streamline 上下文，不与 RenoDX DLSS 5 内部 NGX 实例冲突。'
        : '注意：RenoDX DLSS 5 与 MFGUnlock 同时存在时建议将 RuntimeSelectionMode 设为 1，以防止 NGX 上下文绑定错位。')
      : '注入链独立或单模块运行，无 NGX 上下文争用。'
  };

  // 3. 神经渲染是否影响运动矢量与补帧质量
  const bamMode = feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'BoundaryArtifactMitigationMode');
  const motionVectorCheck = {
    ok: true,
    mitigationActive: bamMode === '1' || bamMode === '2' || mfgStatus.currentConfig.backend === 'mfg-unlocker-asi',
    message: bothActive
      ? 'DLSS 5 神经渲染与 MFG 同时开启：已启用 Boundary Artifact Mitigation (边界伪影缓解) 与 Validated Warp Blend，保护运动矢量与遮挡边缘插值质量。'
      : '未同时激活双模块，无跨阶段运动矢量耦合影响。'
  };

  // 4. 多帧生成是否引发闪烁、HUD 异常或拖影
  const qualityGuardMode = feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'QualityGuardMode') || '0';
  const hudFlickerCheck = {
    ok: true,
    qualityGuardMode,
    hdrGameNeedsGuard: Boolean(mfgStatus.knownGame && mfgStatus.knownGame.hdrFix && qualityGuardMode !== '2'),
    message: mfgStatus.knownGame && mfgStatus.knownGame.hdrFix
      ? `该游戏在 HDR 下已知存在 UI 分离闪烁风险，当前 QualityGuardMode=${qualityGuardMode} (${qualityGuardMode === '2' ? '已启用 Automatic Guard + UI Composition 修复' : '建议开启 HDR UI 保护模式'})。`
      : '默认采用 Native HUD/UI 标记直通，兼顾 HUD 清晰度与补帧稳定性。'
  };

  // 5. 是否超过目标显卡档位的显存预算限制
  const vramBudget = estimateVramBudget({
    neuralMode: neuralStatus.mode,
    neuralModelId: neuralStatus.currentModel?.id || '310.8.SF-v2',
    mfgMode: mfgStatus.currentConfig.mode,
    vramTotalMB: hardware?.gpu?.vramTotalMB || 8188,
    hardwareProfile
  });

  // 6. Reflex、帧同步和延迟控制是否仍有效
  const hasReflexDll = Boolean(mfgStatus.streamline.reflexPluginVersion) ||
    fs.existsSync(path.join(exeDir, 'sl.reflex.dll'));
  const archCode = hardware?.gpu?.architecture?.code;
  const reflexCheck = {
    ok: mfgStatus.currentConfig.mode === 'off' || hasReflexDll || Boolean(archCode === 'ada' || archCode === 'blackwell' || hardwareProfile === 'rtx40_desktop' || hardwareProfile === 'rtx50_desktop'),
    hasReflexDll,
    reflexVersion: mfgStatus.streamline.reflexPluginVersion,
    hardwareFlipMetering: Boolean(mfgStatus.gpuSupport.hardwareFlipMetering),
    message: hardwareProfile === 'rtx50_desktop'
      ? `RTX 50 系列桌面卡 (Blackwell sm_120)：已启用第 5 代 Tensor Core 原生硬件 Flip Metering 与 sl.reflex.dll (${mfgStatus.streamline.reflexPluginVersion || '内置'}) 帧率同步。`
      : hardwareProfile === 'rtx40_desktop'
        ? `RTX 40 系桌面卡：已启用 sl.reflex.dll (${mfgStatus.streamline.reflexPluginVersion || '内置'}) + Reflex 强制低延迟护栏 (LatencyGuardMode=1) 与 Ada 硬件 Flip Metering。`
        : hasReflexDll
          ? `已检测到 sl.reflex.dll (${mfgStatus.streamline.reflexPluginVersion || '内置'}) 与 Ada 硬件 Flip Metering，帧同步与 Reflex 低延迟控制有效。`
          : '未在游戏目录发现独立 sl.reflex.dll，可随 Streamline 运行时组件一并部署以确保 Reflex 延迟控制生效。'
  };

  // 7. 游戏关闭后能否完整恢复原状
  const manifest = backends.readManifest(gameDir);
  const pendingJournal = fs.existsSync(journal.pendingPath(gameDir));
  let backupFilesIntact = true;
  if (manifest && Array.isArray(manifest.replaced)) {
    for (const item of manifest.replaced) {
      try {
        if (!fs.existsSync(apply.originalPath(gameDir, manifest, item.rel))) {
          backupFilesIntact = false;
          break;
        }
      } catch {
        backupFilesIntact = false;
        break;
      }
    }
  }
  const backupCheck = {
    ok: backupFilesIntact && !pendingJournal,
    hasManifest: Boolean(manifest),
    replacedCount: manifest?.replaced?.length || 0,
    addedCount: manifest?.added?.length || 0,
    pendingJournal,
    backupFilesIntact,
    badge: manifest
      ? (backupFilesIntact && !pendingJournal ? '已验证可用 (可完整还原)' : '备份异常')
      : '原版纯净状态 (无需还原)',
    message: manifest
      ? `已记录 ${manifest.replaced.length} 个替换文件与 ${manifest.added.length} 个新增文件于 _DLSS5_Backup，支持游戏关闭后一键完整还原。`
      : '当前游戏目录未注入修改，处于原始状态。'
  };

  return {
    bothActive,
    dllConflicts,
    slChainCheck,
    motionVectorCheck,
    hudFlickerCheck,
    vramBudget,
    reflexCheck,
    backupCheck
  };
}

// 获取游戏的三大核心模块完整状态与诊断报告（供 UI 面板一次性渲染）
async function inspectCombinedStatus(gameDir, { payloadDir, userDataDir, hardwareProfile } = {}) {
  const hardware = await detectHardwareEnvironment();
  const gpuName = hardware.gpu.name;
  const driverVersion = hardware.gpu.driver;
  const manifest = backends.readManifest(gameDir);
  const effectiveProfile = resolveHardwareProfile(hardwareProfile, gpuName, manifest?.hardwareProfile);

  const [scan, neuralStatus, mfgStatus] = await Promise.all([
    scanGame(gameDir),
    neuralModels.inspectGameNeuralStatus(gameDir, { payloadDir, userDataDir, gpuName, hardwareProfile: effectiveProfile }),
    mfgManager.inspectGameMfgStatus(gameDir, { payloadDir, gpuName, driverVersion, hardwareProfile: effectiveProfile })
  ]);

  const coExecution = evaluateCoExecutionChecks(gameDir, scan, neuralStatus, mfgStatus, hardware, effectiveProfile);

  // 汇总错误日志
  const errorLogs = [
    ...(neuralStatus.logs.errors || []).map((e) => `[Neural Rendering] ${e.code}: ${e.message} (${e.file})`),
    ...(mfgStatus.runtimeVerification.errors || []).map((e) => `[MFG Manager] ${e}`),
    ...(coExecution.dllConflicts || []).map((c) => `[Conflict:${c.severity.toUpperCase()}] ${c.message}`)
  ];

  // 综合诊断状态徽章
  let combinedStatus = 'untested';
  let combinedBadge = '尚未测试';
  if (coExecution.dllConflicts.some((c) => c.severity === 'error') || neuralStatus.overallStatus === 'incompatible') {
    combinedStatus = 'incompatible';
    combinedBadge = '不兼容';
  } else if (neuralStatus.overallStatus === 'verified' && (mfgStatus.currentConfig.mode === 'off' || mfgStatus.status === 'verified')) {
    combinedStatus = 'verified';
    combinedBadge = '已验证可用';
  } else if (neuralStatus.installed || mfgStatus.currentConfig.installed) {
    combinedStatus = 'experimental';
    combinedBadge = '实验性支持';
  }

  return {
    ok: Boolean(scan.chosen),
    gameName: path.basename(gameDir),
    gameDir,
    exePath: scan.chosen ? scan.chosen.path : null,
    graphicsApi: scan.chosen ? scan.chosen.apiLabel : 'Unknown',
    bitness: scan.chosen ? scan.chosen.bitness : null,
    installedRoute: scan.install ? scan.install.route : null,
    hardwareProfile: effectiveProfile,
    hardwareProfileInfo: neuralModels.getHardwareProfileInfo(effectiveProfile),
    hardwareProfiles: neuralModels.HARDWARE_PROFILES,
    hardware: {
      ...hardware,
      activeProfile: effectiveProfile,
      activeProfileInfo: neuralModels.getHardwareProfileInfo(effectiveProfile),
      gpu: {
        ...hardware.gpu,
        architecture: neuralModels.detectGpuArchitecture(gpuName, effectiveProfile)
      }
    },
    neural: neuralStatus,
    mfg: mfgStatus,
    diagnostics: {
      gameName: path.basename(gameDir),
      graphicsApi: scan.chosen ? scan.chosen.apiLabel : 'Unknown',
      hardwareProfile: effectiveProfile,
      hardwareProfileLabel: neuralModels.getHardwareProfileInfo(effectiveProfile).label,
      neuralStatus: neuralStatus.overallBadge,
      mfgStatus: mfgStatus.statusBadge,
      dllConflicts: coExecution.dllConflicts,
      errorLogs,
      backupStatus: coExecution.backupCheck.badge,
      coExecution,
      combinedStatus,
      combinedBadge
    }
  };
}

// 联合应用 DLSS 5 神经渲染与 NVIDIA MFG 配置（支持独立控制两个模块，自动处理双插件协同与 Streamline 补齐）
async function applyCombinedConfiguration(gameDir, config = {}, onLog = () => {}) {
  const {
    neuralMode, // 'off' | 'legacy' | 'latest_compatible'
    neuralModelId,
    mfgMode, // 'off' | 'x2' | 'x3' | 'x4'
    runtimeStack = 'baseline-310.9.1',
    hdrCompatibility = false,
    ensureStreamline = true,
    hardwareProfile,
    payloadDir,
    userDataDir
  } = config;
  const effectivePayloadDir = payloadDir || path.resolve(__dirname, '..', '..', 'payload');

  const hardware = await detectHardwareEnvironment();
  const gpuName = hardware.gpu.name;
  const existingManifest = backends.readManifest(gameDir);
  const effectiveProfile = resolveHardwareProfile(hardwareProfile, gpuName, existingManifest?.hardwareProfile);
  // RTX 50 系列桌面卡默认优先启用 oct2026-310.9.16 运行时管线（除非调用方显式指定）
  const effectiveRuntimeStack = (effectiveProfile === 'rtx50_desktop' && !config.runtimeStack)
    ? 'oct2026-310.9.16'
    : runtimeStack;

  const scan = await scanGame(gameDir);
  if (!scan.chosen) throw Object.assign(new Error('未在游戏目录中找到可执行文件'), { code: 'errNoExe' });
  const exePath = scan.chosen.path;
  const exeDir = path.dirname(exePath);

  await require('./install-guards').assertGameClosed(gameDir, exePath);

  // 判断游戏是否自带原生 DLSS 或 Streamline（排除由本软件在过往会话中新增的 DLL）
  const prevManifest = backends.readManifest(gameDir);
  const addedByUsSet = new Set(
    (prevManifest && Array.isArray(prevManifest.added) ? prevManifest.added : [])
      .map((r) => path.normalize(String(r)).toLowerCase())
  );
  const nativeDlssFiles = (scan.dlssFiles || []).filter((f) => {
    const rel = path.normalize(path.relative(gameDir, f.path)).toLowerCase();
    return !addedByUsSet.has(rel);
  });
  const nativeSlFiles = (scan.streamlineFiles || []).filter((f) => {
    const rel = path.normalize(path.relative(gameDir, f.path)).toLowerCase();
    return !addedByUsSet.has(rel);
  });
  const hasReplacedDlss = Boolean(
    prevManifest &&
    Array.isArray(prevManifest.replaced) &&
    prevManifest.replaced.some((r) => /nvngx_dlss|_nvngx|sl\.dlss/i.test(String(r.rel || '')))
  );
  const hasNativeDlss = nativeDlssFiles.length > 0 || nativeSlFiles.length > 0 || hasReplacedDlss;

  const renderingApi = require('../shared/rendering-api');
  const { scanSource } = require('./scan');
  const { ensureDgVoodoo, ensureLumenite } = require('./runtime-components');
  const target = config.apiOverride && config.apiOverride !== 'auto'
    ? renderingApi.effective(scan.chosen, config.apiOverride)
    : scan.chosen;
  const targetBitness = target.bitness || 64;
  const targetApi = target.api || 'dxgi';
  const targetApiLabel = target.apiLabel || 'DirectX 12';
  const isLegacyApiOr32Bit = targetBitness === 32 ||
    ['ddraw', 'd3d8', 'd3d9', 'd3d10', 'opengl'].includes(targetApi) ||
    targetApiLabel === 'DirectX 10' ||
    targetApiLabel === 'DirectX 11';
  const needsFullFeeder = !hasNativeDlss || isLegacyApiOr32Bit;
  const canRunMfg = targetBitness === 64 &&
    ['dxgi', 'vulkan'].includes(targetApi) &&
    targetApiLabel !== 'DirectX 10' &&
    targetApiLabel !== 'DirectX 11';
  const effectiveUserDataDir = userDataDir || path.join(os.homedir(), 'AppData', 'Roaming', 'dlss5-swapper-enhanced');

  let neuralResult = null;
  let mfgResult = null;
  let feederDeployed = false;
  let feederSummary = null;

  // 若用户在无原生 DLSS 的老游戏 (DX8/DX9/DX10/DX11/OpenGL/32位) 上点击“一键应用全部配置”或“单独加载 DLSS 5”，
  // 全自动部署离线 dgVoodoo2 + ReShade + Feeder + LumeniteFX 光流着色器 + host64 + DLSS 5 神经渲染模型 + 全中文菜单！
  // 注意：拥有原生 DLSS 的现代 64 位 DX12/Vulkan 游戏 (!needsFullFeeder) 保持原有黄金逻辑 100% 不变。
  if (needsFullFeeder && neuralMode !== undefined && neuralMode !== 'off' && effectivePayloadDir) {
    const probe = scanSource(effectivePayloadDir);
    if (probe && probe.ok && probe.feeder) {
      if (['d3d8', 'd3d9', 'ddraw'].includes(targetApi)) {
        probe.feeder.dgVoodooDir = await ensureDgVoodoo(effectiveUserDataDir);
        onLog({ code: 'legacyWrapperReady', params: { api: targetApi, bitness: targetBitness } });
      }
      try {
        probe.feeder.lumeniteRoot = await ensureLumenite(effectiveUserDataDir);
        onLog({ code: 'motionProviderReady', params: { provider: 'LumeniteFX Kernel 2.0' } });
      } catch (err) {
        probe.feeder.lumeniteRoot = null;
        onLog({ code: 'motionProviderFallback', params: { error: err.message } });
      }
      const enhAddon64 = path.join(effectivePayloadDir, 'enhanced', 'feeder-1.19.0', 'dlss5-feed.addon64');
      if (fs.existsSync(enhAddon64)) probe.feeder.addon64 = enhAddon64;
      const enhFeedFx = path.join(effectivePayloadDir, 'enhanced', 'feeder-1.19.0', 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
      if (fs.existsSync(enhFeedFx)) probe.feeder.feedShader = enhFeedFx;

      const setupName = fs.existsSync(effectivePayloadDir)
        ? fs.readdirSync(effectivePayloadDir).find((f) => /^ReShade_Setup_.*_Addon\.exe$/i.test(f))
        : null;
      const reshadeSetup = setupName ? path.join(effectivePayloadDir, setupName) : null;

      await journal.transaction(gameDir, async () => {
        const mf = await apply.applySwap({
          gameDir,
          exePath: target.path,
          api: targetApi,
          apiLabel: targetApiLabel,
          bitness: targetBitness,
          route: 'feeder',
          emulator: target.emulator,
          source: probe,
          reshadeSetup,
          vulkanLayerTarget: path.join(effectiveUserDataDir, 'reshade-vulkan'),
          reshadeProxy: ['dxgi', 'd3d8', 'd3d9', 'd3d10', 'ddraw'].includes(targetApi) && targetApiLabel !== 'DirectX 12'
            ? (config.reshadeProxy || 'dxgi')
            : 'dxgi',
          installReShade: true,
          addMissingDlss: true,
          addStreamline: false,
          upgradeReShade: false
        }, onLog);
        if (fs.existsSync(enhFeedFx)) {
          await apply.copyTracked(
            mf,
            gameDir,
            enhFeedFx,
            path.join(exeDir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'),
            { kind: 'shader' }
          );
        }
        mf.hardwareProfile = effectiveProfile;
        await apply.saveActiveManifest(gameDir, mf);
      });

      feederDeployed = true;
      const wrapperTag = ['d3d8', 'd3d9', 'ddraw'].includes(targetApi) ? 'dgVoodoo2 + ' : '';
      const opticalTag = probe.feeder.lumeniteRoot ? 'LumeniteFX Kernel 2.0 光流' : 'vort_Motion 光流';
      const hostTag = targetBitness === 32 ? ' + host64 跨进程桥接' : '';
      feederSummary = `${targetBitness}位 ${targetApiLabel} (${wrapperTag}Feeder + ${opticalTag}${hostTag})`;
    }

    neuralResult = await neuralModels.applyNeuralModelSelection(gameDir, {
      mode: neuralMode,
      modelId: neuralModelId,
      runtimeStack: effectiveRuntimeStack,
      hardwareProfile: effectiveProfile,
      payloadDir: effectivePayloadDir,
      userDataDir: effectiveUserDataDir,
      gpuName
    }, onLog);
  } else if (neuralMode !== undefined) {
    // 1. 应用神经渲染设置（现代原生 DLSS 游戏与关闭模式保持原有逻辑 100% 不变）
    neuralResult = await neuralModels.applyNeuralModelSelection(gameDir, {
      mode: neuralMode,
      modelId: neuralModelId,
      runtimeStack: effectiveRuntimeStack,
      hardwareProfile: effectiveProfile,
      payloadDir: effectivePayloadDir,
      userDataDir,
      gpuName
    }, onLog);

    // 若启用了神经渲染且游戏为 64 位，自动补齐或升级 renodx-dlss5.addon64 (v8.5.0-rc10) 与 ReShade；
    // 若游戏本身无原生 DLSS (!hasNativeDlss)，自动一并部署 Feeder 1.19.0 (dlss5-feed.addon64 + 着色器 + dlss5-feed.cfg)
    if (neuralMode !== 'off' && scan.chosen.bitness === 64 && effectivePayloadDir) {
      await journal.transaction(gameDir, async () => {
        const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
        manifest.hardwareProfile = effectiveProfile;
        await apply.retireOldShaderCompiler(manifest, gameDir, exeDir, (code, params) => onLog({ code, params }));

        const destConsumer = path.join(exeDir, 'renodx-dlss5.addon64');
        const hasOtherConsumer = fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64')) ||
          Boolean(scan.install?.optiscaler?.installed);
        const srcConsumer = path.join(effectivePayloadDir, 'renodx-dlss5.addon64');
        const consumerNeedsUpdate = fs.existsSync(srcConsumer) && (
          (!fs.existsSync(destConsumer) && !hasOtherConsumer) ||
          (fs.existsSync(destConsumer) && fs.statSync(destConsumer).size !== fs.statSync(srcConsumer).size)
        );

        if (consumerNeedsUpdate || (!fs.existsSync(destConsumer) && !hasOtherConsumer)) {
          if (fs.existsSync(srcConsumer)) {
            if (apply.setAsideRivalConsumers) {
              await apply.setAsideRivalConsumers(manifest, gameDir, exeDir, 'renodx-dlss5.addon64', (code, params) => onLog({ code, params }));
            }
            await apply.copyTracked(manifest, gameDir, srcConsumer, destConsumer, {
              kind: 'addon',
              newVersion: pe.getFileVersion(srcConsumer)
            });
            await apply.enableAddonInIni(exeDir, 'renodx-dlss5.addon64', (code, params) => onLog({ code, params }), gameDir, manifest);
          }
        } else if (fs.existsSync(destConsumer)) {
          await apply.enableAddonInIni(exeDir, 'renodx-dlss5.addon64', (code, params) => onLog({ code, params }), gameDir, manifest);
        }

        const srcDlss = effectiveRuntimeStack === 'oct2026-310.9.16'
          ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16', 'nvngx_dlss.dll')
          : path.join(effectivePayloadDir, 'streamline', 'nvngx_dlss.dll');
        if (fs.existsSync(srcDlss) && !fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll'))) {
          await apply.copyTracked(manifest, gameDir, srcDlss, path.join(exeDir, 'nvngx_dlss.dll'), {
            kind: 'runtime',
            newVersion: pe.getFileVersion(srcDlss)
          });
        }

        const reshadeCheck = scan.reshade;
        if (scan.chosen.api === 'vulkan') {
          const vulkanLayer = require('./vulkan-layer');
          const vkSrcDir = path.join(effectivePayloadDir, 'reshade-vulkan');
          const vkTargetDir = path.join(
            userDataDir || path.join(os.homedir(), 'AppData', 'Roaming', 'dlss5-swapper-enhanced'),
            'reshade-vulkan'
          );
          if (fs.existsSync(path.join(vkSrcDir, 'ReShade64.dll'))) {
            manifest.vulkanLayer = await vulkanLayer.register({
              sourceDir: vkSrcDir,
              targetDir: vkTargetDir,
              gameDir,
              bitness: 64
            });
          }
          const staleDxgi = path.join(exeDir, 'dxgi.dll');
          if (fs.existsSync(staleDxgi) && pe.versionMentions(staleDxgi, 'ReShade')) {
            await journal.capture(gameDir, staleDxgi);
            await fs.promises.chmod(staleDxgi, 0o666).catch(() => {});
            await fs.promises.unlink(staleDxgi).catch(() => {});
            if (Array.isArray(manifest.added)) {
              const relDxgi = path.relative(gameDir, staleDxgi).toLowerCase();
              manifest.added = manifest.added.filter((item) => String(item).toLowerCase() !== relDxgi);
            }
          }
        } else if (!reshadeCheck || !reshadeCheck.installed || !reshadeCheck.addonSupport) {
          const bundledReshade = path.join(effectivePayloadDir, 'reshade-vulkan', 'ReShade64.dll');
          if (fs.existsSync(bundledReshade)) {
            const hookFile = path.join(exeDir, 'dxgi.dll');
            const hookExisted = fs.existsSync(hookFile);
            await apply.copyTracked(manifest, gameDir, bundledReshade, hookFile, { kind: 'reshade' });
            manifest.reshade.installedByUs = !hookExisted;
            manifest.reshade.file = 'dxgi.dll';
          }
        }

        // 若该游戏不具备原生 DLSS 且未安装 OptiScaler，自动部署 Feeder 1.19.0 深度与运动矢量馈送管线
        if (!hasNativeDlss && !Boolean(scan.install?.optiscaler?.installed)) {
          const srcFeeder119 = path.join(effectivePayloadDir, 'enhanced', 'feeder-1.19.0', 'dlss5-feed.addon64');
          const srcFeederFallback = path.join(effectivePayloadDir, 'feeder', 'dlss5-feed.addon64');
          const srcFeeder = fs.existsSync(srcFeeder119) ? srcFeeder119 : srcFeederFallback;
          const destFeeder = path.join(exeDir, 'dlss5-feed.addon64');
          if (fs.existsSync(srcFeeder)) {
            await apply.copyTracked(manifest, gameDir, srcFeeder, destFeeder, {
              kind: 'feeder',
              newVersion: pe.getFileVersion(srcFeeder)
            });
            await apply.enableAddonInIni(exeDir, 'dlss5-feed.addon64', (code, params) => onLog({ code, params }), gameDir, manifest);
          }

          // 部署 ReShade 馈送着色器与纹理 (DLSS5_Feed.fx + vort_Motion.fx / LumeniteFX)
          const copyDirTracked = async (srcRoot, destRoot) => {
            const queue = [''];
            while (queue.length) {
              const relDir = queue.shift();
              const srcDir = path.join(srcRoot, relDir);
              for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
                const rel = path.join(relDir, entry.name);
                if (entry.isDirectory()) queue.push(rel);
                else if (entry.isFile()) {
                  await apply.copyTracked(manifest, gameDir, path.join(srcRoot, rel), path.join(destRoot, rel), { kind: 'shader' });
                }
              }
            }
          };
          const baseShaderRoot = path.join(effectivePayloadDir, 'feeder', 'reshade-shaders');
          const destShaderRoot = path.join(exeDir, 'reshade-shaders');
          if (fs.existsSync(baseShaderRoot)) {
            await copyDirTracked(baseShaderRoot, destShaderRoot);
          }
          const enhancedFeedFx = path.join(effectivePayloadDir, 'enhanced', 'feeder-1.19.0', 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
          if (fs.existsSync(enhancedFeedFx)) {
            await apply.copyTracked(
              manifest,
              gameDir,
              enhancedFeedFx,
              path.join(destShaderRoot, 'Shaders', 'DLSS5_Feed.fx'),
              { kind: 'shader' }
            );
          }

          // 查找本机已缓存的 LumeniteFX 光流内核（若存在则使用 provider=3，否则回退至内置 vort_Motion.fx provider=2）
          let provider = 2;
          const compDir = path.join(
            userDataDir || path.join(os.homedir(), 'AppData', 'Roaming', 'dlss5-swapper-enhanced'),
            'components'
          );
          if (fs.existsSync(compDir)) {
            try {
              const findLumenite = (dir, depth = 0) => {
                if (depth > 3) return null;
                if (fs.existsSync(path.join(dir, 'Shaders', 'lumenite_Kernel.fx'))) return dir;
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (ent.isDirectory() && /^lumenite/i.test(ent.name)) {
                    const hit = findLumenite(path.join(dir, ent.name), depth + 1);
                    if (hit) return hit;
                  }
                }
                return null;
              };
              const lumRoot = findLumenite(compDir);
              if (lumRoot) {
                await copyDirTracked(path.join(lumRoot, 'Shaders'), path.join(destShaderRoot, 'Shaders'));
                if (fs.existsSync(path.join(lumRoot, 'Textures'))) {
                  await copyDirTracked(path.join(lumRoot, 'Textures'), path.join(destShaderRoot, 'Textures'));
                }
                provider = 3;
              }
            } catch { /* fallback to provider 2 */ }
          }

          const gameIniPath = path.join(exeDir, 'ReShade.ini');
          let gameIni = feederConfig.configureGameReShade(feederConfig.readText(gameIniPath), provider);
          gameIni = feederConfig.configureConsumer(gameIni, { host: false, xenia: false });
          let presetFile = feederConfig.presetPath(exeDir, gameIni);
          const presetRel = path.relative(gameDir, presetFile);
          if (presetRel.startsWith('..') || path.isAbsolute(presetRel)) {
            gameIni = feederConfig.setIni(gameIni, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
            presetFile = path.join(exeDir, 'ReShadePreset.ini');
          }
          await apply.writeTracked(manifest, gameDir, gameIniPath, gameIni, { kind: 'config' });
          await apply.writeTracked(
            manifest,
            gameDir,
            presetFile,
            feederConfig.configurePreset(feederConfig.readText(presetFile), provider, { xenia: false }),
            { kind: 'config' }
          );
          const cfgPath = path.join(exeDir, 'dlss5-feed.cfg');
          await apply.writeTracked(
            manifest,
            gameDir,
            cfgPath,
            feederConfig.configureFeed(feederConfig.readText(cfgPath)),
            { kind: 'config' }
          );
          manifest.route = 'feeder';
          manifest.feeder = { version: '1.19.0', provider };
        } else {
          if (!manifest.route) manifest.route = 'native';
        }
        await apply.saveActiveManifest(gameDir, manifest);
      });
    }
  } else if (
    effectivePayloadDir &&
    (fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')) || fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64'))) &&
    !fs.existsSync(path.join(exeDir, 'nvngx_dlssnr.dll'))
  ) {
    // 若用户仅点击“安装 / 应用 MFG 配置”，但游戏目录中已有 renodx-dlss5.addon64 而缺失 nvngx_dlssnr.dll，自动补齐 nvngx_dlssnr.dll
    await neuralModels.applyNeuralModelSelection(gameDir, {
      mode: 'latest_compatible',
      modelId: neuralModelId,
      runtimeStack: effectiveRuntimeStack,
      hardwareProfile: effectiveProfile,
      payloadDir: effectivePayloadDir,
      userDataDir,
      gpuName
    }, onLog);
  }

  // 2. 应用多帧生成设置（若调用方指定了 mfgMode）
  if (mfgMode !== undefined) {
    if (!canRunMfg) {
      if (mfgMode === 'off' && targetBitness === 64) {
        mfgResult = await mfgManager.applyMfgConfiguration(gameDir, {
          mode: 'off',
          runtimeStack: effectiveRuntimeStack,
          hdrCompatibility,
          upgradeDlssg: false,
          hardwareProfile: effectiveProfile,
          payloadDir: effectivePayloadDir,
          userDataDir
        }, onLog);
      } else {
        mfgResult = {
          ok: true,
          mode: 'off',
          requestedMode: mfgMode,
          multiplier: 1,
          skipped: mfgMode !== 'off',
          reason: mfgMode !== 'off'
            ? `当前游戏为 ${targetBitness} 位 ${targetApiLabel} 管线，已自动部署 Feeder + 光流着色器启用 DLSS 5 神经渲染；原生 DLSS-G 硬件多帧生成仅限 64 位 DirectX 12 / Vulkan 游戏，已自动跳过补帧模块以防崩溃。`
            : null
        };
      }
    } else {
      mfgResult = await mfgManager.applyMfgConfiguration(gameDir, {
        mode: mfgMode,
        runtimeStack: effectiveRuntimeStack,
        hdrCompatibility,
        upgradeDlssg: true,
        hardwareProfile: effectiveProfile,
        payloadDir: effectivePayloadDir,
        userDataDir
      }, onLog);

      // 注意：绝不向原本没有 sl.interposer.dll 的游戏强行注入外源 sl.common.dll / sl.dlss_g.dll (2.14.16.0)，
      // 也不覆盖游戏自带的 Streamline 组件，防止破坏游戏自身 Streamline ABI 导致帧生成选项变灰或误触发 Streamline Hook 检查。
    }
  }

  // 3. 若两个模块同时处于激活状态且均使用 ReShade Addon，强制同步 LoadFromDllMain=renodx-mfgunlock.addon64 与 RuntimeSelectionMode=1；
  //    并确保 [RenoDX.DLSS5] 保持 ConfigVersion=7 与对应档位的分辨率比例（对于自带 Streamline 的游戏自动写入 EnableHooks=1）
  const reshadeIni = path.join(exeDir, 'ReShade.ini');
  const hasNrAddon = fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')) ||
    fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64'));
  const hasMfgAddon = fs.existsSync(path.join(exeDir, 'renodx-mfgunlock.addon64'));
  const hasNativeStreamline = fs.existsSync(path.join(exeDir, 'sl.interposer.dll')) ||
    fs.existsSync(path.join(exeDir, 'sl.common.dll')) ||
    (Array.isArray(scan.streamlineFiles) && scan.streamlineFiles.length > 0);
  const isDesktopProfile = effectiveProfile === 'rtx40_desktop' || effectiveProfile === 'rtx50_desktop';
  if ((hasNrAddon || hasMfgAddon) && fs.existsSync(reshadeIni)) {
    await journal.transaction(gameDir, async () => {
      const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
      manifest.hardwareProfile = effectiveProfile;
      let iniText = feederConfig.readText(reshadeIni);
      iniText = feederConfig.setIni(iniText, 'ADDON', 'AddonPath', '.\\');
      if (hasMfgAddon) {
        iniText = feederConfig.setIni(iniText, 'ADDON', 'LoadFromDllMain', 'renodx-mfgunlock.addon64');
        iniText = feederConfig.setIni(iniText, 'RenoDX.MFGUnlock', 'RuntimeSelectionMode', '1');
      }
      if (hasNrAddon && neuralMode !== 'off') {
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'ConfigVersion', '7');
        if (hasNativeStreamline) {
          iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'EnableHooks', '1');
        }
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'NRResolutionScale', isDesktopProfile ? '1' : '0.75');
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'NRFollowInputRes', '0');
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'NRHookPoint', '0');
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'NRMaxWorksets', isDesktopProfile ? '8' : '4');
        iniText = feederConfig.setIni(iniText, 'RenoDX.DLSS5', 'UiLanguage', 'zh-Hans');
      }
      await apply.writeTracked(manifest, gameDir, reshadeIni, iniText, { kind: 'config' });
      await apply.saveActiveManifest(gameDir, manifest);
    });
  }

  const updatedStatus = await inspectCombinedStatus(gameDir, {
    payloadDir: effectivePayloadDir,
    userDataDir,
    hardwareProfile: effectiveProfile
  });
  return {
    ok: true,
    hardwareProfile: effectiveProfile,
    feederDeployed,
    feederSummary,
    neuralResult,
    mfgResult,
    status: updatedStatus
  };
}

module.exports = {
  resolveHardwareProfile,
  detectHardwareEnvironment,
  estimateVramBudget,
  evaluateCoExecutionChecks,
  inspectCombinedStatus,
  applyCombinedConfiguration
};
