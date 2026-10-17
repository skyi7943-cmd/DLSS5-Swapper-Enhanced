'use strict';
// 模块 B：NVIDIA x3/x4 多帧生成独立管理模块 (MFG Manager)
// 基于经过验证且 MIT 许可合规的开源方案 (mavismmg/MFGAdaUnlock-RenoDx v1.4.4 与 dashdogy/MFG-Unlocker v1.5.0-hotfix.1)，
// 在不篡改磁盘签名、不绕过反作弊、不冒充 FSR/第三方插帧的前提下，为 RTX 40 系列 (Ada Lovelace 0x190) 提供进程内原生
// NVIDIA DLSS-G x2/x3/x4 多帧生成配置、注入器冲突检测、自动备份、一键恢复与真实运行时状态验证。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pe = require('./pe');
const journal = require('./file-journal');
const apply = require('./apply');
const feederConfig = require('./feeder-config');
const { scanGame } = require('./scan');
const { detectGpuArchitecture } = require('./neural-models');

// 经过验证的开源 MFG 解锁组件指纹表 (MIT License)
const MFG_UNLOCKERS = Object.freeze({
  renodxAddon: Object.freeze({
    id: 'renodx-mfgunlock-1.4.4',
    name: 'MFGAdaUnlock-RenoDx v1.4.4 (ReShade Add-on)',
    upstream: 'https://github.com/mavismmg/MFGAdaUnlock-RenoDx',
    license: 'MIT',
    version: '1.4.4',
    releaseDate: '2026-10-17',
    fileName: 'renodx-mfgunlock.addon64',
    relPath: 'enhanced/mfg/renodx-mfgunlock.addon64',
    size: 1199104,
    sha256: '5a193d86c6f60a7f0f275799d66eef7f14bd0946cdbefd48a3237506c747d5cd',
    supportedDlssg: ['310.9.0.0', '310.9.1.0', '310.9.16.0'],
    supportedStreamline: ['2.13.0.0', '2.14.1.0', '2.14.16.0']
  }),
  asiPlugin: Object.freeze({
    id: 'mfg-unlocker-1.5.0-hotfix.1',
    name: 'MFG-Unlocker v1.5.0-hotfix.1 (OptiScaler ASI / Universal)',
    upstream: 'https://github.com/dashdogy/MFG-Unlocker',
    license: 'MIT',
    version: '1.5.0.937',
    releaseDate: '2026-10-15',
    fileName: 'MFGUnlocker.dll',
    relPath: 'enhanced/mfg/MFGUnlocker.dll',
    size: 8929280,
    sha256: '4ac118f5cbb13a556c84979c2a2d2210a756dce172a9425ff62d870694747a2e',
    supportedDlssg: ['310.9.0.0', '310.9.1.0', '310.9.16.0']
  })
});

