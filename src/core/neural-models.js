'use strict';
// 模块 A：最新 DLSS 5 神经渲染模型管理器 (Neural Rendering Manager)
// 负责识别 nvngx_dlssnr.dll、解析 CUDA Fatbin (0xBA55ED50) SM 架构、维护模型与 2026年10月运行时版本库、
// 校验 SHA-256 指纹、检测模型依赖、管理合法模型手动导入、执行版本切换、原版文件备份与一键回滚，并解析失败状态日志。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pe = require('./pe');
const journal = require('./file-journal');
const apply = require('./apply');
const { scanGame } = require('./scan');

// CUDA Fatbin 魔数头：0xBA55ED50 (小端序字节序列: 50 ED 55 BA 01 00 10 00)
const FATBIN_MAGIC = Buffer.from([0x50, 0xED, 0x55, 0xBA, 0x01, 0x00, 0x10, 0x00]);

// 缓存已扫描的 DLL 指纹与 CUDA Fatbin 架构信息，避免重复读取 165MB 大文件
const binaryInspectionCache = new Map();

// GPU 架构映射表：将显卡型号映射为 NVIDIA CUDA SM 架构编号与 NGX 硬件架构代号
function detectGpuArchitecture(gpuName) {
  const name = String(gpuName || '');
  if (/\bRTX\s*50\d{2}\b/i.test(name) || (/\bRTX\s*PRO\b/i.test(name) && /\bblackwell\b/i.test(name))) {
    return { family: 'Blackwell', code: 'blackwell', sm: '120', ngxArch: '0x1B0', series: 'RTX 50' };
  }
  if (/\bRTX\s*40\d{2}\b/i.test(name) || /\bAda\b/i.test(name) || /\bL40\b/i.test(name)) {
    return { family: 'Ada Lovelace', code: 'ada', sm: '89', ngxArch: '0x190', series: 'RTX 40' };
  }
  if (/\bRTX\s*30\d{2}\b/i.test(name) || /\bA\d000\b/i.test(name)) {
    return { family: 'Ampere', code: 'ampere', sm: '86', ngxArch: '0x170', series: 'RTX 30' };
  }
  if (/\bRTX\s*20\d{2}\b/i.test(name) || /\bTITAN\s*RTX\b/i.test(name)) {
    return { family: 'Turing', code: 'turing', sm: '75', ngxArch: '0x160', series: 'RTX 20' };
  }
  return { family: 'Unknown', code: 'unknown', sm: null, ngxArch: null, series: 'Unknown' };
}

