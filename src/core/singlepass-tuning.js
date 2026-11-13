'use strict';
// 单层 DLSS 5 (NRPasses=1) 画质强化与显卡降开销调优引擎 (v2.3.2)
// 核心设计目标：
// 1. 严守单层神经渲染 (NRPasses=1)，绝不开启多层叠加 (2x/3x/4x)，杜绝双倍/三倍 Tensor Core 推理耗时与显存暴涨；
// 2. 深度挖掘 RenoDX DLSS 5 (v8.5.0-rc10) 单层内生结构重塑 (NRLocalStructure + NRSkinIndependent=0)、
//    局部光影立体感 (NRLocalTone)、总强度 (NRIntensity) 以及零额外 NGX 通道的实时塑形管线 (NRLookMode=1:
//    NRLookDetail 精细微表面细节、NRLookTone 大尺度光影对比、NRLookColour 色彩饱满度、NRDetailStability 时域抗闪烁)；
// 3. 同步联动降低内部神经工作分辨率 (NRResolutionScale + NRLookUpsample=1 边缘感知上采样) 与 Feeder 工作分辨率
//    (work_resolution + work_upscale + work_sharpness + hold_strength) 及光流着色器开销档位，支持免重装毫秒级热更新。

const fs = require('fs');
const path = require('path');
const feederConfig = require('./feeder-config');
const backends = require('./backend-manager');
const apply = require('./apply');
const { scanGame } = require('./scan');

const PRESET_ORDER = ['boost_eco', 'ultra_eco', 'ultra_vivid', 'standard', 'custom'];

// 四套官方调优预设（全部锁定 NRPasses = 1）
const SINGLE_PASS_PRESETS = Object.freeze({
  boost_eco: Object.freeze({
    id: 'boost_eco',
    label: '🔥 单层强效 · 省卡推荐',
    shortLabel: '单层强效·省卡',
    badge: '推荐甜点 · 算力 -44%',
    description: '一层 DLSS 5 激活微结构重塑 (1.30x) + 零额外通道精细细节塑形 (1.35x) + 局部光影立体感 (1.22x)，同时将神经与馈送工作分辨率锁定为精准 3/4 整数比 (75%) 配合边缘感知超分回拉与极速光流，画质显著增强且像素推理开销直降约 44%。',
    intensity: 1.35,
    structure: 1.30,
    localTone: 1.22,
    lookEnabled: true,
    detailBoost: 1.35,
    toneBoost: 1.15,
    colorBoost: 1.08,
    nrStyle: 1,
    workResolution: 75,
    workUpscale: 1,
    sharpness: 0.35,
    holdStrength: 0.30,
    maxWorksets: 3,
    motionCost: 'fast'
  }),
  ultra_eco: Object.freeze({
    id: 'ultra_eco',
    label: '⚡ 极致省卡 · 高帧优先',
    shortLabel: '极致省卡高帧',
    badge: '像素算力 -55%',
    description: '面向 6GB/8GB 显卡、掌机或高刷电竞需求：将内部神经与馈送分辨率降至 67% + FSR1 锐化补偿 (0.45) + 2 工作集精简池 + 极速光流，像素推理负担降低约 55%，并叠加 1.30x 神经强度与 1.40x 细节补偿维持清晰度。',
    intensity: 1.30,
    structure: 1.25,
    localTone: 1.18,
    lookEnabled: true,
    detailBoost: 1.40,
    toneBoost: 1.12,
    colorBoost: 1.06,
    nrStyle: 1,
    workResolution: 67,
    workUpscale: 1,
    sharpness: 0.45,
    holdStrength: 0.40,
    maxWorksets: 2,
    motionCost: 'fast'
  }),
  ultra_vivid: Object.freeze({
    id: 'ultra_vivid',
    label: '💎 单层满血 · 极限质感',
    shortLabel: '单层满血强效',
    badge: '100% 满血单层',
    description: '面向算力与显存充裕的桌面显卡：保持 100% 原生工作分辨率，将单层神经总强度推至 1.55x、微结构重塑 1.45x、精细细节 1.45x、局部光影 1.35x，无需开启耗卡的 2 层叠加即可呈现浓郁次世代材质光影。',
    intensity: 1.55,
    structure: 1.45,
    localTone: 1.35,
    lookEnabled: true,
    detailBoost: 1.45,
    toneBoost: 1.22,
    colorBoost: 1.12,
    nrStyle: 1,
    workResolution: 100,
    workUpscale: 2,
    sharpness: 0.28,
    holdStrength: 0.25,
    maxWorksets: 6,
    motionCost: 'quality'
  }),
  standard: Object.freeze({
    id: 'standard',
    label: '⚖️ 原厂标准 · 默认基线',
    shortLabel: '原厂标准',
    badge: '1.0x 原厂基准',
    description: '恢复单层 DLSS 5 原厂默认混合强度 (1.00x)，关闭额外细节/色调塑形，并沿用当前硬件档位的基准工作分辨率。',
    intensity: 1.00,
    structure: 1.00,
    localTone: 1.00,
    lookEnabled: false,
    detailBoost: 1.00,
    toneBoost: 1.00,
    colorBoost: 1.00,
    nrStyle: 0,
    workResolution: null,
    workUpscale: 1,
    sharpness: 0.15,
    holdStrength: 0.00,
    maxWorksets: null,
    motionCost: 'balanced'
  })
});

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmtFloat(n) {
  const r = round2(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, '');
}