// 已知经过社区上游实测的 RTX 40 MFG 游戏兼容性知识库
const TESTED_MFG_GAMES = Object.freeze([
  { pattern: /cyberpunk\s*2077/i, title: 'Cyberpunk 2077', status: 'experimental', notes: '上游已实测通过 x3/x4 原生 DLSS-G 插帧，建议配合 DLSS-G 310.9.1+ 使用。' },
  { pattern: /alan\s*wake\s*2/i, title: 'Alan Wake 2', status: 'experimental', notes: '上游已实测通过 x3/x4 多帧生成，8GB 显存下建议 1080p 开启 DLSS Quality。' },
  { pattern: /s\.?t\.?a\.?l\.?k\.?e\.?r\.?\s*2|stalker2/i, title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl', status: 'experimental', notes: '支持原生 3x/4x 选择器与 OTA/内置 DLSS-G 310.9 提供程序。' },
  { pattern: /black\s*myth.*wukong|b1-win64-shipping/i, title: 'Black Myth: Wukong (黑神话：悟空)', status: 'experimental', notes: '上游已验证支持 x3/x4 多帧生成。' },
  { pattern: /hogwarts\s*legacy/i, title: 'Hogwarts Legacy', status: 'experimental', hdrFix: true, notes: '若开启 HDR 出现闪烁，请启用 Automatic Guard + UI Composition (HDR 兼容模式)。' },
  { pattern: /jusant/i, title: 'Jusant', status: 'experimental', hdrFix: true, notes: '建议在 HDR 模式下启用 Automatic Guard + UI Composition。' },
  { pattern: /mafia.*old\s*country/i, title: 'Mafia: The Old Country', status: 'experimental', hdrFix: true, notes: '建议在 HDR 模式下启用 Automatic Guard + UI Composition。' },
  { pattern: /onimusha/i, title: 'Onimusha: Way of the Sword', status: 'experimental', notes: '上游 PresentMon 验证在 4x 模式下达到 3.998x 真实帧生成步进。' },
  { pattern: /monster\s*hunter\s*wilds/i, title: 'Monster Hunter Wilds', status: 'experimental', notes: '首次安装或重建 shader.cache2 后请等待着色器编译完成并重启游戏。' },
  { pattern: /god\s*of\s*war\s*ragnar/i, title: 'God of War Ragnarök', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /spider-?man\s*2/i, title: "Marvel's Spider-Man 2", status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /silent\s*hill\s*2/i, title: 'Silent Hill 2', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /ghost\s*of\s*tsushima/i, title: 'Ghost of Tsushima', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /horizon\s*forbidden\s*west/i, title: 'Horizon Forbidden West', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /starfield/i, title: 'Starfield', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /witcher\s*3/i, title: 'The Witcher 3: Wild Hunt', status: 'experimental', notes: 'DX12 模式下支持 DLSS-G 310.9.x 升级与 x3/x4 解锁。' },
  { pattern: /dying\s*light.*beast/i, title: 'Dying Light: The Beast', status: 'experimental', notes: '上游已实测通过 RTX 40 x3/x4 多帧生成。' },
  { pattern: /indiana\s*jones/i, title: 'Indiana Jones and the Great Circle', status: 'experimental', notes: 'Vulkan 游戏：需添加启动参数 +r_allowBlackListedLayers 1 允许 ReShade 层加载。' },
  { pattern: /doom.*dark\s*ages/i, title: 'DOOM: The Dark Ages', status: 'experimental', notes: 'Vulkan 游戏：需添加启动参数 +r_allowBlackListedLayers 1 允许 ReShade 层加载。' }
]);

// 检测 GPU 对 NVIDIA DLSS-G 与 x3/x4 MFG 的底层硬件支持能力
// 注意：遵循严格要求，x3/x4 在未经当前游戏运行时实测验证生效前，绝不提前标记为“已验证可用”！
function evaluateMfgGpuSupport(gpuName = 'NVIDIA GeForce RTX 4070 Laptop GPU', driverVersion = '617.42') {
  const arch = detectGpuArchitecture(gpuName);
  if (arch.code === 'blackwell') {
    return {
      gpuName,
      driverVersion,
      architecture: arch,
      hardwareOpticalFlow: true,
      hardwareFlipMetering: true,
      nativeX2: true,
      nativeX3X4: true,
      unlockRequiredForX3X4: false,
      supportedModes: ['off', 'x2', 'x3', 'x4'],
      modeBadges: {
        off: { status: 'verified', badge: '已验证可用' },
        x2: { status: 'verified', badge: '已验证可用' },
        x3: { status: 'verified', badge: '已验证可用' },
        x4: { status: 'verified', badge: '已验证可用' }
      },
      summary: `${gpuName} (Blackwell 0x1B0) 原生支持 NVIDIA DLSS-G x2/x3/x4 多帧生成。`
    };
  }

  if (arch.code === 'ada') {
    return {
      gpuName,
      driverVersion,
      architecture: arch,
      hardwareOpticalFlow: true,
      hardwareFlipMetering: true,
      nativeX2: true,
      nativeX3X4: false,
      unlockRequiredForX3X4: true,
      supportedModes: ['off', 'x2', 'x3', 'x4'],
      // 在未经当前游戏运行时实测确认前，x3/x4 标记为“实验性支持”，绝不提前虚标为“已验证可用”
      modeBadges: {
        off: { status: 'verified', badge: '已验证可用' },
        x2: { status: 'verified', badge: '已验证可用 (原生 FG)' },
        x3: { status: 'experimental', badge: '实验性支持 (需运行时验证)' },
        x4: { status: 'experimental', badge: '实验性支持 (需运行时验证)' }
      },
      summary: `${gpuName} (Ada Lovelace 0x190 / sm_89) 具备第 4 代光流加速器与硬件 Flip Metering：原生支持 x2 帧生成；x3/x4 需通过进程内 NGX 0x1B0 门控解锁与时序插值核函数修正实现，仅在运行时遥测确认生效后才标记为已验证可用。`
    };
  }

  return {
    gpuName,
    driverVersion,
    architecture: arch,
    hardwareOpticalFlow: false,
    hardwareFlipMetering: false,
    nativeX2: false,
    nativeX3X4: false,
    unlockRequiredForX3X4: false,
    supportedModes: ['off'],
    modeBadges: {
      off: { status: 'verified', badge: '已验证可用' },
      x2: { status: 'incompatible', badge: '不兼容' },
      x3: { status: 'incompatible', badge: '不兼容' },
      x4: { status: 'incompatible', badge: '不兼容' }
    },
    summary: `${gpuName} (${arch.family}) 不具备 Ada/Blackwell 原生 DLSS-G 硬件管线，不支持原生 NVIDIA 多帧生成（本程序严禁使用 FSR FG 冒充 NVIDIA MFG）。`
  };
}

// 检验单个 nvngx_dlssg.dll 是否为正版 NVIDIA DLSS-G 二进制文件，拒绝 dlssg_to_fsr3 等第三方替换件
function inspectDlssgBinary(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, valid: false, isFakeWrapper: false, version: null, reason: '未检测到 nvngx_dlssg.dll' };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { exists: true, valid: false, isFakeWrapper: false, version: null, reason: `读取失败: ${err.message}` };
  }
  const bitness = pe.getBitness(filePath);
  const version = pe.getFileVersion(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // 检查是否为 dlssg-to-fsr3 或 Universal DLSSG to FSR3 伪装 DLL
  const hasFsr3Spoof = buf.includes(Buffer.from('dlssg_to_fsr3', 'latin1')) ||
    buf.includes(Buffer.from('amd_fidelityfx', 'latin1')) ||
    pe.versionMentions(filePath, 'dlssg-to-fsr3') ||
    pe.versionMentions(filePath, 'Nukem9');

  if (hasFsr3Spoof) {
    return {
      exists: true,
      valid: false,
      isFakeWrapper: true,
      filePath,
      version,
      sha256,
      reason: '检测到 nvngx_dlssg.dll 实际为第三方 dlssg-to-fsr3 (AMD FSR3 替换补丁)，并非真正的 NVIDIA DLSS-G 运行时！'
    };
  }

  const hasNvidiaDlssg = buf.includes(Buffer.from('nvngx_dlssg.pdb', 'latin1')) ||
    buf.includes(Buffer.from('DLSSGInstanceManager', 'latin1')) ||
    pe.versionMentions(filePath, 'NVIDIA');

  if (!hasNvidiaDlssg || bitness !== 64) {
    return {
      exists: true,
      valid: false,
      isFakeWrapper: false,
      filePath,
      version,
      sha256,
      reason: '该 nvngx_dlssg.dll 不是有效的 64 位 NVIDIA NGX DLSS-G 原生运行时'
    };
  }

  const is310_9 = /^310\.9\./.test(String(version || ''));
  return {
    exists: true,
    valid: true,
    isFakeWrapper: false,
    filePath,
    fileName: path.basename(filePath),
    size: buf.length,
    version: version || '0.0.0.0',
    sha256,
    supportsMfgX3X4: is310_9,
    reason: is310_9
      ? `NVIDIA 原生 DLSS-G ${version}，支持 x2/x3/x4 多帧生成管线`
      : `NVIDIA 原生 DLSS-G ${version} (旧版仅含 x2 管线，建议升级至内置 310.9.1 或 310.9.16 以启用 x3/x4)`
  };
}