// DLSS 5 神经渲染模型版本数据库 (包含 2026年9月首发系列与 2026年10月16日 310.9.16 更新模型)
const MODEL_DATABASE = Object.freeze([
  Object.freeze({
    id: '310.8.SF-v2',
    name: 'DLSS 5 NR 310.8.SF-v2 (Multi-Arch Ada/Ampere/Turing/Blackwell)',
    role: 'latest_compatible',
    version: '310.8.0.0',
    releaseDate: '2026-09-25',
    sha256: '8270b350cd82de5ce89806872cdd6b6a9249b80836b91bbeb3573470744cc206',
    size: 165840496,
    parameters: '148M',
    architectures: Object.freeze(['75', '86', '89', '120']),
    smCounts: Object.freeze({ '75': 15, '86': 15, '89': 15, '120': 23 }),
    bundled: false,
    rtx40Status: 'experimental',
    rtx40Badge: '静态架构匹配，尚未验证',
    sourceType: '用户提供；来源与许可需核查',
    description: '内置多架构兼容版 DLSS 5 神经渲染模型，包含 sm_75/86/89/120 完整 CUDA Fatbin 核函数，架构信息仅作参考，不代表运行验证或再分发授权。'
  }),
  Object.freeze({
    id: '310.9.16-oct2026',
    name: 'DLSS 5 NR 310.9.16 (2026-10-16 118M 2× Faster AI Model)',
    role: 'oct2026_faster',
    version: '310.9.16.0',
    releaseDate: '2026-10-16',
    sha256: null,
    size: null,
    parameters: '118M (2× 推理速度, -20% 显存占用)',
    architectures: Object.freeze(['120']),
    smCounts: Object.freeze({ '120': 23 }),
    bundled: false,
    rtx40Status: 'incompatible',
    rtx40Badge: '不兼容 (原厂仅 sm_120 / 待导入 sm_89 适配版)',
    sourceType: 'NVIDIA 2026-10-16 游戏/OTA 分发 (支持手动导入)',
    description: 'NVIDIA 于 2026年10月16日随 NBA 2K27 与 Streamline 2.14.16 发布的更新版 118M 神经渲染模型，推理速度提升 2 倍、显存降低约 20%。官方 GitHub SDK 未公开打包独立 nvngx_dlssnr.dll，且原厂版本仅含 sm_120 (RTX 50 Blackwell) 核函数；若后续获取包含 sm_89 的合法构建，可通过手动导入启用。'
  }),
  Object.freeze({
    id: '310.8.0-RTX40',
    name: 'DLSS 5 NR 310.8.0-RTX40 (Early Ada Lovelace Port)',
    role: 'legacy',
    version: '310.8.0.0',
    releaseDate: '2026-09-17',
    sha256: 'd2f76227f5bfaa1ff6fa2b7137b4b7561782235c04ce979873d7c3f01173b3a6',
    size: 165840496,
    parameters: '148M',
    architectures: Object.freeze(['89', '120']),
    smCounts: Object.freeze({ '89': 15, '120': 23 }),
    bundled: false,
    rtx40Status: 'experimental',
    rtx40Badge: '实验性支持',
    sourceType: '社区早期构建 (支持手动导入)',
    description: '早期针对 RTX 40 (sm_89) 移植的旧版神经渲染模型，已被包含完整多架构核函数的 310.8.SF-v2 取代，可作为 Legacy Model 手动导入切换。'
  }),
  Object.freeze({
    id: '310.8.SF',
    name: 'DLSS 5 NR 310.8.SF (ShortFuse v1 Multi-Arch)',
    role: 'legacy',
    version: '310.8.0.0',
    releaseDate: '2026-09-19',
    sha256: 'fb17b72bfdd92f7b1db91097d7f9f5d787344d399c70f642ceeb0427f8c66dc9',
    size: 165840496,
    parameters: '148M',
    architectures: Object.freeze(['75', '86', '89', '120']),
    smCounts: Object.freeze({ '75': 15, '86': 15, '89': 15, '120': 23 }),
    bundled: false,
    rtx40Status: 'experimental',
    rtx40Badge: '实验性支持',
    sourceType: '社区旧版构建 (支持手动导入)',
    description: 'ShortFuse v1 多架构神经渲染模型，支持 sm_75/86/89/120，属于 310.8.SF-v2 的前代 Legacy 模型。'
  }),
  Object.freeze({
    id: '310.8.Lecram',
    name: 'DLSS 5 NR 310.8.Lecram (Blackwell sm_120 Only)',
    role: 'legacy_blackwell',
    version: '310.8.0.0',
    releaseDate: '2026-09-24',
    sha256: 'a9095b37ccba8447bd8d9db1b82bf7eb17c2f342ff977e0807474e538101c227',
    size: 127702688,
    parameters: '148M',
    architectures: Object.freeze(['120']),
    smCounts: Object.freeze({ '120': 23 }),
    bundled: false,
    rtx40Status: 'incompatible',
    rtx40Badge: '不兼容',
    sourceType: '社区构建 (仅 RTX 50)',
    description: '仅包含 sm_120 (RTX 50 Blackwell) CUDA Fatbin 核函数，在 RTX 4070 Laptop 上运行会触发 feature 18 create failed with 0xbad00001。'
  }),
  Object.freeze({
    id: '310.8.0-stock',
    name: 'DLSS 5 NR 310.8.0 Official Stock (Blackwell sm_120 Only)',
    role: 'stock_blackwell',
    version: '310.8.0.0',
    releaseDate: '2026-09-10',
    sha256: null,
    size: 127702688,
    parameters: '148M',
    architectures: Object.freeze(['120']),
    smCounts: Object.freeze({ '120': 23 }),
    bundled: false,
    rtx40Status: 'incompatible',
    rtx40Badge: '不兼容',
    sourceType: 'NVIDIA 2026-09 首发原厂构建 (仅 RTX 50)',
    description: 'NVIDIA 2026年9月首发原厂 FP8 神经渲染模型，仅包含 sm_120 (RTX 50 Blackwell)，不支持 RTX 40 系列。'
  })
]);

// 可选的 NGX / Streamline / Feeder 运行时组件栈
const RUNTIME_STACKS = Object.freeze([
  Object.freeze({
    id: 'baseline-310.9.1',
    name: 'DLSS 310.9.1 + Streamline 2.13.0 + Feeder 1.17.0 (默认稳定栈)',
    dlssVersion: '310.9.1.0',
    dlssgVersion: '310.9.1.0',
    streamlineVersion: '2.13.0.0',
    feederVersion: '1.17.0',
    renodxVersion: '8.5.0-rc10',
    status: 'experimental',
    badge: '历史参考栈，尚未验证',
    description: 'v2.2.9 基准验证运行时栈，配备升级版 RenoDX DLSS 5 (v8.5.0-rc10)，与内置 F8 游戏内嵌面板 (Overlay) 二进制指纹完全匹配。'
  }),
  Object.freeze({
    id: 'oct2026-310.9.16',
    name: 'DLSS 310.9.16 + Streamline 2.14.16.0 + Feeder 1.19.0 (2026-10-16 最新运行时栈)',
    dlssVersion: '310.9.16.0',
    dlssgVersion: '310.9.16.0',
    streamlineVersion: '2.14.16.0',
    feederVersion: '1.19.0',
    renodxVersion: '8.5.0-rc10',
    status: 'experimental',
    badge: '实验性支持',
    description: '2026年10月16日 NVIDIA 发布的最新 NGX 310.9.16 与 Streamline 2.14.16.0 运行时，搭配 DLSS5-Feeder 1.19.0 与 RenoDX DLSS 5 v8.5.0-rc10。'
  })
]);

function resolvePayloadDir(payloadDir) {
  return payloadDir || process.env.DLSS5_ENHANCED_PAYLOAD_DIR || path.resolve(__dirname, '..', '..', 'payload');
}