function defaultWorkResForProfile(hardwareProfile = 'rtx40_laptop') {
  return (hardwareProfile === 'rtx40_desktop' || hardwareProfile === 'rtx50_desktop') ? 100 : 75;
}

function defaultWorksetsForProfile(hardwareProfile = 'rtx40_laptop') {
  return (hardwareProfile === 'rtx40_desktop' || hardwareProfile === 'rtx50_desktop') ? 8 : 4;
}

// 计算单层调优带来的像素算力变化与感知画质增益指标
function computeTuningMetrics(normalized, hardwareProfile = 'rtx40_laptop') {
  const workRes = normalized.workResolution;
  const pixelRatio = (workRes / 100) ** 2;
  const pixelSavedPct = Math.max(0, Math.round((1 - pixelRatio) * 100));

  // 对比 1.0x 原厂单层的综合质感强化幅度（加权统计总强度、微结构、局部光影与精细细节塑形）
  const rawGain =
    (normalized.intensity - 1.0) * 0.42 +
    (normalized.structure - 1.0) * 0.28 +
    (normalized.localTone - 1.0) * 0.15 +
    (normalized.lookEnabled ? (normalized.detailBoost - 1.0) * 0.25 + (normalized.toneBoost - 1.0) * 0.10 : 0) +
    Math.max(0, normalized.sharpness - 0.15) * 0.20;
  const visualBoostPercent = Math.round(rawGain * 100);

  const baseProfileRes = defaultWorkResForProfile(hardwareProfile);
  const basePixelRatio = (baseProfileRes / 100) ** 2;
  const baseWorksets = defaultWorksetsForProfile(hardwareProfile);
  const worksetFactor = Math.min(1.15, Math.max(0.65, normalized.maxWorksets / baseWorksets));
  // 神经网络权重常驻约占 42%，动态张量缓冲与特征图约占 58%
  const vramScaleVsProfile = 0.42 + 0.58 * (pixelRatio / basePixelRatio) * worksetFactor;

  return {
    nrPasses: 1,
    nrResolutionScale: round2(workRes / 100),
    pixelRatio: round2(pixelRatio),
    pixelComputeSavedPercent: pixelSavedPct,
    visualBoostPercent,
    vramScaleVsProfile: round2(vramScaleVsProfile)
  };
}