// 检测游戏目录中的注入器冲突与第三方补帧干扰
function detectMfgInjectorConflicts(gameDir, exeDir, scan) {
  const conflicts = [];
  if (!exeDir || !fs.existsSync(exeDir)) return conflicts;

  let files = [];
  try { files = fs.readdirSync(exeDir); } catch { return conflicts; }

  for (const name of files) {
    const lower = name.toLowerCase();
    const full = path.join(exeDir, name);

    if (/dlssg_to_fsr3/i.test(lower)) {
      conflicts.push({
        severity: 'error',
        file: name,
        code: 'CONFLICT_DLSSG_TO_FSR3',
        message: `检测到第三方 FSR3 帧生成替换组件 (${name})，会劫持并阻止原生 NVIDIA DLSS-G 运行。`
      });
    }
    if (lower === 'nvngx_dlssg.dll') {
      const check = inspectDlssgBinary(full);
      if (check.isFakeWrapper) {
        conflicts.push({
          severity: 'error',
          file: name,
          code: 'CONFLICT_FAKE_DLSSG',
          message: check.reason
        });
      }
    }
    if (/^(version|winmm|dinput8|winhttp)\.dll$/i.test(lower)) {
      const isMfgProxy = pe.versionMentions(full, 'MFGUnlocker') ||
        (() => { try { return fs.readFileSync(full).includes(Buffer.from('RTXMFG-Universal')); } catch { return false; } })();
      if (isMfgProxy && files.some((f) => /^renodx-mfgunlock\.addon64$/i.test(f))) {
        conflicts.push({
          severity: 'warning',
          file: name,
          code: 'DUPLICATE_MFG_UNLOCKER',
          message: `同时存在独立代理版 MFGUnlocker (${name}) 与 ReShade 插件版 renodx-mfgunlock.addon64，双钩子同时拦截 slDLSSGSetOptions 可能导致冲突。`
        });
      }
    }
  }

  // 检查游戏图形 API 是否支持原生 DLSS-G (仅 DirectX 12 与 Vulkan 支持)
  const apiLabel = scan?.chosen?.apiLabel || '';
  if (apiLabel && !/DirectX 12|Vulkan|DirectX 11\/12|DirectX \(DXGI\)/i.test(apiLabel)) {
    conflicts.push({
      severity: 'error',
      file: scan?.chosen?.name || '',
      code: 'UNSUPPORTED_API_FOR_MFG',
      message: `当前游戏图形接口为 ${apiLabel}，而 NVIDIA 原生 DLSS-G / Streamline 帧生成仅支持 DirectX 12 与 Vulkan。`
    });
  }

  if (scan?.chosen?.bitness && scan.chosen.bitness !== 64) {
    conflicts.push({
      severity: 'error',
      file: scan?.chosen?.name || '',
      code: 'UNSUPPORTED_BITNESS_FOR_MFG',
      message: '32 位游戏不支持 64 位 NVIDIA NGX DLSS-G 原生多帧生成。'
    });
  }

  return conflicts;
}