// 扫描二进制缓冲区中的 CUDA Fatbin (0xBA55ED50) 容器，提取内嵌的 SM 架构与核函数计数
function scanBufferArchitectures(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    return { architectures: [], smCounts: {}, containerCount: 0 };
  }
  const smCounts = {};
  let containerCount = 0;
  let pos = 0;
  while ((pos = buf.indexOf(FATBIN_MAGIC, pos)) !== -1) {
    if (pos + 16 > buf.length) break;
    const totalSize = Number(buf.readBigUInt64LE(pos + 8));
    if (totalSize > 0 && totalSize < 64 * 1024 * 1024 && pos + 16 + totalSize <= buf.length) {
      containerCount++;
      let cur = pos + 16;
      const end = pos + 16 + totalSize;
      while (cur + 64 <= end) {
        const kind = buf.readUInt16LE(cur);
        const hdrSize = buf.readUInt32LE(cur + 4);
        const payloadSize = Number(buf.readBigUInt64LE(cur + 8));
        const sm = buf.readUInt32LE(cur + 28);
        if ((kind === 1 || kind === 2) && hdrSize >= 64 && payloadSize > 0 && cur + hdrSize + payloadSize <= end) {
          const key = String(sm);
          smCounts[key] = (smCounts[key] || 0) + 1;
          cur += hdrSize + payloadSize;
        } else {
          break;
        }
      }
    }
    pos += 8;
  }
  const architectures = Object.keys(smCounts).sort((a, b) => Number(a) - Number(b));
  return { architectures, smCounts, containerCount };
}

// 识别 NGX DLL 的真实功能类型，严格防止将 DLSS SR / RR / FG 误认为 DLSS 5 神经渲染模型
function identifyNgxBuffer(buf, filePath = '') {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) {
    return { validPe: false, kind: 'invalid', reason: '文件过小或无法读取' };
  }
  // 检查 MZ 与 PE 签名
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) {
    return { validPe: false, kind: 'not_pe', reason: '不是有效的 Windows PE 二进制文件' };
  }
  const hasAscii = (str) => buf.includes(Buffer.from(str, 'latin1'));
  const hasUtf16 = (str) => buf.includes(Buffer.from(str, 'utf16le'));
  const hasMarker = (str) => hasAscii(str) || hasUtf16(str);

  // 检查是否包含 DLSS 5 神经渲染特有的内部符号与 PDB 标识
  const hasDlssNrPdb = hasAscii('nvngx_dlssnr.pdb');
  const hasDlssNrCallbacks = hasAscii('DLSSNRGetStatsCallback') || hasAscii('DLSSNRComputeScalingRatioCallback');
  const hasDlssNrFeaturePath = hasAscii('source/features/dlssnr/') || hasMarker('NVSDK_NGX_D3D12_DLSSNR') || hasMarker('dlssnr');

  // 检查是否为传统 Super Resolution、Ray Reconstruction 或 Frame Generation
  const hasDlssSrPdb = hasAscii('nvngx_dlss.pdb');
  const hasDlssRrPdb = hasAscii('nvngx_dlssd.pdb');
  const hasDlssFgPdb = hasAscii('nvngx_dlssg.pdb');

  if (hasDlssSrPdb && !hasDlssNrCallbacks) {
    return {
      validPe: true,
      kind: 'dlss_sr',
      isNeuralRendering: false,
      reason: '该文件实际为传统 DLSS Super Resolution (nvngx_dlss.dll)，而非 DLSS 5 神经渲染模型'
    };
  }
  if (hasDlssRrPdb && !hasDlssNrCallbacks) {
    return {
      validPe: true,
      kind: 'dlss_rr',
      isNeuralRendering: false,
      reason: '该文件实际为 DLSS Ray Reconstruction 光线重建 (nvngx_dlssd.dll)，而非 DLSS 5 神经渲染模型'
    };
  }
  if (hasDlssFgPdb && !hasDlssNrCallbacks) {
    return {
      validPe: true,
      kind: 'dlss_fg',
      isNeuralRendering: false,
      reason: '该文件实际为 DLSS Frame Generation 帧生成 (nvngx_dlssg.dll)，而非 DLSS 5 神经渲染模型'
    };
  }

  if (hasDlssNrPdb || hasDlssNrCallbacks || hasDlssNrFeaturePath) {
    return {
      validPe: true,
      kind: 'dlss_nr',
      isNeuralRendering: true,
      hasDlssNrPdb,
      hasDlssNrCallbacks,
      reason: null
    };
  }

  return {
    validPe: true,
    kind: 'unknown_dll',
    isNeuralRendering: false,
    reason: `未检测到 NVIDIA NGX DLSS 5 Neural Rendering (Feature 18 / dlssnr) 内部特征符号: ${path.basename(filePath || '')}`
  };
}

