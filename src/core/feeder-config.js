'use strict';

const fs = require('fs');
const path = require('path');

function sectionBounds(lines, section) {
  if (section === '') {
    const end = lines.findIndex(line => /^\s*\[.+\]\s*$/.test(line));
    return { start: -1, end: end === -1 ? lines.length : end };
  }
  const header = `[${section}]`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function getIni(text, section, key) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const bounds = sectionBounds(lines, section);
  if (!bounds) return null;
  const wanted = key.toLowerCase();
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=\s*(.*)$/);
    if (match && match[1].trim().toLowerCase() === wanted) return match[2].trim();
  }
  return null;
}

function setIni(text, section, key, value) {
  const newline = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let bounds = sectionBounds(lines, section);
  if (!bounds) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    const wanted = key.toLowerCase();
    let changed = false;
    for (let i = bounds.start + 1; i < bounds.end; i++) {
      const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=/);
      if (match && match[1].trim().toLowerCase() === wanted) {
        const spacing = (lines[i].match(/^(\s*[^=]+?\s*=\s*)/) || [])[1] || `${key}=`;
        lines[i] = spacing + value;
        changed = true;
        break;
      }
    }
    if (!changed) lines.splice(bounds.end, 0, `${key}=${value}`);
  }
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

function mergeNamedList(value, required, nameOf = (item) => item) {
  const current = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const requiredNames = new Set(required.map((item) => nameOf(item).toLowerCase()));
  const kept = current.filter((item) => !requiredNames.has(nameOf(item).toLowerCase()));
  return [...required, ...kept].join(',');
}

// ReShade Setup 6.8 may seed recursive paths as `Shaders\**\**`. Windows
// rejects the unresolved wildcard directory with ERROR_INVALID_NAME (123), so
// the runtime sees no effects even though every .fx file is present. Always
// put our canonical recursive path first and collapse/remove malformed copies,
// while retaining unrelated custom search locations.
function configureSearchPath(value, required) {
  const canonical = (item) => String(item || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/(?:\\\*\*){2,}$/g, '\\**');
  const base = (item) => canonical(item).replace(/\\\*\*$/g, '').replace(/[\\]+$/g, '').toLowerCase();
  const requiredBase = base(required);
  const kept = String(value || '').split(',').map(canonical).filter(Boolean)
    .filter((item) => base(item) !== requiredBase);
  return [required, ...kept].join(',');
}