// 解析游戏目录与系统临时目录中的 MFG 运行时日志与遥测状态，验证 x2/x3/x4 是否真实生效
function verifyMfgRuntimeStatus(gameDir, exeDir) {
  const dirs = [...new Set([exeDir, gameDir].filter(Boolean))];
  let providerVerified = false;
  let temporalFixApplied = false;
  let blackwellKernelsActive = false;
  let requestedMultiplier = null;
  let effectiveMultiplier = null;
  let presentedFrames = 0;
  let dlssgStatus = null;
  const errors = [];
  const logSources = [];

  // 1. 解析 ReShade.log 中的 MFGAdaUnlock-RenoDx 遥测与补丁日志
  for (const d of dirs) {
    const reshadeLog = path.join(d, 'ReShade.log');
    if (fs.existsSync(reshadeLog)) {
      try {
        const size = fs.statSync(reshadeLog).size;
        const fd = fs.openSync(reshadeLog, 'r');
        const readLen = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
        fs.closeSync(fd);
        const text = buf.toString('utf8');

        if (/MFGUnlock|renodx-mfgunlock/i.test(text)) {
          logSources.push(path.relative(gameDir, reshadeLog));
        }
        if (/verified mapped DLSS-G provider|PopulateParameters.*patched|0x1B0.*applied|DLSS-G provider verified/i.test(text)) {
          providerVerified = true;
        }
        if (/temporal fix applied|slot-9 temporal|reconstructed-fatbin.*applied/i.test(text)) {
          temporalFixApplied = true;
        }
        if (/Blackwell framework-kernel.*active|BlackwellFrameworkKernels.*applied/i.test(text)) {
          blackwellKernelsActive = true;
        }
        const multMatch = [...text.matchAll(/(?:effective|active|observed)\s*multiplier\s*[:=]\s*(\d+)x?/gi)].pop();
        if (multMatch) effectiveMultiplier = Number(multMatch[1]);
        const reqMatch = [...text.matchAll(/(?:ForceMultiplier|requested\s*multiplier)\s*[:=]\s*(\d+)x?/gi)].pop();
        if (reqMatch) requestedMultiplier = Number(reqMatch[1]);
        const presMatch = [...text.matchAll(/presented(?:\s*frames)?\s*[:=]\s*(\d+)/gi)].pop();
        if (presMatch) presentedFrames = Math.max(presentedFrames, Number(presMatch[1]));
        if (/unknown provider.*failing closed|patch failed|incompatible DLSS-G/i.test(text)) {
          errors.push('MFGAdaUnlock-RenoDx 报告当前 nvngx_dlssg.dll 指纹未知或内存补丁未应用 (Fail-Closed)。');
        }
      } catch {}
    }

    // 2. 解析 MFG-Unlocker 的 RTXMFG-Universal.status.json 状态文件
    const statusJson = path.join(d, 'RTXMFG-Universal.status.json');
    if (fs.existsSync(statusJson)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusJson, 'utf8'));
        logSources.push(path.relative(gameDir, statusJson));
        if (status.providerVerified || status.patched) providerVerified = true;
        if (status.temporalFixApplied || status.temporalPatched) temporalFixApplied = true;
        if (Number(status.effectiveMultiplier) >= 2) effectiveMultiplier = Number(status.effectiveMultiplier);
        if (Number(status.requestedMultiplier) >= 2) requestedMultiplier = Number(status.requestedMultiplier);
        if (Number(status.presentedFrames) > 0) presentedFrames = Math.max(presentedFrames, Number(status.presentedFrames));
        if (status.dlssgStatus) dlssgStatus = String(status.dlssgStatus);
        if (status.error) errors.push(String(status.error));
      } catch {}
    }
  }

  const verifiedActive = Boolean(
    providerVerified &&
    effectiveMultiplier &&
    effectiveMultiplier >= 2 &&
    (effectiveMultiplier === 2 || temporalFixApplied || blackwellKernelsActive) &&
    errors.length === 0
  );

  return {
    verifiedActive,
    providerVerified,
    temporalFixApplied,
    blackwellKernelsActive,
    requestedMultiplier,
    effectiveMultiplier,
    presentedFrames,
    dlssgStatus,
    logSources,
    errors
  };
}

// 读取当前游戏目录已配置的 MFG 模式与参数
function readCurrentMfgConfiguration(exeDir) {
  if (!exeDir || !fs.existsSync(exeDir)) {
    return { installed: false, backend: null, mode: 'off', multiplier: 1, settings: {} };
  }

  const addonFile = path.join(exeDir, 'renodx-mfgunlock.addon64');
  const asiFile = path.join(exeDir, 'OptiScaler', 'plugins', 'MFGUnlocker.asi');
  const reshadeIni = path.join(exeDir, 'ReShade.ini');
  const universalJson = path.join(exeDir, 'RTXMFG-Universal.json');
  const optiIni = path.join(exeDir, 'OptiScaler.ini');

  if (fs.existsSync(addonFile)) {
    const iniText = feederConfig.readText(reshadeIni);
    const enabled = feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'Enabled');
    const forceMult = Number(feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'ForceMultiplier') || 0);
    const temporalFix = feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'TemporalFix') !== '0';
    const qualityGuard = Number(feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'QualityGuardMode') || 0);
    const runtimeSelection = Number(feederConfig.getIni(iniText, 'RenoDX.MFGUnlock', 'RuntimeSelectionMode') || 0);
    const isOff = enabled === '0' || enabled === 'false';
    const mult = isOff ? 1 : ([2, 3, 4].includes(forceMult) ? forceMult : 3);
    return {
      installed: !isOff,
      backend: 'renodx-mfgunlock',
      backendName: MFG_UNLOCKERS.renodxAddon.name,
      mode: isOff ? 'off' : `x${mult}`,
      multiplier: mult,
      settings: {
        enabled: !isOff,
        forceMultiplier: mult,
        temporalFix,
        qualityGuardMode: qualityGuard,
        runtimeSelectionMode: runtimeSelection
      }
    };
  }

  if (fs.existsSync(asiFile)) {
    let mult = 3;
    let enabled = true;
    if (fs.existsSync(universalJson)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(universalJson, 'utf8'));
        if (cfg.enabled === false) enabled = false;
        if ([2, 3, 4].includes(Number(cfg.multiplier || cfg.forceMultiplier))) {
          mult = Number(cfg.multiplier || cfg.forceMultiplier);
        }
      } catch {}
    } else if (fs.existsSync(optiIni)) {
      const text = feederConfig.readText(optiIni);
      const fm = Number(feederConfig.getIni(text, 'MfgUnlock', 'ForceMultiplier') || 3);
      if ([2, 3, 4].includes(fm)) mult = fm;
      if (feederConfig.getIni(text, 'MfgUnlock', 'Enabled') === 'false') enabled = false;
    }
    return {
      installed: enabled,
      backend: 'mfg-unlocker-asi',
      backendName: MFG_UNLOCKERS.asiPlugin.name,
      mode: enabled ? `x${mult}` : 'off',
      multiplier: enabled ? mult : 1,
      settings: { enabled, forceMultiplier: mult, temporalFix: true }
    };
  }

  return { installed: false, backend: null, backendName: null, mode: 'off', multiplier: 1, settings: {} };
}