// 扫描并验证单个 DLL 文件的完整特征（带文件状态缓存）
function inspectNeuralModelBinary(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, valid: false, reason: '文件不存在' };
  }
  if (!stat.isFile()) return { exists: false, valid: false, reason: '路径不是普通文件' };

  const cacheKey = path.resolve(filePath).toLowerCase();
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cached = binaryInspectionCache.get(cacheKey);
  if (cached && cached.stamp === stamp) return cached.result;

  const bitness = pe.getBitness(filePath);
  const version = pe.getFileVersion(filePath);
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { exists: true, valid: false, reason: `读取失败: ${err.message}` };
  }

  const identity = identifyNgxBuffer(buf, filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const fatbin = identity.isNeuralRendering
    ? scanBufferArchitectures(buf)
    : { architectures: [], smCounts: {}, containerCount: 0 };

  const knownModel = MODEL_DATABASE.find((m) => m.sha256 && m.sha256 === sha256) || null;
  const isOct2026Version = /^310\.9\.16(?:\.|$)/.test(String(version || ''));
  const valid = Boolean(
    bitness === 64 &&
    identity.isNeuralRendering &&
    fatbin.architectures.length > 0
  );

  let reason = identity.reason;
  if (!reason && bitness !== 64) {
    reason = `DLSS 5 神经渲染运行时必须为 64 位 PE 文件 (当前检测到: ${bitness || '未知'} 位)`;
  }
  if (!reason && fatbin.architectures.length === 0) {
    reason = 'DLL 内部未检测到有效的 CUDA Fatbin (0xBA55ED50) 神经网络核函数容器';
  }

  const result = {
    exists: true,
    valid,
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    size: stat.size,
    bitness,
    version: version || '0.0.0.0',
    sha256,
    kind: identity.kind,
    isNeuralRendering: identity.isNeuralRendering,
    architectures: fatbin.architectures,
    smCounts: fatbin.smCounts,
    containerCount: fatbin.containerCount,
    modelId: knownModel ? knownModel.id : (isOct2026Version ? '310.9.16-oct2026' : (valid ? `custom-${sha256.slice(0, 8)}` : null)),
    modelName: knownModel ? knownModel.name : (isOct2026Version ? 'DLSS 5 NR 310.9.16 (Imported Build)' : (valid ? `Custom DLSS 5 NR (${version || 'unknown'})` : null)),
    knownModel,
    reason
  };

  binaryInspectionCache.set(cacheKey, { stamp, result });
  return result;
}

// 评估模型与当前 GPU 的兼容性状态，返回明确的徽章与解释
function evaluateModelGpuCompatibility(modelOrInspection, gpuName = 'Unknown GPU') {
  const gpu = detectGpuArchitecture(gpuName);
  const archs = Array.isArray(modelOrInspection?.architectures) ? modelOrInspection.architectures : [];
  const modelId = modelOrInspection?.id || modelOrInspection?.modelId || '';
  const sha256 = modelOrInspection?.sha256 || null;

  if (!gpu.sm) {
    return {
      compatible: false,
      status: 'untested',
      badge: '尚未测试',
      gpu,
      reason: `未能识别当前显卡 (${gpuName}) 的 CUDA SM 架构代号`
    };
  }

  const hasSm = archs.includes(gpu.sm);
  if (!hasSm) {
    return {
      compatible: false,
      status: 'incompatible',
      badge: '不兼容',
      gpu,
      reason: `该模型仅包含 [sm_${archs.join(', sm_') || '无'}] 架构核函数，缺少当前显卡 ${gpuName} 所需的 ${gpu.family} (sm_${gpu.sm}) 核函数；强行加载会触发 NGX Feature 18 创建失败 (0xbad00001)。`
    };
  }

  // 如果包含当前 GPU 的 SM 架构


  return {
    compatible: true,
    status: 'experimental',
    badge: '实验性支持',
    gpu,
    reason: `模型包含 sm_${gpu.sm} (${gpu.family}) CUDA 核函数，仅通过静态架构检查；当前游戏运行尚未验证。`
  };
}

// 获取用户自定义导入的模型存储目录与索引文件
function customModelsRoot(userDataDir) {
  return path.join(path.resolve(userDataDir), 'neural-models');
}

function readCustomModelsIndex(userDataDir) {
  if (!userDataDir) return [];
  const indexFile = path.join(customModelsRoot(userDataDir), 'index.json');
  try {
    const rows = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows.filter((r) => r && r.filePath && fs.existsSync(r.filePath));
  } catch {
    return [];
  }
}

function writeCustomModelsIndex(userDataDir, rows) {
  const root = customModelsRoot(userDataDir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(rows, null, 2), 'utf8');
}