// 归一化用户或预设传入的单层调优配置
function normalizeSinglePassTuning(input = {}, hardwareProfile = 'rtx40_laptop') {
  const rawPreset = typeof input === 'string' ? input : (input?.preset || 'boost_eco');
  const presetId = (rawPreset in SINGLE_PASS_PRESETS) ? rawPreset : (rawPreset === 'custom' ? 'custom' : 'boost_eco');
  const base = SINGLE_PASS_PRESETS[presetId] || SINGLE_PASS_PRESETS.boost_eco;
  const src = (typeof input === 'object' && input !== null) ? input : {};
  const isCustom = presetId === 'custom';

  const fallbackRes = base.workResolution !== null && base.workResolution !== undefined
    ? base.workResolution
    : defaultWorkResForProfile(hardwareProfile);
  const fallbackWorksets = base.maxWorksets !== null && base.maxWorksets !== undefined
    ? base.maxWorksets
    : defaultWorksetsForProfile(hardwareProfile);

  const intensity = round2(clampNum(isCustom ? src.intensity : (src.intensity ?? base.intensity), 0.50, 2.00, base.intensity));
  const structure = round2(clampNum(isCustom ? src.structure : (src.structure ?? base.structure), 0.50, 2.00, base.structure));
  const localTone = round2(clampNum(isCustom ? src.localTone : (src.localTone ?? base.localTone), 0.50, 2.00, base.localTone));
  const detailBoost = round2(clampNum(isCustom ? src.detailBoost : (src.detailBoost ?? base.detailBoost), 0.50, 2.00, base.detailBoost));
  const toneBoost = round2(clampNum(isCustom ? src.toneBoost : (src.toneBoost ?? base.toneBoost), 0.50, 2.00, base.toneBoost));
  const colorBoost = round2(clampNum(isCustom ? src.colorBoost : (src.colorBoost ?? base.colorBoost), 0.50, 2.00, base.colorBoost));

  const lookEnabled = src.lookEnabled !== undefined
    ? Boolean(src.lookEnabled)
    : (presetId === 'standard'
      ? (Math.abs(detailBoost - 1) > 0.01 || Math.abs(toneBoost - 1) > 0.01 || Math.abs(colorBoost - 1) > 0.01)
      : true);

  const workResolution = Math.round(clampNum(
    isCustom ? src.workResolution : (src.workResolution ?? fallbackRes),
    50,
    100,
    fallbackRes
  ));
  const feederWorkResolution = presetId === 'standard' && src.workResolution === undefined
    ? 100
    : workResolution;

  const rawUpscale = Math.round(clampNum(isCustom ? src.workUpscale : (src.workUpscale ?? base.workUpscale), 0, 2, base.workUpscale));
  const sharpness = round2(clampNum(isCustom ? src.sharpness : (src.sharpness ?? base.sharpness), 0.00, 1.00, base.sharpness));
  const holdStrength = round2(clampNum(isCustom ? src.holdStrength : (src.holdStrength ?? base.holdStrength), 0.00, 1.00, base.holdStrength));
  const nrStyle = Math.round(clampNum(isCustom ? src.nrStyle : (src.nrStyle ?? base.nrStyle), 0, 2, base.nrStyle));
  const maxWorksets = Math.round(clampNum(
    isCustom ? src.maxWorksets : (src.maxWorksets ?? fallbackWorksets),
    2,
    8,
    fallbackWorksets
  ));
  const validMotion = new Set(['fast', 'balanced', 'quality']);
  const motionCost = validMotion.has(src.motionCost) ? src.motionCost : base.motionCost;

  const normalized = {
    preset: presetId,
    presetLabel: isCustom ? '🎛️ 自定义专家调节' : base.label,
    presetBadge: isCustom ? '用户自定义' : base.badge,
    description: isCustom
      ? '使用自定义滑块精确控制单层 DLSS 5 神经重塑强度、精细细节补偿、内部工作分辨率与光流开销。'
      : base.description,
    nrPasses: 1,
    intensity,
    structure,
    localTone,
    lookEnabled,
    detailBoost,
    toneBoost,
    colorBoost,
    nrStyle,
    workResolution,
    feederWorkResolution,
    workUpscale: rawUpscale,
    sharpness,
    holdStrength,
    maxWorksets,
    motionCost
  };

  normalized.metrics = computeTuningMetrics(normalized, hardwareProfile);
  return normalized;
}

