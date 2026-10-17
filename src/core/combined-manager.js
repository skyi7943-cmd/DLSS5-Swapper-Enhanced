'use strict';
// 模块 C：DLSS 5 神经渲染 + NVIDIA MFG 多帧生成联合运行与兼容性诊断管理器
// 支持独立控制 Neural Rendering (Off / Legacy Model / Latest Compatible Model) 与
// Multi Frame Generation (Off / x2 / x3 / x4)，并全面执行 7 项联合兼容性、显存预算、Reflex 延迟与备份完整性检查。

const fs = require('fs');
const path = require('path');
const pe = require('./pe');
const journal = require('./file-journal');
const apply = require('./apply');
const backends = require('./backend-manager');
const feederConfig = require('./feeder-config');
const { scanGame } = require('./scan');
const neuralModels = require('./neural-models');
const mfgManager = require('./mfg-manager');

const { detectHardwareEnvironment } = require('./hardware-environment');

// 评估在 RTX 4070 Laptop (8GB VRAM, 1080p) 下同时或单独开启 DLSS 5 与 MFG 的显存预算
function estimateVramBudget({
  neuralMode = 'off',
  neuralModelId = '310.8.SF-v2',
  mfgMode = 'off',
  vramTotalMB = null,
  resolution = '1920x1080'
} = {}) {
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
  const knownCapacity = Number.isFinite(vramTotalMB) && vramTotalMB > 0;
  const headroomMB = knownCapacity ? vramTotalMB - estimatedTotalMB : null;
  const usagePercent = knownCapacity ? Math.round((estimatedTotalMB / vramTotalMB) * 100) : null;

  let level = 'unknown';
  if (knownCapacity && resolution === '1920x1080') {
    level = headroomMB < 400 ? 'critical' : headroomMB < 1000 ? 'caution' : 'estimated';
  }
  const summary = '估算，非测量：固定假设游戏基线 5400 MiB，附加开销约 ' + totalAddedOverheadMB +
    ' MiB。未测当前游戏、贴图、驱动或场景；不能据此保证 8GB 安全或 FPS。' +
    (!knownCapacity ? ' GPU 容量未知。' : '') +
    (resolution !== '1920x1080' ? ' 此估算仅适用于 1080p，其他分辨率未建模。' : '');

  return {
    isEstimate: true,
    evidence: 'unmeasured heuristic',
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
    summary
  };
}