function configureGameReShade(text, provider = 2) {
  let out = String(text || '');
  out = setIni(out, 'GENERAL', 'EffectSearchPaths', configureSearchPath(
    getIni(out, 'GENERAL', 'EffectSearchPaths'), '.\\reshade-shaders\\Shaders\\**'
  ));
  out = setIni(out, 'GENERAL', 'TextureSearchPaths', configureSearchPath(
    getIni(out, 'GENERAL', 'TextureSearchPaths'), '.\\reshade-shaders\\Textures\\**'
  ));
  out = setIni(out, 'GENERAL', 'PresetPath', getIni(out, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini');
  out = setIni(out, 'GENERAL', 'StartupPresetPath', '');
  out = setIni(out, 'GENERAL', 'NoReloadOnInit', '0');
  out = setIni(out, 'GENERAL', 'SkipLoadingDisabledEffects', '1');
  const definitions = mergeNamedList(
    getIni(out, 'GENERAL', 'PreprocessorDefinitions'),
    [`DLSS5_MV_PROVIDER=${provider}`],
    (item) => item.split('=')[0].trim()
  );
  out = setIni(out, 'GENERAL', 'PreprocessorDefinitions', definitions);
  out = setIni(out, 'ADDON', 'AddonPath', '.\\');
  return out;
}

function configureHostReShade(text) {
  return configureConsumer(setIni(String(text || ''), 'ADDON', 'AddonPath', '.\\'), { host: true });
}

function configureConsumer(text, { host = false, xenia = false } = {}) {
  let out = String(text || '');
  for (const [key, value] of Object.entries({ EnableHooks: '2', NeuralUplift: '1', NREnableUpscaling: '0' })) {
    out = setIni(out, 'RenoDX.DLSS5', key, value);
  }
  for (const [key, value] of Object.entries({
    ConfigVersion: '7',
    NRIntensity: '1',
    NRPasses: '1',
    NRPreset: '0',
    NRStyle: '0'
  })) {
    if (getIni(out, 'RenoDX.DLSS5', key) === null) {
      out = setIni(out, 'RenoDX.DLSS5', key, value);
    }
  }
  if (host) out = setIni(out, 'RenoDX.DLSS5', 'NRToggleKey', '0');
  if (getIni(out, 'RenoDX.DLSS5', 'NRStyle') === '2') out = setIni(out, 'RenoDX.DLSS5', 'NRStyle', '0');
  if (xenia) {
    out = setIni(out, 'RenoDX.DLSS5', 'NRAutoMask', '1');
    out = setIni(out, 'RenoDX.DLSS5', 'NRUICorrection', '1');
  }
  return out;
}

function configurePreset(text, provider = 2, { xenia = false } = {}) {
  let out = String(text || '');
  const providerTechnique = provider === 3
    ? 'Lumenite_Kernel@lumenite_Kernel.fx'
    : 'vort_MotionEffects@vort_Motion.fx';
  const required = [providerTechnique, 'DLSS5_Feed@DLSS5_Feed.fx'];
  const techniqueName = (item) => item.split('@')[0].trim();
  const feederTechniques = new Set([
    'Lumenite_Kernel', 'Lumenite_QuantMotion', 'vort_MotionEffects', 'DLSS5_Feed', 'Launchpad'
  ].map((name) => name.toLowerCase()));
  for (const key of ['Techniques', 'TechniqueSorting']) {
    const current = getIni(out, '', key);
    // ReShade's preset keys live before any section. Handle that root area
    // directly, while preserving every unrelated setting and technique.
    const kept = String(current || '').split(',').map((item) => item.trim()).filter(Boolean)
      .filter((item) => !feederTechniques.has(techniqueName(item).toLowerCase()));
    const next = [...required, ...kept].join(',');
    out = setIni(out, '', key, next);
  }
  const definitions = mergeNamedList(
    getIni(out, '', 'PreprocessorDefinitions'),
    [`DLSS5_MV_PROVIDER=${provider}`],
    (item) => item.split('=')[0].trim()
  );
  out = setIni(out, '', 'PreprocessorDefinitions', definitions);
  // Per-effect definitions override the preset/global list in ReShade.
  // Repair the stale provider=0 reported in SWTOR at every applicable level.
  out = setIni(out, 'DLSS5_Feed.fx', 'PreprocessorDefinitions', mergeNamedList(
    getIni(out, 'DLSS5_Feed.fx', 'PreprocessorDefinitions'),
    [`DLSS5_MV_PROVIDER=${provider}`], item => item.split('=')[0].trim()
  ));
  if (xenia) {
    for (const [key, value] of Object.entries({ GEOM_ENABLE: '0', MV_VALIDATE: '1', VALIDATE_STATIC: '1', VALIDATE_LUMA: '1', VALIDATE_DEPTH: '1', VALIDATE_MV: '1', MASK_STRENGTH: '1.0' })) {
      out = setIni(out, 'DLSS5_Feed.fx', key, value);
    }
  }
  return out.replace(/\r?\n/g, '\r\n').replace(/(?:\r\n)*$/, '\r\n');
}

const FEED_DEFAULTS = {
  enabled: '1', mode: '2', hdr: '-1', depth_inverted: '-1', flags: '-1',
  reset_every: '0', warmup_rebuild: '180', rebuild: '0', log_frames: '3',
  create_delay: '60', preset: '0', work_resolution: '100',
  mv_scale_x: '1.000', mv_scale_y: '1.000', host_window: '0', async_home: '1'
};

function configureFeed(text) {
  const lines = String(text || '').split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const match = line.match(/^\s*([^#;=]+?)\s*=\s*(.*)$/);
    if (!match) return line;
    const key = match[1].trim().toLowerCase();
    if (!(key in FEED_DEFAULTS)) return line;
    seen.add(key);
    return `${key}=${match[2].trim()}`;
  }).filter((line, index, all) => !(line === '' && index === all.length - 1));
  for (const [key, value] of Object.entries(FEED_DEFAULTS)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\r\n') + '\r\n';
}

function configureDgVoodoo(text, options = {}) {
  let out = String(text || '');
  out = setIni(out, 'General', 'OutputAPI', 'd3d11_fl11_0');
  out = setIni(out, 'General', 'CaptureMouse', 'false');
  out = setIni(out, 'DirectX', 'DisableAndPassThru', 'false');
  out = setIni(out, 'DirectX', 'VideoCard', 'internal3D');
  // 32位老游戏 (DDraw/DX8/DX9) 调用 GetAvailableVidMem / GetAvailableTextureMem 时返回字节级 32 位整数；
  // 若设为 4096 MB (4,294,967,296 字节 = 0x100000000) 会发生 32 位有符号/无符号整数溢出（在部分老引擎中算作负数或 0 MB 显存），
  // 因此 32 位游戏统一设为安全的 1024 MB (1,073,741,824 < 2^31)，64 位游戏保持 4096 MB。
  const is32Bit = Boolean(options && options.bitness === 32);
  const vram = is32Bit ? '1024' : '4096';
  out = setIni(out, 'DirectX', 'VRAM', vram);
  out = setIni(out, 'DirectX', 'dgVoodooWatermark', 'false');
  if (is32Bit) {
    // 启用无边框伪全屏 (FullscreenAttributes=fake)，避免独占全屏模式切换导致 DirectShow/VMR9 开场视频闪退
    // （如《侠盗猎车手：罪恶都市》）并保证 Windows 11 DWM 下 host64 神经渲染叠加层稳定贴合窗口。
    out = setIni(out, 'GeneralExt', 'FullscreenAttributes', 'fake');
    // 补充经典低分辨率列表，防止现代笔记本 eDP 面板缺失 640x480 / 800x600 / 1024x768 模式导致老游戏首次启动直接退出。
    out = setIni(out, 'DirectXExt', 'ExtraEnumeratedResolutions', '640x480, 800x600, 1024x768, 1280x720, 1280x960, 1600x900');
  }
  return out;
}

function presetPath(exeDir, reshadeIniText) {
  const value = getIni(reshadeIniText, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini';
  return path.resolve(exeDir, value.replace(/^\.\\/, ''));
}

function readText(file) {
  try {
    const bytes = fs.readFileSync(file);
    return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
  } catch { return ''; }
}

module.exports = {
  getIni, setIni, configureGameReShade, configureHostReShade,
  configurePreset, configureFeed, configureDgVoodoo, presetPath, readText,
  configureSearchPath, configureConsumer
};