// 全面扫描游戏的 MFG 状态、DLSS-G 版本、Streamline 组件、GPU 兼容性与实际生效倍率
async function inspectGameMfgStatus(gameDir, {
  payloadDir,
  gpuName = 'NVIDIA GeForce RTX 4070 Laptop GPU',
  driverVersion = '617.42'
} = {}) {
  const scan = await scanGame(gameDir);
  const exePath = scan.chosen ? scan.chosen.path : null;
  const exeDir = exePath ? path.dirname(exePath) : gameDir;

  const gpuSupport = evaluateMfgGpuSupport(gpuName, driverVersion);

  // 查找游戏中的 nvngx_dlssg.dll
  const dlssgFiles = scan.dlssFiles.filter((f) => /^nvngx_dlssg\.dll$/i.test(f.name));
  const exeDlssg = path.join(exeDir, 'nvngx_dlssg.dll');
  const primaryDlssgPath = fs.existsSync(exeDlssg)
    ? exeDlssg
    : (dlssgFiles[0] ? dlssgFiles[0].path : null);
  const dlssgCheck = inspectDlssgBinary(primaryDlssgPath);

  // 查找 Streamline 组件
  const slInterposer = scan.streamlineFiles.find((f) => /^sl\.interposer\.dll$/i.test(f.name)) ||
    (fs.existsSync(path.join(exeDir, 'sl.interposer.dll')) ? {
      path: path.join(exeDir, 'sl.interposer.dll'),
      name: 'sl.interposer.dll',
      version: pe.getFileVersion(path.join(exeDir, 'sl.interposer.dll'))
    } : null);
  const slDlssg = scan.streamlineFiles.find((f) => /^sl\.dlss_g\.dll$/i.test(f.name)) ||
    (fs.existsSync(path.join(exeDir, 'sl.dlss_g.dll')) ? {
      path: path.join(exeDir, 'sl.dlss_g.dll'),
      name: 'sl.dlss_g.dll',
      version: pe.getFileVersion(path.join(exeDir, 'sl.dlss_g.dll'))
    } : null);
  const slReflex = scan.streamlineFiles.find((f) => /^sl\.reflex\.dll$/i.test(f.name)) ||
    (fs.existsSync(path.join(exeDir, 'sl.reflex.dll')) ? {
      path: path.join(exeDir, 'sl.reflex.dll'),
      name: 'sl.reflex.dll',
      version: pe.getFileVersion(path.join(exeDir, 'sl.reflex.dll'))
    } : null);

  const streamlineStatus = {
    present: Boolean(slInterposer || slDlssg),
    interposerVersion: slInterposer ? slInterposer.version : null,
    dlssgPluginVersion: slDlssg ? slDlssg.version : null,
    reflexPluginVersion: slReflex ? slReflex.version : null,
    filesCount: scan.streamlineFiles.length
  };

  const currentConfig = readCurrentMfgConfiguration(exeDir);
  const conflicts = detectMfgInjectorConflicts(gameDir, exeDir, scan);
  const runtimeVerification = verifyMfgRuntimeStatus(gameDir, exeDir);

  // 匹配已知实测游戏条目
  const gameTitle = path.basename(gameDir);
  const exeName = exePath ? path.basename(exePath) : '';
  const knownGame = TESTED_MFG_GAMES.find((g) => g.pattern.test(gameTitle) || g.pattern.test(exeName)) || null;

  // 计算当前游戏的兼容性状态徽章（严守原则：未经测试实际生效绝不标为“已验证可用”）
  let status = 'untested';
  let statusBadge = '尚未测试';
  if (!gpuSupport.hardwareOpticalFlow || conflicts.some((c) => c.severity === 'error')) {
    status = 'incompatible';
    statusBadge = '不兼容';
  } else if (runtimeVerification.verifiedActive) {
    status = 'verified';
    statusBadge = '已验证可用';
  } else if (currentConfig.mode === 'x2' && dlssgCheck.valid && gpuSupport.nativeX2) {
    status = 'verified';
    statusBadge = '已验证可用 (原生 x2)';
  } else if (currentConfig.installed || knownGame || (dlssgCheck.valid && streamlineStatus.present)) {
    status = 'experimental';
    statusBadge = '实验性支持';
  }

  return {
    ok: Boolean(scan.chosen),
    gameDir,
    gameName: gameTitle,
    exePath,
    exeDir,
    api: scan.chosen ? scan.chosen.apiLabel : null,
    bitness: scan.chosen ? scan.chosen.bitness : null,
    gpuSupport,
    dlssg: dlssgCheck,
    streamline: streamlineStatus,
    currentConfig,
    effectiveMultiplier: runtimeVerification.effectiveMultiplier
      ? `x${runtimeVerification.effectiveMultiplier} (已验证生效)`
      : (currentConfig.installed ? `${currentConfig.mode} (待进入游戏验证)` : '未启用 (1x)'),
    runtimeVerification,
    conflicts,
    knownGame,
    hasBackup: scan.hasBackup,
    status,
    statusBadge,
    unlockers: MFG_UNLOCKERS
  };
}