// 根据单层省卡参数动态估算神经渲染显存开销（当处于原厂标准档且未改分辨率时保持原值 100% 不变）
function estimateTunedNeuralOverheadMB(baseOverheadMB, tuning, hardwareProfile = 'rtx40_laptop') {
  if (!baseOverheadMB || baseOverheadMB <= 0 || !tuning) return baseOverheadMB;
  const norm = tuning.metrics ? tuning : normalizeSinglePassTuning(tuning, hardwareProfile);
  if (norm.preset === 'standard' && norm.workResolution === defaultWorkResForProfile(hardwareProfile)) {
    return baseOverheadMB;
  }
  return Math.max(260, Math.round(baseOverheadMB * norm.metrics.vramScaleVsProfile));
}

// 将单层强化与省卡参数写入 ReShade.ini 的 [RenoDX.DLSS5] 节（严守 NRPasses=1）
function applyTuningToConsumerIni(iniText, tuningInput, { hardwareProfile = 'rtx40_laptop', host = false } = {}) {
  const t = tuningInput?.metrics ? tuningInput : normalizeSinglePassTuning(tuningInput, hardwareProfile);
  let out = String(iniText || '');

  // 关键机制：当 structure > 1.0 时关闭 NRSkinIndependent (设为 0)，解除 RenoDX 对 NRLocalStructure <= 1.0 的截断，
  // 让单次 NGX Feature 18 推理直接输出更强的微表面几何凹凸质感。
  const skinIndependent = t.structure > 1.001 ? '0' : '1';
  const nrResScale = fmtFloat(t.workResolution / 100);

  const pairs = [
    ['RenoDX DLSS', 'NRPasses', '1'],
    ['RenoDX.DLSS5', 'ConfigVersion', '7'],
    ['RenoDX.DLSS5', 'NeuralUplift', '1'],
    ['RenoDX.DLSS5', 'NRPasses', '1'],
    ['RenoDX.DLSS5', 'NRIntensity', fmtFloat(t.intensity)],
    ['RenoDX.DLSS5', 'NRLocalStructure', fmtFloat(t.structure)],
    ['RenoDX.DLSS5', 'NRSkinIndependent', skinIndependent],
    ['RenoDX.DLSS5', 'NRLocalTone', fmtFloat(t.localTone)],
    ['RenoDX.DLSS5', 'NRStyle', String(t.nrStyle)],
    ['RenoDX.DLSS5', 'NRLookMode', t.lookEnabled ? '1' : '0'],
    ['RenoDX.DLSS5', 'NRLookStrength', '1'],
    ['RenoDX.DLSS5', 'NRLookDetail', fmtFloat(t.detailBoost)],
    ['RenoDX.DLSS5', 'NRLookTone', fmtFloat(t.toneBoost)],
    ['RenoDX.DLSS5', 'NRLookColour', fmtFloat(t.colorBoost)],
    ['RenoDX.DLSS5', 'NRChromaClamp', '1'],
    ['RenoDX.DLSS5', 'NRDetailStability', '0'],
    ['RenoDX.DLSS5', 'NRLookUpsample', '1'],
    ['RenoDX.DLSS5', 'NRFollowInputRes', '0'],
    ['RenoDX.DLSS5', 'NRResolutionScale', nrResScale],
    ['RenoDX.DLSS5', 'NRMaxWorksets', String(t.maxWorksets)],
    ['RenoDX.DLSS5', 'UiLanguage', 'zh-Hans']
  ];
  if (host) {
    pairs.push(['RenoDX.DLSS5', 'NRToggleKey', '0']);
  }

  for (const [sec, key, val] of pairs) {
    out = feederConfig.setIni(out, sec, key, val);
  }
  return out;
}

