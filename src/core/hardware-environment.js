'use strict';
const os = require('os');
const { execFile } = require('child_process');
const { detectGpuArchitecture } = require('./neural-models');

// A suggested starting point, never a detected display or a performance promise.
const LAPTOP_1080P_PROFILE = Object.freeze({
  id: 'rtx4070-laptop-1080p165-conservative',
  label: '建议配置（非显示器检测、非 FPS 保证）',
  resolution: '1920x1080', refreshRateHz: 165, suggestedFrameCap: 162,
  neuralMode: 'off', mfgMode: 'x2', nrPasses: 1,
  notes: '先测原生帧时间；从 NR Off、原生 FG x2 开始，单独测试 NR 单通道。x3/x4 为非官方实验。仅在 VRR 已启用时考虑 162 FPS 上限；应用不会修改驱动、屏幕、功率或游戏帧率限制。'
});
let cache = null;
function runCommand(file, args) {
  return new Promise((resolve, reject) => execFile(file, args,
    { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout || ''))));
}
function positive(value, allowZero = false) {
  if (!/^\d+(?:\.\d+)?$/.test(String(value || '').trim())) return null;
  const number = Number(value);
  return number > 0 || (allowZero && number === 0) ? number : null;
}
function parseGpuRows(output) {
  return String(output).split(/\r?\n/).filter(line => line.trim()).map(line => {
    const fields = line.split(',').map(value => value.trim());
    if (fields.length !== 7 || !/NVIDIA|GeForce|Quadro|Tesla/i.test(fields[0]) || !/^\d+\.\d+(?:\.\d+)*$/.test(fields[1])) return null;
    return {
      name: fields[0], driver: fields[1], architecture: detectGpuArchitecture(fields[0]),
      vramTotalMB: positive(fields[2]), vramUsedMB: positive(fields[3], true),
      vramFreeMB: positive(fields[4], true), powerDefaultW: positive(fields[5]), powerMaxW: positive(fields[6])
    };
  }).filter(Boolean);
}
async function detectHardwareEnvironment(forceRefresh = false, { run = runCommand, now = Date.now() } = {}) {
  if (run === runCommand && cache && !forceRefresh && now - cache.at < 5000) return cache.value;
  let gpus = [], error = null;
  try {
    gpus = parseGpuRows(await run(process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,power.default_limit,power.max_limit',
      '--format=csv,noheader,nounits'
    ]));
    if (!gpus.length) error = 'nvidia-smi returned no valid GPU rows';
  } catch (failure) { error = failure.message; }
  const cpus = os.cpus() || [];
  const value = {
    os: `${os.type()} ${os.release()} (${os.arch()})`, cpu: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length, ramGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    detectedAt: new Date(now).toISOString(), detection: { source: gpus.length ? 'nvidia-smi' : 'unavailable', error,
      adapterSelection: 'first reported NVIDIA adapter; game adapter is not confirmed' },
    gpus, gpu: gpus[0] || { name: 'Unknown GPU', driver: null, architecture: detectGpuArchitecture(''),
      vramTotalMB: null, vramUsedMB: null, vramFreeMB: null, powerDefaultW: null, powerMaxW: null },
    display: { resolution: null, refreshRateHz: null, source: 'unavailable' },
    recommendedProfile: LAPTOP_1080P_PROFILE
  };
  if (run === runCommand) cache = { at: now, value };
  return value;
}
module.exports = { detectHardwareEnvironment, parseGpuRows, LAPTOP_1080P_PROFILE };
