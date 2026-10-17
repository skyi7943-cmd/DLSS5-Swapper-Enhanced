'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function currentWindowsSession(status, raw, exeDir) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(status.pid) || status.pid <= 0) return false;
  // FILETIME is larger than JS's safe integer range; compare its original digits.
  const birth = raw.match(/"processBirth"\s*:\s*(\d+)/)?.[1];
  if (!birth) return false;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${status.pid} -ErrorAction Stop; @{birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); exe=$p.Path} | ConvertTo-Json -Compress`
    ], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    const live = JSON.parse(output);
    return live.birth === birth && typeof live.exe === 'string' &&
      path.dirname(path.resolve(live.exe)).toLowerCase() === path.resolve(exeDir).toLowerCase();
  } catch { return false; }
}

// A provider patch, requested multiplier, or NGX call count is not presentation evidence.
// Never combine successful fields from different files or different game sessions.
function verifyMfgRuntimeStatus(gameDir, exeDir, {
  expectedMultiplier = null, configuredAt = null, now = Date.now(),
  isCurrentSession = currentWindowsSession
} = {}) {
  const result = { verifiedActive: false, providerVerified: false, temporalFixApplied: false,
    blackwellKernelsActive: false, requestedMultiplier: expectedMultiplier, effectiveMultiplier: null,
    presentedFrames: 0, dlssgStatus: null, logSources: [], errors: [], evidence: 'unverified',
    fpsVerified: false };
  const files = [...new Set([exeDir, gameDir].filter(Boolean))].map(dir => path.join(dir, 'RTXMFG-Universal.status.json'));
  const candidates = [];
  for (const file of files) {
    try { candidates.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
  }
  // Latest snapshot is authoritative, including explicit negative state.
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    result.errors.push('无可绑定当前进程会话的遥测快照；文本日志仅供排错，不能证明当前倍率。');
    return result;
  }
  const { file, mtime } = candidates[0];
  result.logSources.push(path.relative(gameDir, file));
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const status = JSON.parse(raw);
    result.dlssgStatus = status.dlssgStatus ?? null;
    result.applied = status.applied === true;
    result.providerVerified = status.providerVerified === true ||
      (/nvngx_dlssg\.dll$/i.test(status.activeProviderPath || '') && Number(status.activeProviderVersionMajor) > 0);
    const heartbeatMs = Number(status.heartbeat) * 1000;
    const configuredMs = configuredAt ? Date.parse(configuredAt) : 0;
    const fresh = Number.isFinite(heartbeatMs) && now - heartbeatMs >= -2000 && now - heartbeatMs <= 15000 &&
      now - mtime >= -2000 && now - mtime <= 15000 &&
      (!configuredAt || (Number.isFinite(configuredMs) && heartbeatMs >= configuredMs && mtime >= configuredMs));
    const effective = Number(status.appliedMultiplier);
    const frames = Number(status.actualFramesPresented);
    const matches = [2, 3, 4].includes(expectedMultiplier) && effective === expectedMultiplier;
    const success = status.applied === true && status.pending !== true && status.restartRequired !== true &&
      status.streamlineRebuildRequired !== true && status.appliedFrameGenerationOn === true &&
      status.setOptionsAccepted === true && status.getStateSeen === true && status.getStateResult === 0 &&
      /^(dlssg|dlss-g|nvidia)$/i.test(status.activeFrameGeneration || '') && !status.error;
    const session = fresh && isCurrentSession(status, raw, exeDir);
    if (fresh && session && matches && success && result.providerVerified && Number.isFinite(frames) && frames >= 2) {
      result.verifiedActive = true;
      result.effectiveMultiplier = effective;
      result.presentedFrames = frames;
      result.evidence = 'current-session runtime telemetry; not independent FPS measurement';
    } else {
      if (!fresh) result.errors.push('遥测过期、时间无效或早于本次配置。');
      if (!session) result.errors.push('未确认当前游戏进程、启动时间及可执行文件目录。');
      if (!success) result.errors.push('运行时未确认 applied / FrameGenerationOn / GetState 成功。');
      if (!matches) result.errors.push('实际倍率与当前请求不符，或当前配置为 Off。');
      if (!(frames >= 2)) result.errors.push('缺少实际呈现帧证据；NGX evaluate 计数不等于生成帧。');
      if (status.error) result.errors.push(String(status.error));
    }
  } catch (error) { result.errors.push(`遥测读取失败: ${error.message}`); }
  return result;
}
module.exports = { verifyMfgRuntimeStatus, currentWindowsSession };