// 更新 dlss5-feed.cfg 内容（保留已有自定义键值，补齐/覆盖工作分辨率、上采样算法、锐化与静止防抖参数）
function applyTuningToFeedCfg(cfgText, tuningInput, hardwareProfile = 'rtx40_laptop') {
  const t = tuningInput?.metrics ? tuningInput : normalizeSinglePassTuning(tuningInput, hardwareProfile);
  const baseSeeded = feederConfig.configureFeed(cfgText || '');
  const updates = {
    work_resolution: String(t.feederWorkResolution ?? t.workResolution),
    work_upscale: String(t.workUpscale),
    work_sharpness: t.sharpness.toFixed(2),
    hold_strength: t.holdStrength.toFixed(2),
    hold_tolerance: '0.05'
  };

  const seen = new Set();
  const lines = baseSeeded.split(/\r?\n/).filter((line, idx, arr) => !(line === '' && idx === arr.length - 1));
  const updatedLines = lines.map((line) => {
    const m = line.match(/^\s*([^#;=]+?)\s*=\s*(.*)$/);
    if (!m) return line;
    const key = m[1].trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) updatedLines.push(`${k}=${v}`);
  }
  return updatedLines.join('\r\n') + '\r\n';
}

// 原子写入文件（确保游戏运行期间 Feeder 每 60 帧热重载或插件读取时绝不会读到半截文件）
function writeTextAtomicSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o666);
  } catch {}
  const tmpPath = `${filePath}.enh-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function parseIniNum(text, section, key) {
  const raw = feederConfig.getIni(text, section, key);
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function parseCfgNumber(text, key) {
  if (!text) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*([-+]?\\d*\\.?\\d+)\\s*$`, 'im');
  const m = String(text).match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function matchPresetFromValues(vals, hardwareProfile = 'rtx40_laptop') {
  for (const id of ['boost_eco', 'ultra_eco', 'ultra_vivid', 'standard']) {
    const ref = normalizeSinglePassTuning({ preset: id }, hardwareProfile);
    const same =
      Math.abs(vals.intensity - ref.intensity) <= 0.03 &&
      Math.abs(vals.structure - ref.structure) <= 0.03 &&
      Math.abs(vals.localTone - ref.localTone) <= 0.03 &&
      Boolean(vals.lookEnabled) === Boolean(ref.lookEnabled) &&
      (!ref.lookEnabled || Math.abs(vals.detailBoost - ref.detailBoost) <= 0.03) &&
      Math.abs(vals.workResolution - ref.workResolution) <= 2;
    if (same) return id;
  }
  return 'custom';
}