// 列出所有已知与可用的 DLSS 5 神经渲染模型（合并内置 payload、数据库条目与用户合法导入的模型）
function listNeuralModels({ payloadDir, userDataDir, gpuName = 'Unknown GPU' } = {}) {
  const effectivePayloadDir = resolvePayloadDir(payloadDir);
  const bundledPath = effectivePayloadDir ? path.join(effectivePayloadDir, 'streamline', 'nvngx_dlssnr.dll') : null;
  const bundledInspection = bundledPath && fs.existsSync(bundledPath) ? inspectNeuralModelBinary(bundledPath) : null;
  const customRows = readCustomModelsIndex(userDataDir);

  const models = MODEL_DATABASE.map((entry) => {
    const isBundled = entry.id === '310.8.SF-v2' && Boolean(bundledInspection && bundledInspection.valid);
    const matchingCustom = customRows.find((c) => (entry.sha256 && c.sha256 === entry.sha256) || c.modelId === entry.id);
    const activeSource = isBundled ? bundledInspection : matchingCustom || entry;
    const compat = evaluateModelGpuCompatibility(activeSource, gpuName);
    return {
      ...entry,
      availableOnDisk: Boolean(isBundled || matchingCustom),
      filePath: isBundled ? bundledPath : (matchingCustom ? matchingCustom.filePath : null),
      compatStatus: compat.status,
      compatBadge: compat.badge,
      compatReason: compat.reason
    };
  });

  // 追加未在固定枚举中但用户已手动导入的合法自定义神经渲染模型
  for (const custom of customRows) {
    if (models.some((m) => m.sha256 === custom.sha256 || m.id === custom.id)) continue;
    const compat = evaluateModelGpuCompatibility(custom, gpuName);
    models.push({
      id: custom.id,
      name: custom.name || custom.modelName || `Imported DLSS 5 NR (${custom.version})`,
      role: /^310\.9\.16/.test(custom.version) ? 'oct2026_faster' : 'custom',
      version: custom.version,
      releaseDate: custom.importedAt ? custom.importedAt.slice(0, 10) : 'Custom',
      sha256: custom.sha256,
      size: custom.size,
      parameters: /^310\.9\.16/.test(custom.version) ? '118M' : 'Custom',
      architectures: custom.architectures || [],
      smCounts: custom.smCounts || {},
      bundled: false,
      availableOnDisk: true,
      filePath: custom.filePath,
      rtx40Status: compat.status,
      rtx40Badge: compat.badge,
      compatStatus: compat.status,
      compatBadge: compat.badge,
      compatReason: compat.reason,
      sourceType: '用户手动导入 (Validated Import)',
      description: custom.notes || `手动导入的合法 DLSS 5 神经渲染模型，包含 [sm_${(custom.architectures || []).join(', sm_')}] 核函数。`
    });
  }

  return models;
}

// 合法来源的模型手动导入：执行严格的二进制 PE、NGX 符号与 CUDA Fatbin 校验
function importNeuralModel(sourceFilePath, userDataDir, meta = {}) {
  if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
    throw Object.assign(new Error('未找到指定的模型文件'), { code: 'errModelFileNotFound' });
  }
  const info = inspectNeuralModelBinary(sourceFilePath);
  if (!info.valid) {
    throw Object.assign(new Error(info.reason || '无效的 DLSS 5 神经渲染模型文件'), {
      code: info.kind === 'dlss_sr' || info.kind === 'dlss_rr' || info.kind === 'dlss_fg'
        ? 'errNotNeuralRenderingModel'
        : 'errInvalidNeuralModel',
      details: info
    });
  }

  const id = info.knownModel ? info.knownModel.id : (`custom-${info.sha256.slice(0, 12)}`);
  const targetDir = path.join(customModelsRoot(userDataDir), info.sha256.slice(0, 16));
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, 'nvngx_dlssnr.dll');
  fs.copyFileSync(sourceFilePath, targetFile);

  const existing = readCustomModelsIndex(userDataDir).filter((r) => r.sha256 !== info.sha256);
  const record = {
    id,
    modelId: id,
    name: (meta.name || '').trim() || info.modelName,
    notes: (meta.notes || '').trim() || null,
    version: info.version,
    size: info.size,
    sha256: info.sha256,
    architectures: info.architectures,
    smCounts: info.smCounts,
    filePath: targetFile,
    importedAt: new Date().toISOString()
  };
  existing.push(record);
  writeCustomModelsIndex(userDataDir, existing);
  return record;
}