// 自动配置并安装/更新 MFG 模式 (Off / x2 / x3 / x4)，所有修改均纳入 _DLSS5_Backup 事务，支持一键恢复
async function applyMfgConfiguration(gameDir, options = {}, onLog = () => {}) {
  const {
    mode = 'off', // 'off' | 'x2' | 'x3' | 'x4'
    backend = 'auto', // 'auto' | 'renodx-mfgunlock' | 'mfg-unlocker-asi'
    upgradeDlssg = true, // 是否自动将旧版或缺失的 nvngx_dlssg.dll 升级至 310.9.1 / 310.9.16
    runtimeStack = 'baseline-310.9.1', // 'baseline-310.9.1' | 'oct2026-310.9.16'
    hdrCompatibility = false, // 是否开启 Automatic Guard + UI Composition (HDR 修复)
    payloadDir
  } = options;

  if (!['off', 'x2', 'x3', 'x4'].includes(mode)) {
    throw Object.assign(new Error(`无效的 MFG 模式: ${mode}`), { code: 'errInvalidMfgMode' });
  }

  const scan = await scanGame(gameDir);
  if (!scan.chosen) throw Object.assign(new Error('未在游戏目录中找到可执行文件'), { code: 'errNoExe' });
  const exePath = scan.chosen.path;
  const exeDir = path.dirname(exePath);
  const bitness = scan.chosen.bitness || 64;

  if (bitness !== 64) {
    throw Object.assign(new Error('NVIDIA DLSS-G 多帧生成仅支持 64 位游戏'), { code: 'errMfgBitness' });
  }
  if (!apply.canWrite(gameDir) || !apply.canWrite(exeDir)) {
    throw Object.assign(new Error('游戏目录无写入权限'), { code: 'errNoWriteAccess' });
  }

  return journal.transaction(gameDir, async () => {
    const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
    const addonDest = path.join(exeDir, 'renodx-mfgunlock.addon64');
    const asiDest = path.join(exeDir, 'OptiScaler', 'plugins', 'MFGUnlocker.asi');
    const jsonDest = path.join(exeDir, 'RTXMFG-Universal.json');
    const reshadeIniPath = path.join(exeDir, 'ReShade.ini');
    const optiIniPath = path.join(exeDir, 'OptiScaler.ini');

    // 当选择 Off 时，移除已安装的 MFG 解锁插件并清理配置项
    if (mode === 'off') {
      for (const target of [addonDest, asiDest, jsonDest]) {
        if (fs.existsSync(target)) {
          await journal.capture(gameDir, target);
          await fs.promises.chmod(target, 0o666).catch(() => {});
          await fs.promises.unlink(target);
          onLog({ code: 'mfgComponentRemoved', params: { file: path.basename(target) } });
        }
      }
      if (fs.existsSync(reshadeIniPath)) {
        let iniText = feederConfig.readText(reshadeIniPath);
        iniText = feederConfig.setIni(iniText, 'RenoDX.MFGUnlock', 'Enabled', '0');
        await apply.writeTracked(manifest, gameDir, reshadeIniPath, iniText, { kind: 'config' });
      }
      if (fs.existsSync(optiIniPath)) {
        let optiText = feederConfig.readText(optiIniPath);
        optiText = feederConfig.setIni(optiText, 'MfgUnlock', 'Enabled', 'false');
        await apply.writeTracked(manifest, gameDir, optiIniPath, optiText, { kind: 'config' });
      }
      manifest.mfg = { mode: 'off', multiplier: 1, backend: null, updatedAt: new Date().toISOString() };
      await apply.saveActiveManifest(gameDir, manifest);
      return { ok: true, mode: 'off', multiplier: 1, backend: null };
    }

    // 检查是否存在严重冲突（如 dlssg-to-fsr3）
    const conflicts = detectMfgInjectorConflicts(gameDir, exeDir, scan);
    const fatalConflict = conflicts.find((c) => c.severity === 'error');
    if (fatalConflict) {
      throw Object.assign(new Error(fatalConflict.message), { code: fatalConflict.code, conflicts });
    }

    const multiplier = Number(mode.slice(1)); // 2, 3, 4
    const isOptiRoute = manifest.route === 'optiscaler' || Boolean(scan.install?.optiscaler?.installed) ||
      (fs.existsSync(optiIniPath) && !fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')));
    const selectedBackend = backend === 'auto'
      ? (isOptiRoute ? 'mfg-unlocker-asi' : 'renodx-mfgunlock')
      : backend;

    // 1. 确保游戏具备支持 x2/x3/x4 的正版 nvngx_dlssg.dll (310.9.1 或 310.9.16) 及匹配的 sl.dlss_g.dll (2.14.16)
    const effectivePayloadDir = [
      payloadDir,
      process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, '..', 'payload') : null,
      process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'payload') : null,
      'E:\\DLSS5-Swapper-Enhanced\\payload'
    ].find((d) => d && fs.existsSync(path.join(d, MFG_UNLOCKERS.renodxAddon.relPath))) || payloadDir;

    if (upgradeDlssg && effectivePayloadDir) {
      const srcDlssg = runtimeStack === 'oct2026-310.9.16'
        ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16', 'nvngx_dlssg.dll')
        : path.join(effectivePayloadDir, 'streamline', 'nvngx_dlssg.dll');

      if (fs.existsSync(srcDlssg)) {
        const dlssgTargets = scan.dlssFiles
          .filter((f) => /^nvngx_dlssg\.dll$/i.test(f.name) && f.bitness === 64)
          .map((f) => f.path);
        if (!dlssgTargets.length) dlssgTargets.push(path.join(exeDir, 'nvngx_dlssg.dll'));

        for (const dest of dlssgTargets) {
          await apply.copyTracked(manifest, gameDir, srcDlssg, dest, {
            kind: 'runtime',
            newVersion: pe.getFileVersion(srcDlssg)
          });
          onLog({
            code: 'mfgDlssgPrepared',
            params: { rel: path.relative(gameDir, dest), version: pe.getFileVersion(srcDlssg) }
          });
        }
      }

      // 实机验证证明：将 sl.dlss_g.dll 同步升级至 2.14.16.0 可激活完整 Dynamic MFG (ngxEvaluateCalls 真实插帧)
      const srcSlDlssg = runtimeStack === 'oct2026-310.9.16'
        ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16', 'sl.dlss_g.dll')
        : path.join(effectivePayloadDir, 'streamline', 'sl.dlss_g.dll');
      if (fs.existsSync(srcSlDlssg)) {
        const slDlssgTargets = scan.streamlineFiles
          .filter((f) => /^sl\.dlss_g\.dll$/i.test(f.name))
          .map((f) => f.path);
        if (!slDlssgTargets.length && fs.existsSync(path.join(exeDir, 'sl.dlss_g.dll'))) {
          slDlssgTargets.push(path.join(exeDir, 'sl.dlss_g.dll'));
        }
        for (const dest of slDlssgTargets) {
          await apply.copyTracked(manifest, gameDir, srcSlDlssg, dest, {
            kind: 'streamline',
            newVersion: pe.getFileVersion(srcSlDlssg)
          });
        }
      }
    }

    // 2. 根据所选后端部署 MFG 解锁器与配置文件
    if (selectedBackend === 'renodx-mfgunlock') {
      const srcAddon = effectivePayloadDir ? path.join(effectivePayloadDir, MFG_UNLOCKERS.renodxAddon.relPath) : null;
      if (!srcAddon || !fs.existsSync(srcAddon)) {
        throw Object.assign(new Error('未找到内置 renodx-mfgunlock.addon64 组件载荷'), { code: 'errMfgPayloadMissing' });
      }
      // 校验 SHA-256 指纹
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(srcAddon)).digest('hex');
      if (actualHash !== MFG_UNLOCKERS.renodxAddon.sha256) {
        throw Object.assign(new Error('renodx-mfgunlock.addon64 SHA-256 校验不匹配'), { code: 'errMfgHashMismatch' });
      }

      // 若之前存在 ASI 版，先清理避免双钩子冲突
      for (const stale of [asiDest, jsonDest]) {
        if (fs.existsSync(stale)) {
          await journal.capture(gameDir, stale);
          await fs.promises.unlink(stale).catch(() => {});
        }
      }

      // 确保 ReShade (Addon 支持版) 已安装在游戏目录
      const reshadeCheck = scan.reshade;
      if (!reshadeCheck || !reshadeCheck.installed || !reshadeCheck.addonSupport) {
        const bundledReshade = effectivePayloadDir ? path.join(effectivePayloadDir, 'reshade-vulkan', 'ReShade64.dll') : null;
        if (bundledReshade && fs.existsSync(bundledReshade)) {
          const hookFile = path.join(exeDir, 'dxgi.dll');
          const hookExisted = fs.existsSync(hookFile);
          await apply.copyTracked(manifest, gameDir, bundledReshade, hookFile, { kind: 'reshade' });
          manifest.reshade.installedByUs = !hookExisted;
          manifest.reshade.file = 'dxgi.dll';
          onLog({ code: 'reshadeInstalled', params: { version: pe.getFileVersion(hookFile), file: 'dxgi.dll', bitness: 64 } });
        }
      }

      // 部署 renodx-mfgunlock.addon64 与开源许可证
      await apply.copyTracked(manifest, gameDir, srcAddon, addonDest, {
        kind: 'addon',
        newVersion: MFG_UNLOCKERS.renodxAddon.version
      });
      const licenseSrc = effectivePayloadDir ? path.join(effectivePayloadDir, 'enhanced', 'mfg', 'licenses', 'MFGAdaUnlock-RenoDx-LICENSE.txt') : null;
      if (licenseSrc && fs.existsSync(licenseSrc)) {
        await apply.copyTracked(manifest, gameDir, licenseSrc, path.join(exeDir, 'MFGAdaUnlock-RenoDx-LICENSE.txt'), { kind: 'license' });
      }

      // 检测是否同时安装了 DLSS 5 (renodx-dlss5.addon64)，若同时存在则开启 RuntimeSelectionMode=1 (LoadFromDllMain)
      const hasDlss5Consumer = fs.existsSync(path.join(exeDir, 'renodx-dlss5.addon64')) ||
        fs.existsSync(path.join(exeDir, 'renodx-dlss.addon64'));

      let iniText = feederConfig.readText(reshadeIniPath);
      const settingsPairs = [
        ['RenoDX.MFGUnlock', 'Enabled', '1'],
        ['RenoDX.MFGUnlock', 'MaxCount', '4'],
        ['RenoDX.MFGUnlock', 'ForceMultiplier', String(multiplier)],
        ['RenoDX.MFGUnlock', 'TemporalFix', '1'],
        ['RenoDX.MFGUnlock', 'BlackwellFrameworkKernels', '1'],
        ['RenoDX.MFGUnlock', 'IntermediateScatterRetention', '1'],
        ['RenoDX.MFGUnlock', 'ValidatedWarpBlend', '1'],
        ['RenoDX.MFGUnlock', 'BoundaryArtifactMitigationMode', '1'],
        ['RenoDX.MFGUnlock', 'QualityGuardMode', hdrCompatibility ? '2' : '0'],
        ['RenoDX.MFGUnlock', 'RuntimeSelectionMode', hasDlss5Consumer ? '1' : '0']
      ];
      for (const [sec, key, val] of settingsPairs) {
        iniText = feederConfig.setIni(iniText, sec, key, val);
      }
      await apply.writeTracked(manifest, gameDir, reshadeIniPath, iniText, { kind: 'config' });
      await apply.enableAddonInIni(exeDir, 'renodx-mfgunlock.addon64', (code, params) => onLog({ code, params }), gameDir, manifest);
      onLog({ code: 'mfgConfigured', params: { backend: 'renodx-mfgunlock', mode, multiplier } });
    } else {
      // 部署 MFG-Unlocker (OptiScaler ASI 插件模式)
      const srcAsi = effectivePayloadDir ? path.join(effectivePayloadDir, MFG_UNLOCKERS.asiPlugin.relPath) : null;
      if (!srcAsi || !fs.existsSync(srcAsi)) {
        throw Object.assign(new Error('未找到内置 MFGUnlocker.dll 组件载荷'), { code: 'errMfgPayloadMissing' });
      }
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(srcAsi)).digest('hex');
      if (actualHash !== MFG_UNLOCKERS.asiPlugin.sha256) {
        throw Object.assign(new Error('MFGUnlocker.dll SHA-256 校验不匹配'), { code: 'errMfgHashMismatch' });
      }

      if (fs.existsSync(addonDest)) {
        await journal.capture(gameDir, addonDest);
        await fs.promises.unlink(addonDest).catch(() => {});
      }

      await apply.copyTracked(manifest, gameDir, srcAsi, asiDest, {
        kind: 'optiscaler-plugin',
        newVersion: MFG_UNLOCKERS.asiPlugin.version
      });
      const licenseSrc = effectivePayloadDir ? path.join(effectivePayloadDir, 'enhanced', 'mfg', 'licenses', 'MFG-Unlocker-LICENSE.txt') : null;
      if (licenseSrc && fs.existsSync(licenseSrc)) {
        await apply.copyTracked(manifest, gameDir, licenseSrc, path.join(exeDir, 'OptiScaler', 'licenses', 'MFG-Unlocker-LICENSE.txt'), { kind: 'license' });
      }

      const universalConfig = JSON.stringify({
        enabled: true,
        multiplier,
        forceMultiplier: multiplier,
        maxCount: 4,
        temporalFix: true,
        logTelemetry: true
      }, null, 2);
      await apply.writeTracked(manifest, gameDir, jsonDest, universalConfig, { kind: 'config' });

      if (fs.existsSync(optiIniPath)) {
        let optiText = feederConfig.readText(optiIniPath);
        optiText = feederConfig.setIni(optiText, 'Plugins', 'LoadAsiPlugins', 'true');
        optiText = feederConfig.setIni(optiText, 'MfgUnlock', 'Enabled', 'true');
        optiText = feederConfig.setIni(optiText, 'MfgUnlock', 'ForceMultiplier', String(multiplier));
        optiText = feederConfig.setIni(optiText, 'MfgUnlock', 'TemporalFix', 'true');
        await apply.writeTracked(manifest, gameDir, optiIniPath, optiText, { kind: 'config' });
      }
      onLog({ code: 'mfgConfigured', params: { backend: 'mfg-unlocker-asi', mode, multiplier } });
    }

    manifest.mfg = {
      mode,
      multiplier,
      backend: selectedBackend,
      runtimeStack,
      hdrCompatibility: Boolean(hdrCompatibility),
      updatedAt: new Date().toISOString()
    };
    await apply.saveActiveManifest(gameDir, manifest);

    return {
      ok: true,
      mode,
      multiplier,
      backend: selectedBackend,
      runtimeStack,
      // 安装完成时尚未进入游戏运行，故标记为 experimental (待游戏运行时验证生效)
      status: mode === 'x2' ? 'verified' : 'experimental',
      statusBadge: mode === 'x2' ? '已验证可用 (原生 x2)' : '实验性支持 (待进入游戏验证)'
    };
  });
}

module.exports = {
  MFG_UNLOCKERS,
  TESTED_MFG_GAMES,
  evaluateMfgGpuSupport,
  inspectDlssgBinary,
  detectMfgInjectorConflicts,
  verifyMfgRuntimeStatus,
  readCurrentMfgConfiguration,
  inspectGameMfgStatus,
  applyMfgConfiguration
};