// 读取游戏目录当前生效的单层调优状态（兼容游戏内 Home 面板实时修改后的回读同步）
function inspectGameTuning(gameDir, { exeDir = null, bitness = null, hardwareProfile = 'rtx40_laptop' } = {}) {
  const manifest = backends.readManifest(gameDir);
  let resolvedExeDir = exeDir;
  if (!resolvedExeDir && manifest?.game?.exe) {
    resolvedExeDir = path.dirname(path.join(gameDir, manifest.game.exe));
  }
  if (!resolvedExeDir) resolvedExeDir = gameDir;

  const hostDir = path.join(resolvedExeDir, 'host64');
  const hasHost64 = bitness === 32 || fs.existsSync(path.join(hostDir, 'ReShade.ini')) || fs.existsSync(path.join(hostDir, 'dlss5-feed-host64.exe'));
  const consumerDir = hasHost64 ? hostDir : resolvedExeDir;
  const consumerIniPath = path.join(consumerDir, 'ReShade.ini');
  const feedCfgPath = path.join(resolvedExeDir, 'dlss5-feed.cfg');

  const hasConsumerIni = fs.existsSync(consumerIniPath);
  const hasFeedCfg = fs.existsSync(feedCfgPath);

  if (!hasConsumerIni && !hasFeedCfg) {
    if (manifest?.singlePassTuning) {
      return {
        installed: false,
        ...normalizeSinglePassTuning(manifest.singlePassTuning, hardwareProfile)
      };
    }
    return {
      installed: false,
      ...normalizeSinglePassTuning({ preset: 'boost_eco' }, hardwareProfile)
    };
  }

  const iniText = hasConsumerIni ? feederConfig.readText(consumerIniPath) : '';
  const cfgText = hasFeedCfg ? feederConfig.readText(feedCfgPath) : '';
  const saved = manifest?.singlePassTuning || null;

  const nrScaleRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRResolutionScale');
  const cfgWorkRes = parseCfgNumber(cfgText, 'work_resolution');
  const workResolution = nrScaleRaw !== null && nrScaleRaw >= 0.45 && nrScaleRaw <= 1.05
    ? Math.round(nrScaleRaw * 100)
    : (cfgWorkRes !== null ? Math.round(cfgWorkRes) : (saved?.workResolution ?? defaultWorkResForProfile(hardwareProfile)));

  const intensityRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRIntensity');
  const structureRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRLocalStructure');
  const localToneRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRLocalTone');
  const lookModeRaw = feederConfig.getIni(iniText, 'RenoDX.DLSS5', 'NRLookMode');
  const detailRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRLookDetail');
  const toneRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRLookTone');
  const colorRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRLookColour');
  const styleRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRStyle');
  const worksetsRaw = parseIniNum(iniText, 'RenoDX.DLSS5', 'NRMaxWorksets');

  const cfgUpscale = parseCfgNumber(cfgText, 'work_upscale');
  const cfgSharpness = parseCfgNumber(cfgText, 'work_sharpness');
  const cfgHold = parseCfgNumber(cfgText, 'hold_strength');

  // 检查游戏端 ReShade.ini 的光流着色器档位
  const gameIniText = fs.existsSync(path.join(resolvedExeDir, 'ReShade.ini'))
    ? feederConfig.readText(path.join(resolvedExeDir, 'ReShade.ini'))
    : iniText;
  const defs = String(feederConfig.getIni(gameIniText, 'GENERAL', 'PreprocessorDefinitions') || '');
  const provMatch = defs.match(/DLSS5_MV_PROVIDER\s*=\s*(\d+)/i);
  const liveProvider = provMatch ? Number(provMatch[1]) : null;

  const liveValues = {
    intensity: intensityRaw !== null && intensityRaw > 0 ? intensityRaw : (saved?.intensity ?? 1.0),
    structure: structureRaw !== null && structureRaw > 0 ? structureRaw : (saved?.structure ?? 1.0),
    localTone: localToneRaw !== null && localToneRaw > 0 ? localToneRaw : (saved?.localTone ?? 1.0),
    lookEnabled: lookModeRaw !== null ? (lookModeRaw === '1' || lookModeRaw === 'true') : Boolean(saved?.lookEnabled),
    detailBoost: detailRaw !== null && detailRaw > 0 ? detailRaw : (saved?.detailBoost ?? 1.0),
    toneBoost: toneRaw !== null && toneRaw > 0 ? toneRaw : (saved?.toneBoost ?? 1.0),
    colorBoost: colorRaw !== null && colorRaw > 0 ? colorRaw : (saved?.colorBoost ?? 1.0),
    nrStyle: styleRaw !== null && styleRaw >= 0 ? styleRaw : (saved?.nrStyle ?? 0),
    workResolution,
    workUpscale: cfgUpscale !== null ? Math.round(cfgUpscale) : (saved?.workUpscale ?? 1),
    sharpness: cfgSharpness !== null ? cfgSharpness : (saved?.sharpness ?? 0.15),
    holdStrength: cfgHold !== null ? cfgHold : (saved?.holdStrength ?? 0.0),
    maxWorksets: worksetsRaw !== null && worksetsRaw >= 2 ? worksetsRaw : (saved?.maxWorksets ?? defaultWorksetsForProfile(hardwareProfile)),
    motionCost: saved?.motionCost || (liveProvider === 3 ? 'quality' : 'fast')
  };

  const detectedPreset = matchPresetFromValues(liveValues, hardwareProfile);
  return {
    installed: true,
    ...normalizeSinglePassTuning({ ...liveValues, preset: detectedPreset }, hardwareProfile)
  };
}