// 解析游戏目录中的神经渲染运行时日志，提取成功状态或失败错误码（如 0xbad00001）
function parseNeuralRuntimeLogs(gameDir, exeDir) {
  const dirs = [...new Set([exeDir, gameDir, exeDir ? path.join(exeDir, 'host64') : null].filter(Boolean))];
  const logFiles = ['ReShade.log', 'dlss5-feed.log', 'dlss5-feed-host.log', 'OptiScaler.log'];
  const errors = [];
  let initialized = false;
  let evaluatedFrames = false;
  let loadedDllPath = null;

  for (const d of dirs) {
    for (const name of logFiles) {
      const full = path.join(d, name);
      if (!fs.existsSync(full)) continue;
      let text = '';
      try {
        const size = fs.statSync(full).size;
        const fd = fs.openSync(full, 'r');
        const readLen = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
        fs.closeSync(fd);
        text = buf.toString('utf8');
      } catch {
        continue;
      }

      if (/feature\s*18\s*create\s*failed\s*with\s*0xbad00001/i.test(text) || /0xbad00001/i.test(text)) {
        errors.push({
          file: path.relative(gameDir, full),
          code: '0xBAD00001 (NVSDK_NGX_Result_FAIL_FeatureNotSupported)',
          message: 'NGX Feature 18 (DLSS 5 神经渲染) 初始化失败：当前模型的 CUDA Fatbin 不支持该显卡架构或被驱动拦截。'
        });
      }
      if (/Failed to load nvngx_dlssnr\.dll/i.test(text) || /errNoNeuralRuntime/i.test(text)) {
        errors.push({
          file: path.relative(gameDir, full),
          code: 'DLL_LOAD_FAILED',
          message: '消费者插件未能加载 nvngx_dlssnr.dll。'
        });
      }
      if (/DLSSNR.*initialized|Neural Rendering.*active|CreateFeature.*18.*succeeded|dlss5-feed.*connected|NR runtime loaded|NR-VERDICT.*state=ENGAGED/i.test(text)) {
        initialized = true;
      }
      if (/EvaluateFeature.*18|dlss5-feed.*frame\s+\d+|DLSSNR.*Evaluate|NR-VERDICT.*evals=[1-9]\d*/i.test(text)) {
        evaluatedFrames = true;
      }
      const matchPath = text.match(/([A-Za-z]:\\[^\r\n"]*?nvngx_dlssnr\.dll)/i);
      if (matchPath) loadedDllPath = matchPath[1];
    }
  }

  return {
    initialized,
    evaluatedFrames,
    loadedDllPath,
    hasErrors: errors.length > 0,
    errors
  };
}

// 检查指定游戏目录的 DLSS 5 神经渲染完整状态、模型版本、依赖项与 GPU 兼容性
async function inspectGameNeuralStatus(gameDir, { payloadDir, userDataDir, gpuName = 'Unknown GPU' } = {}) {
  const effectivePayloadDir = resolvePayloadDir(payloadDir);
  const scan = await scanGame(gameDir);
  const exePath = scan.chosen ? scan.chosen.path : null;
  const exeDir = exePath ? path.dirname(exePath) : gameDir;
  const bitness = scan.chosen ? scan.chosen.bitness : 64;
  const targetDir = bitness === 32 ? path.join(exeDir, 'host64') : exeDir;

  const nrCandidates = [
    path.join(targetDir, 'nvngx_dlssnr.dll'),
    path.join(exeDir, 'nvngx_dlssnr.dll'),
    ...scan.dlssFiles.filter((f) => /^nvngx_dlssnr\.dll$/i.test(f.name)).map((f) => f.path)
  ];
  const activeNrPath = nrCandidates.find((p) => fs.existsSync(p)) || null;
  const activeModelInfo = activeNrPath ? inspectNeuralModelBinary(activeNrPath) : null;

  // 检查关联的 nvngx_dlss.dll 与消费者插件依赖
  const dlssSrPath = [
    path.join(targetDir, 'nvngx_dlss.dll'),
    path.join(exeDir, 'nvngx_dlss.dll'),
    ...(scan.primaryDlss ? [scan.primaryDlss.path] : [])
  ].find((p) => p && fs.existsSync(p)) || null;
  const dlssSrVersion = dlssSrPath ? pe.getFileVersion(dlssSrPath) : null;

  const consumerAddons = ['renodx-dlss5.addon64', 'renodx-dlss.addon64', 'dlss5-feed.addon64', 'dlss5-feed.addon32']
    .filter((name) => fs.existsSync(path.join(exeDir, name)) || fs.existsSync(path.join(targetDir, name)));
  const optiInstalled = Boolean(scan.install?.optiscaler?.installed);

  const dependencies = {
    hasNeuralDll: Boolean(activeModelInfo && activeModelInfo.valid),
    hasDlssSrDll: Boolean(dlssSrPath),
    dlssSrVersion,
    hasConsumer: consumerAddons.length > 0 || optiInstalled,
    consumerAddons,
    optiInstalled,
    reshadeInstalled: Boolean(scan.reshade && scan.reshade.installed),
    missing: []
  };
  if (!dependencies.hasNeuralDll) dependencies.missing.push('nvngx_dlssnr.dll');
  if (!dependencies.hasDlssSrDll) dependencies.missing.push('nvngx_dlss.dll');
  if (!dependencies.hasConsumer) dependencies.missing.push('RenoDX / Feeder / OptiScaler 神经渲染消费者组件');

  const gpuCompat = activeModelInfo && activeModelInfo.valid
    ? evaluateModelGpuCompatibility(activeModelInfo, gpuName)
    : evaluateModelGpuCompatibility(MODEL_DATABASE[0], gpuName);

  const logs = parseNeuralRuntimeLogs(gameDir, exeDir);
  const availableModels = listNeuralModels({ payloadDir: effectivePayloadDir, userDataDir, gpuName });
  const latestCompatible = availableModels.find((m) => m.role === 'latest_compatible') || availableModels[0];
  const oct2026Model = availableModels.find((m) => m.id === '310.9.16-oct2026');

  // 确定当前模式：Off / Legacy Model / Latest Compatible Model
  let mode = 'off';
  if (activeModelInfo && activeModelInfo.valid) {
    if (activeModelInfo.modelId === '310.8.SF-v2' || activeModelInfo.modelId === '310.9.16-oct2026') {
      mode = 'latest_compatible';
    } else {
      mode = 'legacy';
    }
  }

  // 判断当前运行时栈版本
  const runtimeStack = dlssSrVersion && /^310\.9\.16/.test(dlssSrVersion)
    ? 'oct2026-310.9.16'
    : 'baseline-310.9.1';

  // 综合状态徽章
  let overallStatus = 'untested';
  let overallBadge = '尚未测试';
  if (logs.hasErrors || gpuCompat.status === 'incompatible') {
    overallStatus = 'incompatible';
    overallBadge = '不兼容';
  } else if (activeModelInfo && activeModelInfo.valid && dependencies.missing.length === 0) {
    overallStatus = gpuCompat.status === 'verified' ? 'verified' : 'experimental';
    overallBadge = gpuCompat.status === 'verified' ? '已验证可用' : '实验性支持';
  }

  return {
    ok: Boolean(scan.chosen),
    gameDir,
    exePath,
    exeDir,
    api: scan.chosen ? scan.chosen.apiLabel : null,
    bitness,
    mode,
    installed: Boolean(activeModelInfo && activeModelInfo.valid && dependencies.hasConsumer),
    currentModel: activeModelInfo ? {
      id: activeModelInfo.modelId,
      name: activeModelInfo.modelName,
      version: activeModelInfo.version,
      sha256: activeModelInfo.sha256,
      size: activeModelInfo.size,
      architectures: activeModelInfo.architectures,
      smCounts: activeModelInfo.smCounts,
      path: activeModelInfo.filePath,
      rel: path.relative(gameDir, activeModelInfo.filePath)
    } : null,
    latestCompatibleModel: latestCompatible,
    oct2026Model,
    runtimeVersion: dlssSrVersion || (effectivePayloadDir ? pe.getFileVersion(path.join(effectivePayloadDir, 'streamline', 'nvngx_dlss.dll')) : '310.9.1.0'),
    runtimeStack,
    runtimeStacks: RUNTIME_STACKS,
    gpuCompatibility: gpuCompat,
    dependencies,
    logs,
    hasBackup: scan.hasBackup,
    overallStatus,
    overallBadge,
    availableModels
  };
}

// 在游戏中切换或部署指定的神经渲染模型与可选的 310.9.16 运行时栈（全部通过 _DLSS5_Backup 事务追踪，支持一键回滚）
async function applyNeuralModelSelection(gameDir, options = {}, onLog = () => {}) {
  const {
    mode = 'latest_compatible', // 'off' | 'legacy' | 'latest_compatible' | 具体 modelId
    modelId = null,
    runtimeStack = null, // 'baseline-310.9.1' | 'oct2026-310.9.16'
    payloadDir,
    userDataDir,
    gpuName = 'Unknown GPU'
  } = options;
  const effectivePayloadDir = resolvePayloadDir(payloadDir);

  const scan = await scanGame(gameDir);
  if (!scan.chosen) throw Object.assign(new Error('未在游戏目录中找到可执行文件'), { code: 'errNoExe' });
  const exePath = scan.chosen.path;
  const exeDir = path.dirname(exePath);
  const bitness = scan.chosen.bitness || 64;
  const targetDir = bitness === 32 ? path.join(exeDir, 'host64') : exeDir;

  if (!apply.canWrite(gameDir) || !apply.canWrite(exeDir)) {
    throw Object.assign(new Error('游戏目录无写入权限'), { code: 'errNoWriteAccess' });
  }

  return journal.transaction(gameDir, async () => {
    const manifest = apply.beginManifest(gameDir, exePath, scan.chosen.api || 'dxgi');
    const destNr = path.join(targetDir, 'nvngx_dlssnr.dll');

    // 如果选择关闭神经渲染 ('off')，将已注入的 nvngx_dlssnr.dll 与消费者插件一并移除或从备份恢复，避免孤立插件提示“未安装 NR 运行时”
    if (mode === 'off') {
      const filesToDisable = [
        destNr,
        path.join(exeDir, 'nvngx_dlssnr.dll'),
        path.join(exeDir, 'renodx-dlss5.addon64'),
        path.join(exeDir, 'renodx-dlss.addon64'),
        path.join(targetDir, 'renodx-dlss5.addon64'),
        path.join(targetDir, 'renodx-dlss.addon64')
      ];
      const visited = new Set();
      for (const fileTarget of filesToDisable) {
        const normKey = path.resolve(fileTarget).toLowerCase();
        if (visited.has(normKey) || !fs.existsSync(fileTarget)) continue;
        visited.add(normKey);
        const rel = path.relative(gameDir, fileTarget);
        const rep = (manifest.replaced || []).find((r) => r.rel.toLowerCase() === rel.toLowerCase());
        if (rep) {
          const backupFile = apply.originalPath(gameDir, manifest, rep.rel);
          if (fs.existsSync(backupFile)) {
            await journal.capture(gameDir, fileTarget);
            await fs.promises.copyFile(backupFile, fileTarget);
            onLog({ code: 'neuralModelRestoredOriginal', params: { rel } });
          }
        } else {
          await journal.capture(gameDir, fileTarget);
          await fs.promises.unlink(fileTarget);
          onLog({ code: 'neuralModelDisabled', params: { rel } });
        }
      }
      // 如果存在 OptiScaler.ini，将 [DlssNr] Enabled 设为 false
      const optiIni = path.join(exeDir, 'OptiScaler.ini');
      if (fs.existsSync(optiIni)) {
        const feederConfig = require('./feeder-config');
        const updated = feederConfig.setIni(feederConfig.readText(optiIni), 'DlssNr', 'Enabled', 'false');
        await apply.writeTracked(manifest, gameDir, optiIni, updated, { kind: 'config' });
      }
      manifest.neuralRendering = { mode: 'off', modelId: null, updatedAt: new Date().toISOString() };
      await apply.saveActiveManifest(gameDir, manifest);
      return { ok: true, mode: 'off', modelId: null };
    }

    // 查找要部署的目标模型文件
    const models = listNeuralModels({ payloadDir: effectivePayloadDir, userDataDir, gpuName });
    let chosenModel = null;
    if (modelId) {
      chosenModel = models.find((m) => m.id === modelId);
    } else if (mode === 'latest_compatible') {
      chosenModel = models.find((m) => m.availableOnDisk && m.compatStatus === 'verified') ||
        models.find((m) => m.availableOnDisk && m.compatStatus === 'experimental');
    } else if (mode === 'legacy') {
      chosenModel = models.find((m) => m.availableOnDisk && m.role === 'legacy') ||
        models.find((m) => m.availableOnDisk && m.id === '310.8.SF-v2');
    }

    if (!chosenModel || !chosenModel.availableOnDisk || !chosenModel.filePath) {
      throw Object.assign(
        new Error(`所选模型 (${modelId || mode}) 当前未在本地磁盘就绪，请先通过“手动导入”导入合法的 nvngx_dlssnr.dll 文件。`),
        { code: 'errModelNotOnDisk' }
      );
    }

    // 校验目标模型二进制文件合法性与 GPU 架构兼容性
    const binaryCheck = inspectNeuralModelBinary(chosenModel.filePath);
    if (!binaryCheck.valid) {
      throw Object.assign(new Error(binaryCheck.reason || '模型文件校验未通过'), { code: 'errInvalidNeuralModel' });
    }
    const compat = evaluateModelGpuCompatibility(binaryCheck, gpuName);
    if (!compat.compatible && !options.allowIncompatibleGpu) {
      throw Object.assign(new Error(compat.reason), { code: 'errModelGpuIncompatible', compatibility: compat });
    }

    // 使用受追踪拷贝部署 nvngx_dlssnr.dll（自动备份原版文件）
    await apply.copyTracked(manifest, gameDir, chosenModel.filePath, destNr, {
      kind: 'runtime',
      newVersion: binaryCheck.version
    });
    onLog({ code: 'neuralModelInstalled', params: { id: chosenModel.id, version: binaryCheck.version } });

    // 如果存在 OptiScaler.ini，确保 [DlssNr] Enabled=true
    const optiIni = path.join(exeDir, 'OptiScaler.ini');
    if (fs.existsSync(optiIni)) {
      const feederConfig = require('./feeder-config');
      const updated = feederConfig.setIni(feederConfig.readText(optiIni), 'DlssNr', 'Enabled', 'true');
      await apply.writeTracked(manifest, gameDir, optiIni, updated, { kind: 'config' });
    }

    // 可选：同步切换 DLSS 310.9.16 / 310.9.1 基础运行时栈
    if (runtimeStack && effectivePayloadDir) {
      const stackDir = runtimeStack === 'oct2026-310.9.16'
        ? path.join(effectivePayloadDir, 'enhanced', 'streamline-2.14.16')
        : path.join(effectivePayloadDir, 'streamline');
      const srcDlss = path.join(stackDir, 'nvngx_dlss.dll');
      if (fs.existsSync(srcDlss)) {
        const destDlss = path.join(targetDir, 'nvngx_dlss.dll');
        await apply.copyTracked(manifest, gameDir, srcDlss, destDlss, {
          kind: 'runtime',
          newVersion: pe.getFileVersion(srcDlss)
        });
      }
      if (runtimeStack === 'oct2026-310.9.16' && manifest.route === 'feeder') {
        const feederEnhDir = path.join(effectivePayloadDir, 'enhanced', 'feeder-1.19.0');
        const addonName = bitness === 32 ? 'dlss5-feed.addon32' : 'dlss5-feed.addon64';
        const srcAddon = path.join(feederEnhDir, addonName);
        if (fs.existsSync(srcAddon)) {
          await apply.copyTracked(manifest, gameDir, srcAddon, path.join(exeDir, addonName), {
            kind: 'feeder',
            newVersion: pe.getFileVersion(srcAddon)
          });
        }
      }
    }

    manifest.neuralRendering = {
      mode,
      modelId: chosenModel.id,
      modelVersion: binaryCheck.version,
      sha256: binaryCheck.sha256,
      architectures: binaryCheck.architectures,
      runtimeStack: runtimeStack || 'baseline-310.9.1',
      updatedAt: new Date().toISOString()
    };
    await apply.saveActiveManifest(gameDir, manifest);

    return {
      ok: true,
      mode,
      modelId: chosenModel.id,
      version: binaryCheck.version,
      sha256: binaryCheck.sha256,
      compatibility: compat
    };
  });
}

module.exports = {
  MODEL_DATABASE,
  RUNTIME_STACKS,
  detectGpuArchitecture,
  scanBufferArchitectures,
  identifyNgxBuffer,
  inspectNeuralModelBinary,
  evaluateModelGpuCompatibility,
  listNeuralModels,
  importNeuralModel,
  parseNeuralRuntimeLogs,
  inspectGameNeuralStatus,
  applyNeuralModelSelection
};