// 执行 7 项 DLSS 5 + MFG 联合运行深度兼容性检查
function evaluateCoExecutionChecks(gameDir, scan, neuralStatus, mfgStatus, hardware) {
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
      ? '双模块已配置；边界保护设置不等于实际画质验证，请在游戏内检查运动矢量、HUD 和遮挡伪影。'
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

  // 5. 是否超过 RTX 4070 Laptop 的 8GB 显存限制
  const vramBudget = estimateVramBudget({
    neuralMode: neuralStatus.mode,
    neuralModelId: neuralStatus.currentModel?.id || '310.8.SF-v2',
    mfgMode: mfgStatus.currentConfig.mode,
    vramTotalMB: hardware?.gpu?.vramTotalMB ?? null
  });

  // 6. Reflex、帧同步和延迟控制是否仍有效
  const hasReflexDll = Boolean(mfgStatus.streamline.reflexPluginVersion) ||
    fs.existsSync(path.join(exeDir, 'sl.reflex.dll'));
  const reflexCheck = {
    ok: mfgStatus.currentConfig.mode === 'off',
    runtimeVerified: false,
    hasReflexDll,
    reflexVersion: mfgStatus.streamline.reflexPluginVersion,
    hardwareFlipMetering: Boolean(mfgStatus.gpuSupport.hardwareFlipMetering),
    message: hasReflexDll
      ? `已检测到 sl.reflex.dll (${mfgStatus.streamline.reflexPluginVersion || '未知版本'})；文件存在不能证明 Reflex 或帧同步已生效。`
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
async function inspectCombinedStatus(gameDir, { payloadDir, userDataDir } = {}) {
  const hardware = await detectHardwareEnvironment();
  const gpuName = hardware.gpu.name;
  const driverVersion = hardware.gpu.driver;

  const [scan, neuralStatus, mfgStatus] = await Promise.all([
    scanGame(gameDir),
    neuralModels.inspectGameNeuralStatus(gameDir, { payloadDir, userDataDir, gpuName }),
    mfgManager.inspectGameMfgStatus(gameDir, { payloadDir, gpuName, driverVersion })
  ]);

  const coExecution = evaluateCoExecutionChecks(gameDir, scan, neuralStatus, mfgStatus, hardware);

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
  } else if (neuralStatus.mode === 'off' && mfgStatus.status === 'verified') {
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
    hardware,
    neural: neuralStatus,
    mfg: mfgStatus,
    diagnostics: {
      gameName: path.basename(gameDir),
      graphicsApi: scan.chosen ? scan.chosen.apiLabel : 'Unknown',
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
    payloadDir,
    userDataDir
  } = config;
  const effectivePayloadDir = mfgManager.resolvePayloadDir
    ? mfgManager.resolvePayloadDir(payloadDir)
    : payloadDir;

  const hardware = await detectHardwareEnvironment();
  const gpuName = hardware.gpu.name;
  if (mfgMode && mfgMode !== 'off' && !mfgManager.evaluateMfgGpuSupport(gpuName, hardware.gpu.driver).nativeX2) {
    throw Object.assign(new Error('GPU 未检测到或不支持此配置，请刷新硬件检测。'), { code: 'errMfgGpuUnknownOrUnsupported' });
  }
  const scan = await scanGame(gameDir);
  if (!scan.chosen) throw Object.assign(new Error('未在游戏目录中找到可执行文件'), { code: 'errNoExe' });
  const exePath = scan.chosen.path;
  const exeDir = path.dirname(exePath);

  await require('./install-guards').assertGameClosed(gameDir, exePath);

  let neuralResult = null;
  let mfgResult = null;

  // 1. 应用神经渲染设置（若调用方指定了 neuralMode）
  if (neuralMode !== undefined) {
    neuralResult = await neuralModels.applyNeuralModelSelection(gameDir, {
      mode: neuralMode,
      modelId: neuralModelId,
      runtimeStack,
      payloadDir: effectivePayloadDir,
      userDataDir,
      gpuName
    }, onLog);

    // 若启用了神经渲染且游戏为 64 位，自动补齐或升级 renodx-dlss5.addon64 (v8.5.0-rc10) 与 ReShade
    if (neuralMode !== 'off' && scan.chosen.bitness === 64 && effectivePayloadDir) {
      await journal.transaction(gameDir, async () => {
        const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
        await apply.retireOldShaderCompiler(manifest, gameDir, exeDir, (code, params) => onLog({ code, params }));

        const destConsumer = path.join(exeDir, 'renodx-dlss5.addon64');
        const hasOtherConsumer = fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64')) ||
          fs.existsSync(path.join(exeDir, 'dlss5-feed.addon64')) ||
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
          const srcDlss = runtimeStack === 'oct2026-310.9.16'
            ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16', 'nvngx_dlss.dll')
            : path.join(effectivePayloadDir, 'streamline', 'nvngx_dlss.dll');
          if (fs.existsSync(srcDlss) && !fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll'))) {
            await apply.copyTracked(manifest, gameDir, srcDlss, path.join(exeDir, 'nvngx_dlss.dll'), {
              kind: 'runtime',
              newVersion: pe.getFileVersion(srcDlss)
            });
          }
          const reshadeCheck = scan.reshade;
          if (!reshadeCheck || !reshadeCheck.installed || !reshadeCheck.addonSupport) {
            const bundledReshade = path.join(effectivePayloadDir, 'reshade-vulkan', 'ReShade64.dll');
            if (fs.existsSync(bundledReshade)) {
              const hookFile = path.join(exeDir, 'dxgi.dll');
              const hookExisted = fs.existsSync(hookFile);
              await apply.copyTracked(manifest, gameDir, bundledReshade, hookFile, { kind: 'reshade' });
              manifest.reshade.installedByUs = !hookExisted;
              manifest.reshade.file = 'dxgi.dll';
            }
          }
          if (!manifest.route) manifest.route = 'native';
          await apply.saveActiveManifest(gameDir, manifest);
        } else if (fs.existsSync(destConsumer)) {
          await apply.enableAddonInIni(exeDir, 'renodx-dlss5.addon64', (code, params) => onLog({ code, params }), gameDir, manifest);
          await apply.saveActiveManifest(gameDir, manifest);
        }
      });
    }
  }

  // 2. 应用多帧生成设置（若调用方指定了 mfgMode）
  if (mfgMode !== undefined) {
    mfgResult = await mfgManager.applyMfgConfiguration(gameDir, {
      mode: mfgMode,
      runtimeStack,
      hdrCompatibility,
      upgradeDlssg: true,
      payloadDir: effectivePayloadDir
    }, onLog);

    // 若启用了 MFG 且请求补齐缺失的 Streamline (sl.dlss_g.dll / sl.reflex.dll / sl.pcl.dll)
    if (mfgMode !== 'off' && ensureStreamline && effectivePayloadDir) {
      await journal.transaction(gameDir, async () => {
        const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
        const slDir = runtimeStack === 'oct2026-310.9.16'
          ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16')
          : path.join(effectivePayloadDir, 'streamline');

        const hasOwnInterposer = scan.streamlineFiles.some((f) => /^sl\.interposer\.dll$/i.test(f.name));
        if (!hasOwnInterposer && fs.existsSync(slDir)) {
          for (const slFile of ['sl.interposer.dll', 'sl.common.dll', 'sl.dlss_g.dll', 'sl.reflex.dll', 'sl.pcl.dll']) {
            const src = path.join(slDir, slFile);
            const dest = path.join(exeDir, slFile);
            if (fs.existsSync(src) && !fs.existsSync(dest)) {
              await apply.copyTracked(manifest, gameDir, src, dest, {
                kind: 'streamline',
                newVersion: pe.getFileVersion(src)
              });
            }
          }
          await apply.saveActiveManifest(gameDir, manifest);
        }
      });
    }
  }

  // 3. 若两个模块同时处于激活状态且均使用 ReShade Addon，强制同步 RuntimeSelectionMode=1
  const reshadeIni = path.join(exeDir, 'ReShade.ini');
  const hasNrAddon = fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')) ||
    fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64'));
  const hasMfgAddon = fs.existsSync(path.join(exeDir, 'renodx-mfgunlock.addon64'));
  if (hasNrAddon && hasMfgAddon && fs.existsSync(reshadeIni)) {
    await journal.transaction(gameDir, async () => {
      const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
      let iniText = feederConfig.readText(reshadeIni);
      iniText = feederConfig.setIni(iniText, 'RenoDX.MFGUnlock', 'RuntimeSelectionMode', '1');
      await apply.writeTracked(manifest, gameDir, reshadeIni, iniText, { kind: 'config' });
      await apply.saveActiveManifest(gameDir, manifest);
    });
  }

  const updatedStatus = await inspectCombinedStatus(gameDir, { payloadDir: effectivePayloadDir, userDataDir });
  return {
    ok: true,
    neuralResult,
    mfgResult,
    status: updatedStatus
  };
}

module.exports = {
  detectHardwareEnvironment,
  estimateVramBudget,
  evaluateCoExecutionChecks,
  inspectCombinedStatus,
  applyCombinedConfiguration
};