// 免重装极速应用/热更新单层 DLSS 5 调优参数到目标游戏（同时支持游戏关闭与游戏正在运行时的实时热更新）
async function applyTuningToGame(gameDir, tuningInput = {}, options = {}) {
  const scan = options.scan || await scanGame(gameDir);
  if (!scan.chosen) {
    throw Object.assign(new Error('未在游戏目录中找到可执行文件'), { code: 'errNoExe' });
  }
  const exePath = scan.chosen.path;
  const exeDir = path.dirname(exePath);
  const bitness = scan.chosen.bitness || 64;
  const manifest = backends.readManifest(gameDir);
  const hardwareProfile = options.hardwareProfile || manifest?.hardwareProfile || 'rtx40_laptop';

  const normalized = normalizeSinglePassTuning(tuningInput, hardwareProfile);
  const hostDir = path.join(exeDir, 'host64');
  const hasHost64 = bitness === 32 ||
    fs.existsSync(path.join(hostDir, 'dlss5-feed-host64.exe')) ||
    fs.existsSync(path.join(hostDir, 'renodx-dlss5.addon64'));
  const consumerDir = hasHost64 ? hostDir : exeDir;

  const updatedFiles = [];

  // 1. 更新 64 位神经渲染消费者端 ReShade.ini (原生 64 位 exeDir 或 32 位游戏的 host64 目录)
  const consumerIniPath = path.join(consumerDir, 'ReShade.ini');
  const hasConsumerAddon = fs.existsSync(path.join(consumerDir, 'renodx-dlss5.addon64')) ||
    fs.existsSync(path.join(consumerDir, 'renodx-dlss.addon64')) ||
    fs.existsSync(consumerIniPath);
  if (hasConsumerAddon) {
    const currentIni = feederConfig.readText(consumerIniPath);
    const nextIni = applyTuningToConsumerIni(currentIni, normalized, {
      hardwareProfile,
      host: hasHost64
    });
    writeTextAtomicSync(consumerIniPath, nextIni);
    updatedFiles.push(path.relative(gameDir, consumerIniPath));
  }

  // 2. 若游戏使用了 Feeder 馈送管线，更新 dlss5-feed.cfg（Feeder 运行时每 60 帧自动热重载该文件）与光流着色器开销档位
  const hasFeeder = manifest?.route === 'feeder' ||
    fs.existsSync(path.join(exeDir, 'dlss5-feed.cfg')) ||
    fs.existsSync(path.join(exeDir, 'dlss5-feed.addon64')) ||
    fs.existsSync(path.join(exeDir, 'dlss5-feed.addon32'));

  if (hasFeeder) {
    const feedCfgPath = path.join(exeDir, 'dlss5-feed.cfg');
    const nextCfg = applyTuningToFeedCfg(feederConfig.readText(feedCfgPath), normalized, hardwareProfile);
    writeTextAtomicSync(feedCfgPath, nextCfg);
    updatedFiles.push(path.relative(gameDir, feedCfgPath));

    // 根据光流开销档位切换 vort_Motion.fx (provider=2，极速低开销) 与 LumeniteFX (provider=3，高精度金字塔光流)
    const hasLumeniteFx = bitness === 64 && fs.existsSync(path.join(exeDir, 'reshade-shaders', 'Shaders', 'lumenite_Kernel.fx'));
    const hasVortFx = fs.existsSync(path.join(exeDir, 'reshade-shaders', 'Shaders', 'vort_Motion.fx'));
    if (hasVortFx || hasLumeniteFx) {
      const targetProvider = (normalized.motionCost === 'fast' || !hasLumeniteFx) ? 2 : 3;
      const gameIniPath = path.join(exeDir, 'ReShade.ini');
      if (fs.existsSync(gameIniPath)) {
        let gameIni = feederConfig.configureGameReShade(feederConfig.readText(gameIniPath), targetProvider);
        if (!hasHost64 && hasConsumerAddon) {
          gameIni = applyTuningToConsumerIni(gameIni, normalized, { hardwareProfile, host: false });
        }
        writeTextAtomicSync(gameIniPath, gameIni);
        const relGameIni = path.relative(gameDir, gameIniPath);
        if (!updatedFiles.includes(relGameIni)) updatedFiles.push(relGameIni);

        let presetFile = feederConfig.presetPath(exeDir, gameIni);
        const presetRel = path.relative(gameDir, presetFile);
        if (presetRel.startsWith('..') || path.isAbsolute(presetRel)) {
          presetFile = path.join(exeDir, 'ReShadePreset.ini');
        }
        if (fs.existsSync(presetFile)) {
          const isXenia = Boolean(manifest?.game?.emulator && manifest.game.emulator.key === 'xenia');
          let nextPreset = feederConfig.configurePreset(feederConfig.readText(presetFile), targetProvider, { xenia: isXenia });
          // 在省卡/均衡模式下显式关闭多通道几何相机求解器 (GEOM_ENABLE=0)，进一步削减着色器帧耗时
          nextPreset = feederConfig.setIni(
            nextPreset,
            'DLSS5_Feed.fx',
            'GEOM_ENABLE',
            normalized.motionCost === 'quality' && !isXenia ? '1' : '0'
          );
          writeTextAtomicSync(presetFile, nextPreset);
          updatedFiles.push(path.relative(gameDir, presetFile));
        }
      }
    }
  }

  // 3. 若已有备份清单，持久化保存用户的单层调优配置以便下次打开面板精准还原且卸载时无残留
  if (manifest) {
    manifest.singlePassTuning = {
      preset: normalized.preset,
      intensity: normalized.intensity,
      structure: normalized.structure,
      localTone: normalized.localTone,
      lookEnabled: normalized.lookEnabled,
      detailBoost: normalized.detailBoost,
      toneBoost: normalized.toneBoost,
      colorBoost: normalized.colorBoost,
      nrStyle: normalized.nrStyle,
      workResolution: normalized.workResolution,
      workUpscale: normalized.workUpscale,
      sharpness: normalized.sharpness,
      holdStrength: normalized.holdStrength,
      maxWorksets: normalized.maxWorksets,
      motionCost: normalized.motionCost,
      updatedAt: new Date().toISOString()
    };
    for (const rel of updatedFiles) {
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const existsInReplaced = Array.isArray(manifest.replaced) &&
          manifest.replaced.some((r) => String(r.rel || '').toLowerCase() === rel.toLowerCase());
        const existsInAdded = Array.isArray(manifest.added) &&
          manifest.added.some((r) => String(r || '').toLowerCase() === rel.toLowerCase());
        if (!existsInReplaced && !existsInAdded) {
          manifest.added = Array.isArray(manifest.added) ? manifest.added : [];
          manifest.added.push(rel);
        }
      }
    }
    await apply.saveActiveManifest(gameDir, manifest);
  }

  return {
    ok: true,
    gameDir,
    hardwareProfile,
    updatedFiles,
    hotReloadSupported: true,
    tuning: {
      installed: updatedFiles.length > 0,
      ...normalized
    }
  };
}

module.exports = {
  PRESET_ORDER,
  SINGLE_PASS_PRESETS,
  normalizeSinglePassTuning,
  computeTuningMetrics,
  estimateTunedNeuralOverheadMB,
  applyTuningToConsumerIni,
  applyTuningToFeedCfg,
  inspectGameTuning,
  applyTuningToGame
};
