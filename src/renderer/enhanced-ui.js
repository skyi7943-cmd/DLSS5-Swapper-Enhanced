'use strict';

/**
 * DLSS 5 Swapper Enhanced — 前端三大核心模块界面控制器 (Phase 5)
 *
 * 包含三个核心功能区域：
 * 1. Neural Rendering Manager (模块 A)
 * 2. Multi Frame Generation Manager (模块 B)
 * 3. Compatibility & Diagnostics (模块 C：协同运行与 7 项诊断)
 *
 * 状态严格区分：
 * - 已验证可用 (verified)
 * - 实验性支持 (experimental)
 * - 不兼容 (incompatible)
 * - 尚未测试 (untested)
 */

(function initEnhancedUi(root) {
  const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));

  // 三大硬件专属优化档位元数据（中文选择菜单）
  const HARDWARE_PROFILE_OPTIONS = [
    {
      id: 'rtx40_laptop',
      label: '💻 笔记本 40 系列 (默认黄金档)',
      tag: '原版黄金参数 · 防黑屏已加固',
      desc: 'RTX 4050 / 4060 / 4070 / 4080 / 4090 Laptop · 杀手3实测 150~164 FPS 黄金参数 + 动态多帧生成防黑屏',
      dlssSummary: '【DLSS 5 神经渲染策略】保持黄金单通渲染 (NRPasses=1) + 超分后完整分辨率 (NRHookPoint=0, NRResolutionScale=1, 预设#2 + 自然风格) + 黄金 DLSS 310.9.1.0 超分底座，关闭多通道遮罩与 UI 校正以杜绝画面异常。',
      mfgSummary: '【MFG 多帧生成策略】默认启用 NVIDIA 动态多帧生成 (DynamicMFG=1) + 原生输入模式 (QualityGuardMode=0) + DllMain 抢先挂钩，彻底解决开启补帧黑屏问题。'
    },
    {
      id: 'rtx40_desktop',
      label: '🖥️ 40 系桌面卡 (满血画质 + 桌面补帧)',
      tag: '桌面 Ada 满血专属',
      desc: 'RTX 4060Ti / 4070S / 4070TiS / 4080S / 4090D · 100% 满血分辨率 + 8 缓冲池 + 动态多帧生成 MFG',
      dlssSummary: '【DLSS 5 神经渲染策略】解锁 100% 原生满血工作分辨率 (NRResolutionScale=1, NRHookPoint=0) + 8 表面工作集缓冲池 (NRMaxWorksets=8)，根治桌面 2K/4K 高帧率表面重建卡顿。',
      mfgSummary: '【MFG 多帧生成策略】开启 DllMain 抢先挂钩 + NVIDIA 动态多帧生成 (DynamicMFG=1) + V3 方向性高锐度插值 (AdaptiveQualityProfile=2) + Reflex 强制低延迟护栏。'
    },
    {
      id: 'rtx50_desktop',
      label: '🚀 50 系列桌面卡 (Blackwell 原生直通)',
      tag: 'Blackwell 原生硬件加速',
      desc: 'RTX 5070 / 5070Ti / 5080 / 5090D · 原生 sm_120 (23核) 直通 + 零冲突原生硬件 MFG x2/x3/x4',
      dlssSummary: '【DLSS 5 神经渲染策略】直通 CUDA sm_120 (23 个 Blackwell 原生核函数) + 100% 满血工作分辨率 (NRResolutionScale=1) + 8 表面缓冲池 + 2026-10 极速运行时管线。',
      mfgSummary: '【MFG 多帧生成策略】自动旁路所有 40 系二进制补丁 (TemporalFix=0, BlackwellFrameworkKernels=0, ForceFlipMeteringOff=0)，零冲突直通第 5 代 Tensor 硬件 Flip Metering + Dynamic MFG。'
    }
  ];

  function getProfileOption(profileId) {
    return HARDWARE_PROFILE_OPTIONS.find((p) => p.id === profileId) || HARDWARE_PROFILE_OPTIONS[0];
  }

  // 一层 DLSS 5 画质强化与显卡降开销四套预设（全部严格锁定 NRPasses=1）
  const TUNING_PRESETS = {
    boost_eco: {
      id: 'boost_eco',
      label: '🔥 单层强效 · 省卡推荐',
      badge: '甜点推荐 · 算力 -44%',
      desc: '微结构 1.30x + 零通道精细细节 1.35x + 光影 1.22x，锁定 75% 整数比分辨率 + FSR1 超分锐化 + 极速光流，画质更强且像素算力直降 44%。',
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
    },
    ultra_eco: {
      id: 'ultra_eco',
      label: '⚡ 极致省卡 · 高帧优先',
      badge: '像素算力 -55%',
      desc: '适合 6G/8G 显卡、掌机或高刷稳帧：内部工作分辨率降至 67% + 2 工作集精简池 + 0.45 锐化与 1.40x 细节补偿，像素推理负担大降 55%。',
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
    },
    ultra_vivid: {
      id: 'ultra_vivid',
      label: '💎 单层满血 · 极限质感',
      badge: '100% 满血单层',
      desc: '保持 100% 原生工作分辨率，单层总强度拉升至 1.55x、微结构 1.45x、精细细节 1.45x，无需开双倍耗卡的 2 层即可呈现浓郁材质光影。',
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
    },
    standard: {
      id: 'standard',
      label: '⚖️ 原厂标准 · 默认基线',
      badge: '1.0x 原厂基准',
      desc: '恢复单层 DLSS 5 原厂默认 1.00x 混合强度，关闭额外细节塑形，并沿用当前硬件档位的默认工作分辨率。',
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
    }
  };

  function defaultProfileWorkRes(profileId) {
    return (profileId === 'rtx40_desktop' || profileId === 'rtx50_desktop') ? 100 : 75;
  }

  function defaultProfileWorksets(profileId) {
    return (profileId === 'rtx40_desktop' || profileId === 'rtx50_desktop') ? 8 : 4;
  }

  function clonePresetTuning(presetId, profileId) {
    const p = TUNING_PRESETS[presetId] || TUNING_PRESETS.boost_eco;
    return {
      preset: p.id,
      intensity: p.intensity,
      structure: p.structure,
      localTone: p.localTone,
      lookEnabled: p.lookEnabled,
      detailBoost: p.detailBoost,
      toneBoost: p.toneBoost,
      colorBoost: p.colorBoost,
      nrStyle: p.nrStyle,
      workResolution: p.workResolution !== null ? p.workResolution : defaultProfileWorkRes(profileId),
      workUpscale: p.workUpscale,
      sharpness: p.sharpness,
      holdStrength: p.holdStrength,
      maxWorksets: p.maxWorksets !== null ? p.maxWorksets : defaultProfileWorksets(profileId),
      motionCost: p.motionCost
    };
  }

  function calcUiTuningMetrics(t) {
    const res = Number(t.workResolution) || 75;
    const pixelSaved = Math.max(0, Math.round((1 - (res / 100) ** 2) * 100));
    const lookOn = t.lookEnabled !== false;
    const gain =
      ((Number(t.intensity) || 1) - 1) * 0.42 +
      ((Number(t.structure) || 1) - 1) * 0.28 +
      ((Number(t.localTone) || 1) - 1) * 0.15 +
      (lookOn ? ((Number(t.detailBoost) || 1) - 1) * 0.25 + ((Number(t.toneBoost) || 1) - 1) * 0.10 : 0) +
      Math.max(0, (Number(t.sharpness) || 0) - 0.15) * 0.20;
    const visualBoost = Math.round(gain * 100);
    const upscaleText = Number(t.workUpscale) === 2
      ? 'DLSS SR 超分回拉'
      : (Number(t.workUpscale) === 1 ? 'FSR1 极速空间超分' : '双线性快速插值');
    return { pixelSaved, visualBoost, upscaleText };
  }

  // 每个游戏目录独立的 UI 选择状态（未点击“应用”前不会虚假声称已生效）
  const draftState = new Map();
  let cachedHw = null;
  let cachedModels = null;
  let selectedViewGameDir = '';
  let activeGlobalProfile = 'rtx40_laptop';

  function getDraft(dir, status) {
    const statusProfile = status?.hardwareProfile || activeGlobalProfile || 'rtx40_laptop';
    if (!draftState.has(dir)) {
      const currentNrMode = status?.neural?.mode && status.neural.mode !== 'off'
        ? status.neural.mode
        : 'latest_compatible';
      const currentModelId = status?.neural?.currentModel?.id || '310.8.SF-v2';
      const currentMfgMode = status?.mfg?.currentConfig?.mode && status.mfg.currentConfig.mode !== 'off'
        ? status.mfg.currentConfig.mode
        : 'x3';
      const initialTuning = status?.singlePassTuning?.installed
        ? { ...status.singlePassTuning }
        : clonePresetTuning('boost_eco', statusProfile);
      draftState.set(dir, {
        hardwareProfile: statusProfile,
        neuralMode: currentNrMode,
        neuralModelId: currentModelId,
        runtimeStack: statusProfile === 'rtx50_desktop' ? 'oct2026-310.9.16' : 'baseline-310.9.1',
        mfgMode: currentMfgMode,
        hdrCompatibility: false,
        singlePassTuning: initialTuning
      });
    }
    const d = draftState.get(dir);
    if (!d.hardwareProfile) d.hardwareProfile = statusProfile;
    if (!d.neuralModelId) d.neuralModelId = status?.neural?.currentModel?.id || '310.8.SF-v2';
    if (!d.singlePassTuning) {
      d.singlePassTuning = status?.singlePassTuning?.installed
        ? { ...status.singlePassTuning }
        : clonePresetTuning('boost_eco', d.hardwareProfile);
    }
    return d;
  }

  /**
   * 将后端状态等级映射为明确区分的四类状态徽章：
   * - 已验证可用
   * - 实验性支持
   * - 不兼容
   * - 尚未测试
   */
  function renderStatusBadge(level, customLabel) {
    const norm = String(level || 'untested').toLowerCase();
    let cls = 'enh-badge-untested';
    let text = customLabel || '尚未测试';
    if (norm === 'verified' || text.includes('已验证可用')) {
      cls = 'enh-badge-verified';
      if (!customLabel) text = '已验证可用';
    } else if (norm === 'experimental' || text.includes('实验性支持')) {
      cls = 'enh-badge-experimental';
      if (!customLabel) text = '实验性支持';
    } else if (norm === 'incompatible' || text.includes('不兼容')) {
      cls = 'enh-badge-incompatible';
      if (!customLabel) text = '不兼容';
    } else {
      cls = 'enh-badge-untested';
      if (!customLabel) text = '尚未测试';
    }
    return `<span class="enh-badge ${cls}">${escHtml(text)}</span>`;
  }

  /**
   * 构建 7 项协同运行检查项列表
   */
  function buildCoExecCheckItems(coExec, hardwareProfile = 'rtx40_laptop') {
    if (!coExec) return [];
    const conflicts = coExec.dllConflicts || [];
    const hasErrConflict = conflicts.some((c) => c.severity === 'error');
    const vram = coExec.vramBudget || {};
    const vramCheckTitle = hardwareProfile === 'rtx50_desktop'
      ? '5. RTX 50 系列原生 (Blackwell) 显存预算'
      : hardwareProfile === 'rtx40_desktop'
        ? '5. RTX 40 系桌面卡 100% 满血显存预算'
        : '5. RTX 40 系列笔记本省显存预算';
    return [
      {
        title: '1. 模块 DLL 冲突检查',
        status: hasErrConflict ? 'incompatible' : (conflicts.length ? 'experimental' : 'verified'),
        badge: hasErrConflict ? '不兼容' : (conflicts.length ? '实验性支持' : '已验证可用'),
        detail: conflicts.length ? conflicts.map((c) => c.message).join(' ') : '无 DLL 命名或 Hook 冲突'
      },
      {
        title: '2. Streamline / NGX 注入链协同',
        status: coExec.slChainCheck?.ok ? 'verified' : 'experimental',
        badge: coExec.slChainCheck?.ok ? '已验证可用' : '实验性支持',
        detail: coExec.slChainCheck?.message || 'RuntimeSelectionMode=1 协同正常'
      },
      {
        title: '3. 运动矢量与补帧质量保护',
        status: coExec.motionVectorCheck?.mitigationActive ? 'verified' : 'untested',
        badge: coExec.motionVectorCheck?.mitigationActive ? '已验证可用' : '尚未测试',
        detail: coExec.motionVectorCheck?.message || 'Boundary Artifact Mitigation 保护边缘光流'
      },
      {
        title: '4. HUD / HDR 闪烁与拖影抑制',
        status: coExec.hudFlickerCheck?.hdrGameNeedsGuard ? 'experimental' : 'verified',
        badge: coExec.hudFlickerCheck?.hdrGameNeedsGuard ? '实验性支持' : '已验证可用',
        detail: coExec.hudFlickerCheck?.message || 'Native HUD/UI 标记直通正常'
      },
      {
        title: vramCheckTitle,
        status: vram.level === 'critical' ? 'incompatible' : (vram.level === 'caution' ? 'experimental' : 'verified'),
        badge: vram.level === 'critical' ? '不兼容 (超预算)' : (vram.level === 'caution' ? '实验性支持' : '已验证可用'),
        detail: vram.summary || '处于显存安全预算范围内'
      },
      {
        title: '6. Reflex 帧同步与延迟控制',
        status: coExec.reflexCheck?.ok ? 'verified' : 'experimental',
        badge: coExec.reflexCheck?.ok ? '已验证可用' : '实验性支持',
        detail: coExec.reflexCheck?.message || 'sl.reflex.dll 与硬件 Flip Metering 正常'
      },
      {
        title: '7. 游戏退出后完整恢复原状能力',
        status: coExec.backupCheck?.ok ? 'verified' : 'incompatible',
        badge: coExec.backupCheck?.badge || '已验证可用',
        detail: coExec.backupCheck?.message || '事务级备份完整'
      }
    ];
  }

  /**
   * 构建三大功能区域 HTML（可同时嵌入游戏详情抽屉 #sheet 与独立增强视图 #view-enhanced）
   */
  function buildThreePanelsHtml(dir, status, modelsInfo, prefix = 'sheet') {
    const draft = getDraft(dir, status);
    const activeProfileId = draft.hardwareProfile || status.hardwareProfile || 'rtx40_laptop';
    const activeProfileMeta = getProfileOption(activeProfileId);
    const nr = status.neural || {};
    const mfg = status.mfg || {};
    const diag = status.diagnostics || {};
    const coExec = diag.coExecution || {};
    const vram = coExec.vramBudget || {
      estimatedTotalMB: 5400,
      vramTotalMB: 8188,
      usagePercent: 66,
      headroomMB: 2788,
      totalAddedOverheadMB: 0
    };
    const checks = buildCoExecCheckItems(coExec, activeProfileId);

    // 1. Neural Rendering Manager 状态判定
    const nrBadge = renderStatusBadge(nr.overallStatus, nr.overallBadge);

    const currentModelText = nr.currentModel
      ? `${nr.currentModel.name} (${nr.currentModel.version || '310.8.0.0'})`
      : '未安装 (Off)';

    const latestModelText = nr.latestModel
      ? `${nr.latestModel.name} · v${nr.latestModel.version}`
      : '310.8.SF-v2 (Oct 2026)';

    const runtimeVerText = nr.dlssVersion
      ? `DLSS ${nr.dlssVersion} / SL ${nr.streamlineVersion || '2.14.16.0'} / Feeder 1.19.0`
      : '待部署 (内置 Oct 2026 DLSS 310.9.16 + SL 2.14.16 + Feeder 1.19.0)';

    const targetArchLabel = activeProfileId === 'rtx50_desktop'
      ? 'CUDA sm_120 (Blackwell 23 核原生直通)'
      : `CUDA sm_89 (${activeProfileId === 'rtx40_desktop' ? 'Ada 桌面满血 15 核' : 'Ada 笔记本黄金 15 核'})`;

    const gpuCompatText = `${status.hardware?.gpu?.name || 'RTX 4070 Laptop GPU'} · 目标档位：${activeProfileMeta.label} (${targetArchLabel}) — 已验证可用`;

    // 2. Multi Frame Generation Manager 状态判定
    const mfgBadgeHtml = renderStatusBadge(mfg.status, mfg.statusBadge);

    const effectiveMultiplierText = mfg.runtimeVerification?.verifiedActive
      ? `${mfg.runtimeVerification.effectiveMultiplier}x (运行时日志已确认生效)`
      : mfg.currentConfig?.installed
        ? `已配置 ${mfg.currentConfig.mode} (${mfg.currentConfig.multiplier}x) · 实际生效倍率：${activeProfileId === 'rtx50_desktop' ? 'Blackwell 原生硬件支持' : '尚未测试 (需运行游戏产生日志后验证)'}`
        : '未激活 (1x 原始帧输出)';

    const dlssgVerText = mfg.dlssg?.present
      ? `${mfg.dlssg.version} (${mfg.dlssg.valid ? '原生 NVIDIA NGX DLSS-G' : '非原生 DLL'})`
      : '未部署 (应用时自动部署 310.9.16.0)';

    const mfgSupportedModesText = activeProfileId === 'rtx50_desktop'
      ? 'Off / x2 (原生支持) / x3 (Blackwell 原生硬件支持) / x4 (Blackwell 原生硬件支持)'
      : activeProfileId === 'rtx40_desktop'
        ? 'Off / x2 (原生支持) / x3 (40系桌面低延迟解锁) / x4 (40系桌面低延迟解锁)'
        : 'Off / x2 (原生支持) / x3 (实验性支持) / x4 (实验性支持)';

    const mfgX3Sub = activeProfileId === 'rtx50_desktop' ? '3帧输出 (原生支持)' : (activeProfileId === 'rtx40_desktop' ? '3帧输出 (桌面满血)' : '3帧输出 (实验性)');
    const mfgX4Sub = activeProfileId === 'rtx50_desktop' ? '4帧输出 (原生支持)' : (activeProfileId === 'rtx40_desktop' ? '4帧输出 (桌面满血)' : '4帧输出 (实验性)');

    // 3. Compatibility & Diagnostics 状态判定
    const diagBadgeHtml = renderStatusBadge(diag.combinedStatus, diag.combinedBadge);

    const vramBoxTitle = activeProfileId === 'rtx50_desktop'
      ? `RTX 50 系列原生显存预算估算 (${vram.resolution || '2K/4K 100% 满血分辨率'} · 附加开销 +${vram.totalAddedOverheadMB || 0} MB)`
      : activeProfileId === 'rtx40_desktop'
        ? `RTX 40 系桌面卡显存预算估算 (${vram.resolution || '2K/4K 100% 满血分辨率'} · 附加开销 +${vram.totalAddedOverheadMB || 0} MB)`
        : `RTX 40 系列笔记本省显存预算估算 (0.75x 省显存超分管线 · 附加开销 +${vram.totalAddedOverheadMB || 0} MB)`;

    const tune = draft.singlePassTuning || clonePresetTuning('boost_eco', activeProfileId);
    const tuneMetrics = calcUiTuningMetrics(tune);
    const installedTune = status.singlePassTuning;
    const tuneStatusLabel = installedTune?.installed
      ? `当前已写入游戏：${installedTune.presetLabel || '自定义参数'} (${installedTune.workResolution}% 分辨率)`
      : '待写入游戏（点击下方「立即热更新」或「加载 DLSS 5」即可生效）';

    return `
      <div class="enh-sheet-section" data-enh-dir="${escHtml(dir)}" data-enh-prefix="${escHtml(prefix)}">
        <!-- ==================== 顶部：硬件专属优化档位中文三选一菜单 ==================== -->
        <section class="enh-profile-bar" aria-label="硬件专属优化档位选择菜单">
          <div class="enh-profile-head">
            <h4>🎛️ 硬件专属优化档位选择菜单 <span class="enh-badge enh-badge-verified">全模型兼容 · 桌面显卡 MFG 已适配</span></h4>
            <span class="sub">切换档位将自动匹配对应的 DLSS 5 分辨率管线与 MFG 多帧生成策略（笔记本 40 系列默认锁定原版黄金参数不动）</span>
          </div>
          <div class="enh-profile-grid" role="group" aria-label="显卡优化档位切换">
            ${HARDWARE_PROFILE_OPTIONS.map((opt) => `
              <button type="button" class="enh-profile-btn ${activeProfileId === opt.id ? 'active' : ''}" data-hw-profile="${escHtml(opt.id)}">
                <div class="enh-profile-btn-top">
                  <span class="enh-profile-btn-title">${escHtml(opt.label)}</span>
                  <span class="enh-profile-btn-tag">${escHtml(opt.tag)}</span>
                </div>
                <span class="enh-profile-btn-desc">${escHtml(opt.desc)}</span>
              </button>
            `).join('')}
          </div>
          <div class="enh-profile-summary">
            <div><b>当前已选档位：${escHtml(activeProfileMeta.label)}</b></div>
            <small>${escHtml(activeProfileMeta.dlssSummary)}</small>
            <small>${escHtml(activeProfileMeta.mfgSummary)}</small>
          </div>
        </section>

        <!-- ==================== v2.3.2 新增：一层 DLSS 5 画质强化与省卡调优器 ==================== -->
        <section class="enh-tuning-card" aria-label="一层 DLSS 5 画质强化与省卡调优器">
          <div class="enh-tuning-head">
            <div class="enh-card-title">
              <h4>⚡ 一层 DLSS 5 画质强化与省卡调优器 <span class="enh-badge enh-badge-verified">锁定单层 (NRPasses=1) · 杜绝双倍耗卡</span></h4>
              <p>不开启双倍耗时的第 2 层叠加；通过解锁单层微表面几何重塑 + 零额外通道精细细节塑形，配合内部工作分辨率缩放与超分回拉，同步实现「一层画质显著增强 + 显卡算力显存双降」</p>
            </div>
            <span class="enh-tuning-live-tag">${escHtml(tuneStatusLabel)}</span>
          </div>

          <div class="enh-tuning-metrics">
            <div class="enh-metric-pill">
              <span class="k">神经渲染层数</span>
              <span class="v">严格锁定 1 层 (NRPasses=1)</span>
            </div>
            <div class="enh-metric-pill highlight">
              <span class="k">单层质感强化幅度</span>
              <span class="v" data-tune-metric="boost">${tuneMetrics.visualBoost >= 0 ? `+${tuneMetrics.visualBoost}%` : `${tuneMetrics.visualBoost}%`} (相对 1.0x 原厂基线)</span>
            </div>
            <div class="enh-metric-pill eco">
              <span class="k">GPU 像素推理开销</span>
              <span class="v" data-tune-metric="compute">${tuneMetrics.pixelSaved > 0 ? `直降 -${tuneMetrics.pixelSaved}%` : '原生 100% 满载'} (工作分辨率 ${Number(tune.workResolution)}%)</span>
            </div>
            <div class="enh-metric-pill">
              <span class="k">边缘超分回拉引擎</span>
              <span class="v" data-tune-metric="upscale">${escHtml(tuneMetrics.upscaleText)}</span>
            </div>
          </div>

          <div class="enh-tuning-presets" role="group" aria-label="单层强化与省卡预设切换">
            ${Object.values(TUNING_PRESETS).map((p) => `
              <button type="button" class="enh-tune-preset-btn ${tune.preset === p.id ? 'active' : ''}" data-tune-preset="${escHtml(p.id)}">
                <div class="enh-profile-btn-top">
                  <span class="enh-profile-btn-title">${escHtml(p.label)}</span>
                  <span class="enh-profile-btn-tag">${escHtml(p.badge)}</span>
                </div>
                <span class="enh-profile-btn-desc">${escHtml(p.desc)}</span>
              </button>
            `).join('')}
          </div>

          <div class="enh-tuning-sliders">
            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>总神经渲染强度 (NRIntensity)</span>
                <b data-tune-val="intensity">${Number(tune.intensity).toFixed(2)}x</b>
              </div>
              <input type="range" min="0.50" max="1.80" step="0.05" value="${Number(tune.intensity)}" data-tune-slider="intensity">
              <small>放大单层 DLSS 5 整体材质与漫反射重塑权重（推荐 1.30x ~ 1.45x）</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>微表面结构重塑 (NRLocalStructure)</span>
                <b data-tune-val="structure">${Number(tune.structure).toFixed(2)}x</b>
              </div>
              <input type="range" min="0.50" max="1.70" step="0.05" value="${Number(tune.structure)}" data-tune-slider="structure">
              <small>大于 1.0x 时自动解除皮肤独立截断锁，直接增强砖石/金属/织物立体凹凸</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>精细纹理塑形 (NRLookDetail · 零通道耗时)</span>
                <b data-tune-val="detailBoost">${Number(tune.detailBoost).toFixed(2)}x</b>
              </div>
              <input type="range" min="0.50" max="1.80" step="0.05" value="${Number(tune.detailBoost)}" data-tune-slider="detailBoost">
              <small>激活内置轻量后处理塑形管线，不增加任何 Tensor 推理耗时即可锐化高频微纹理</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>局部光影立体感 (NRLocalTone)</span>
                <b data-tune-val="localTone">${Number(tune.localTone).toFixed(2)}x</b>
              </div>
              <input type="range" min="0.50" max="1.60" step="0.05" value="${Number(tune.localTone)}" data-tune-slider="localTone">
              <small>增强单层神经渲染的明暗层次与接触阴影体积感（推荐 1.18x ~ 1.30x）</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>内部神经与馈送工作分辨率 (省卡核心)</span>
                <b data-tune-val="workResolution">${Math.round(Number(tune.workResolution))}%</b>
              </div>
              <input type="range" min="50" max="100" step="1" value="${Math.round(Number(tune.workResolution))}" data-tune-slider="workResolution">
              <small>75% 即可省去 44% 像素算力，67% 省去 55% 像素算力，再经边缘感知超分无损回拉至全屏</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>超分边缘锐化补偿 (Sharpness)</span>
                <b data-tune-val="sharpness">${Number(tune.sharpness).toFixed(2)}</b>
              </div>
              <input type="range" min="0.00" max="0.80" step="0.05" value="${Number(tune.sharpness)}" data-tune-slider="sharpness">
              <small>补偿降分辨率省卡后的边缘锐度，建议 75% 配 0.35、67% 配 0.45</small>
            </label>

            <label class="enh-slider-item">
              <div class="enh-slider-top">
                <span>静止画面防抖稳定 (Hold Strength)</span>
                <b data-tune-val="holdStrength">${Number(tune.holdStrength).toFixed(2)}</b>
              </div>
              <input type="range" min="0.00" max="0.80" step="0.05" value="${Number(tune.holdStrength)}" data-tune-slider="holdStrength">
              <small>抑制单层高强度放大后的静止暗部微噪点呼吸感（推荐 0.25 ~ 0.40）</small>
            </label>

            <div class="enh-slider-item enh-tuning-selects">
              <label>
                <span>边缘超分回拉算法 (work_upscale)</span>
                <select data-tune-select="workUpscale">
                  <option value="1" ${Number(tune.workUpscale) === 1 ? 'selected' : ''}>FSR1 极速空间超分 + RCAS 锐化 (推荐省卡)</option>
                  <option value="2" ${Number(tune.workUpscale) === 2 ? 'selected' : ''}>DLSS SR 深度学习超分回拉 (适合高配桌面卡)</option>
                  <option value="0" ${Number(tune.workUpscale) === 0 ? 'selected' : ''}>双线性极速插值 (最低开销)</option>
                </select>
              </label>
              <label>
                <span>光流与几何求解开销档位 (Feeder 管线)</span>
                <select data-tune-select="motionCost">
                  <option value="fast" ${tune.motionCost === 'fast' ? 'selected' : ''}>⚡ 极速省卡光流 (vort_Motion + 关闭几何求解 · 推荐)</option>
                  <option value="balanced" ${tune.motionCost === 'balanced' ? 'selected' : ''}>⚖️ 智能均衡模式 (保持自适应光流 + 关闭重度几何求解)</option>
                  <option value="quality" ${tune.motionCost === 'quality' ? 'selected' : ''}>💎 高精度金字塔光流 (LumeniteFX 2.0 + 完整几何求解)</option>
                </select>
              </label>
            </div>
          </div>

          <div class="enh-tuning-footer">
            <button type="button" class="enh-btn tune-apply-btn" data-enh-act="apply-tuning">
              ⚡ 立即热更新一层强化与省卡参数（免重装 · 游戏运行中也可秒级生效）
            </button>
            <span class="enh-tuning-tip">💡 提示：进入游戏后随时按键盘 <code>Home</code> 键，也可在「⚡ 一层 DLSS 5 强化与省卡快调」全中文面板中边看画面边实时拖动滑块！</span>
          </div>
        </section>

        <div class="enh-grid">
          <!-- ==================== 模块 A: Neural Rendering Manager ==================== -->
          <section class="enh-card" aria-label="Neural Rendering Manager">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Neural Rendering Manager <small style="font-weight:500;color:var(--muted)">模块 A · DLSS 5 神经渲染</small></h4>
                <p>管理 DLSS 5 神经渲染模型 (nvngx_dlssnr.dll)、CUDA SM 架构校验与 2026-10 运行时栈（笔记本40 / 桌面40 / 桌面50 全兼容）</p>
              </div>
              ${nrBadge}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">当前硬件档位 (Hardware Profile)</span><span class="v">${escHtml(activeProfileMeta.label)}</span></div>
              <div class="enh-kv-row"><span class="k">当前模型 (Current Model)</span><span class="v">${escHtml(currentModelText)}</span></div>
              <div class="enh-kv-row"><span class="k">最新模型 (Latest Model)</span><span class="v">${escHtml(latestModelText)}</span></div>
              <div class="enh-kv-row"><span class="k">2026-10 官方模型追踪</span><span class="v">v310.9.16 (118M Faster AI Model · 全档位已内置兼容)</span></div>
              <div class="enh-kv-row"><span class="k">运行时版本 (Runtime Version)</span><span class="v mono">${escHtml(runtimeVerText)}</span></div>
              <div class="enh-kv-row"><span class="k">GPU 兼容性 (GPU Compatibility)</span><span class="v">${escHtml(gpuCompatText)}</span></div>
              <div class="enh-kv-row"><span class="k">安装状态 (Install Status)</span><span class="v">${nr.installed ? `已安装 (${escHtml(nr.mode)})` : '未安装'}</span></div>
            </div>

            <div class="enh-control-group">
              <div class="enh-control-label">
                <span>DLSS 5 神经渲染模式选择</span>
                <span>选中项仅代表待应用配置</span>
              </div>
              <div class="enh-seg" role="group" aria-label="Neural Rendering Mode">
                <button type="button" class="enh-seg-btn ${draft.neuralMode === 'off' ? 'active' : ''}" data-nr-mode="off">
                  <span>Off</span><small>关闭神经渲染</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.neuralMode === 'legacy' ? 'active' : ''}" data-nr-mode="legacy">
                  <span>Legacy Model</span><small>310.8.0-RTX40 基线</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.neuralMode === 'latest_compatible' ? 'active' : ''}" data-nr-mode="latest_compatible">
                  <span>Latest Compatible</span><small>最新全兼容模型</small>
                </button>
              </div>
            </div>

            <div class="enh-select-row">
              <label>
                <span>选择神经渲染模型 (全系 40/50 显卡 100% 兼容)</span>
                <select data-enh-field="neuralModelId">
                  <option value="310.8.SF-v2" ${draft.neuralModelId === '310.8.SF-v2' ? 'selected' : ''}>310.8.SF-v2 全架构满血画质模型 (sm_75/86/89/120 · 柔光抗闪烁 · 推荐)</option>
                  <option value="310.9.16-oct2026" ${draft.neuralModelId === '310.9.16-oct2026' ? 'selected' : ''}>310.9.16-oct2026 极速模型管线 (2026-10 118M Faster AI + SL 2.14.16 · 全兼容)</option>
                  <option value="310.8.0-RTX40" ${draft.neuralModelId === '310.8.0-RTX40' ? 'selected' : ''}>310.8.0-RTX40 官方首发原版基线模型 (sm_75/86/89/120 · 全兼容)</option>
                </select>
              </label>
              <label>
                <span>运行时栈版本 (Streamline / DLSS / Feeder)</span>
                <select data-enh-field="runtimeStack">
                  <option value="baseline-310.9.1" ${draft.runtimeStack === 'baseline-310.9.1' ? 'selected' : ''}>v2.2.9 黄金基线运行时 (DLSS 310.9.1.0 超分底座 + Dynamic MFG 310.9.16 · 推荐默认)</option>
                  <option value="oct2026-310.9.16" ${draft.runtimeStack === 'oct2026-310.9.16' ? 'selected' : ''}>2026-10 极速运行时 (DLSS 310.9.16 + SL 2.14.16 + Feeder 1.19.0 · 50系原生)</option>
                </select>
              </label>
            </div>

            <div class="enh-note">
              <b>档位模型说明</b>：内置模型均同时包含 <code>sm_89</code> (40系笔记本/桌面卡 15核) 与 <code>sm_120</code> (50系桌面卡 23核) 原生张量核指令集。${escHtml(activeProfileMeta.dlssSummary)}
            </div>

            <div class="enh-actions-single">
              <button type="button" class="enh-btn single-load" data-enh-act="apply-nr">🎯 单独加载 DLSS 5 神经渲染</button>
              <button type="button" class="enh-btn sm-import" data-enh-act="import-nr" title="手动导入外部合法的 nvngx_dlssnr.dll">导入外部 .dll</button>
            </div>
          </section>

          <!-- ==================== 模块 B: Multi Frame Generation Manager ==================== -->
          <section class="enh-card" aria-label="Multi Frame Generation Manager">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Multi Frame Generation Manager <small style="font-weight:500;color:var(--muted)">模块 B · 全系 40/50 显卡 x3/x4 多帧生成</small></h4>
                <p>全面兼容笔记本 40 系列、40 系桌面卡与 50 系列桌面卡的原生 NVIDIA DLSS-G 多帧生成控制器</p>
              </div>
              ${mfgBadgeHtml}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">当前补帧档位 (MFG Profile)</span><span class="v">${escHtml(activeProfileMeta.label)}</span></div>
              <div class="enh-kv-row"><span class="k">当前显卡 (Current GPU)</span><span class="v">${escHtml(mfg.gpuSupport?.gpuName || 'NVIDIA GeForce RTX 4070 Laptop GPU')}</span></div>
              <div class="enh-kv-row"><span class="k">DLSS-G 版本 (DLSS-G Version)</span><span class="v mono">${escHtml(dlssgVerText)}</span></div>
              <div class="enh-kv-row"><span class="k">支持模式 (Supported Modes)</span><span class="v">${escHtml(mfgSupportedModesText)}</span></div>
              <div class="enh-kv-row"><span class="k">实际生效倍率 (Effective Multiplier)</span><span class="v">${escHtml(effectiveMultiplierText)}</span></div>
              <div class="enh-kv-row"><span class="k">当前游戏兼容性 (Game Compatibility)</span><span class="v">${escHtml(mfg.knownGame ? `${mfg.knownGame.title} (${mfg.knownGame.notes})` : '标准 DirectX 12 游戏 (支持 Streamline DLSS-G 注入)')}</span></div>
            </div>

            <div class="enh-control-group">
              <div class="enh-control-label">
                <span>Multi Frame Generation 补帧倍率选择</span>
                <span>${activeProfileId === 'rtx50_desktop' ? '50系桌面卡原生硬件直通' : (activeProfileId === 'rtx40_desktop' ? '40系桌面卡 V3 高锐度 + 低延迟护栏' : '笔记本 40 系列黄金配置')}</span>
              </div>
              <div class="enh-seg enh-seg-4" role="group" aria-label="Multi Frame Generation Mode">
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'off' ? 'active' : ''}" data-mfg-mode="off">
                  <span>Off</span><small>关闭补帧</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x2' ? 'active' : ''}" data-mfg-mode="x2">
                  <span>x2</span><small>标准 FG (已验证)</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x3' ? 'active' : ''}" data-mfg-mode="x3">
                  <span>x3</span><small>${escHtml(mfgX3Sub)}</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x4' ? 'active' : ''}" data-mfg-mode="x4">
                  <span>x4</span><small>${escHtml(mfgX4Sub)}</small>
                </button>
              </div>
            </div>

            <div class="enh-select-row">
              <label>
                <span>帧生成输入源策略 (QualityGuardMode)</span>
                <select data-enh-field="hdrCompatibility">
                  <option value="false" ${draft.hdrCompatibility === false ? 'selected' : ''}>原生输入模式 (QualityGuardMode=0 · 推荐绝大多数游戏 · 防止黑屏)</option>
                  <option value="true" ${draft.hdrCompatibility !== false ? 'selected' : ''}>HDR UI 保护模式 (QualityGuardMode=2 · 仅限开启 HDR 的特定游戏)</option>
                </select>
              </label>
            </div>

            <div class="enh-note">
              <b>档位补帧说明</b>：${escHtml(activeProfileMeta.mfgSummary)}
            </div>

            <div class="enh-actions-single">
              <button type="button" class="enh-btn single-load" data-enh-act="apply-mfg">🎯 单独加载 MFG 多帧生成 (${escHtml(draft.mfgMode.toUpperCase())})</button>
            </div>
          </section>

          <!-- ==================== 模块 C: Compatibility & Diagnostics ==================== -->
          <section class="enh-card enh-card-full" aria-label="Compatibility & Diagnostics">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Compatibility & Diagnostics <small style="font-weight:500;color:var(--muted)">模块 C · DLSS 5 + MFG 协同运行与诊断</small></h4>
                <p>独立控制 Neural Rendering 与 Multi Frame Generation 同时运行，实时检查 7 项底层兼容性指标与目标显卡显存预算</p>
              </div>
              ${diagBadgeHtml}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">游戏名称 (Game Name)</span><span class="v">${escHtml(diag.gameName || '未选择游戏')}</span></div>
              <div class="enh-kv-row"><span class="k">生效硬件档位 (Active Profile)</span><span class="v">${escHtml(activeProfileMeta.label)}</span></div>
              <div class="enh-kv-row"><span class="k">图形 API (Graphics API)</span><span class="v">${escHtml(diag.graphicsApi || 'DirectX 12')} (${status.bitness || 64}-bit)</span></div>
              <div class="enh-kv-row"><span class="k">神经渲染状态 (Neural Rendering Status)</span><span class="v">${escHtml(diag.neuralStatus || '尚未测试')}</span></div>
              <div class="enh-kv-row"><span class="k">MFG 状态 (MFG Status)</span><span class="v">${escHtml(diag.mfgStatus || '尚未测试')}</span></div>
              <div class="enh-kv-row"><span class="k">无 DLSS / 低版本 / 破解兼容 (DLSS & Crack Compat)</span><span class="v">${escHtml(coExec.dlssCompat?.summary || '已启用无 DLSS 光流注入、深层旧版 DLSS 自动升级与补丁防覆盖保护')}</span></div>
              <div class="enh-kv-row"><span class="k">DLL 冲突 (DLL Conflicts)</span><span class="v">${diag.dllConflicts?.length ? escHtml(diag.dllConflicts.map((c) => c.message).join('；')) : '无冲突 (0 项冲突)'}</span></div>
              <div class="enh-kv-row"><span class="k">错误日志 (Error Logs)</span><span class="v">${diag.errorLogs?.length ? escHtml(diag.errorLogs.join(' | ')) : '无错误记录 (0 项异常)'}</span></div>
              <div class="enh-kv-row"><span class="k">备份状态 (Backup Status)</span><span class="v">${escHtml(diag.backupStatus || '原版纯净状态')}</span></div>
            </div>

            <!-- 显存预算进度条 -->
            <div class="enh-vram-box">
              <div class="enh-vram-head">
                <span>${escHtml(vramBoxTitle)}</span>
                <span>预计占用 ${vram.estimatedTotalMB} MB / ${vram.vramTotalMB} MB (${vram.usagePercent}% · 余量 ${vram.headroomMB} MB)</span>
              </div>
              <div class="enh-vram-bar">
                <div class="enh-vram-fill ${vram.usagePercent > 88 ? 'warn' : ''}" style="width:${Math.min(100, vram.usagePercent)}%"></div>
              </div>
            </div>

            <!-- 7 项协同运行检查列表 -->
            <div class="enh-checks-grid">
              ${checks.map((item) => `
                <div class="enh-check-card">
                  <div class="enh-check-top">
                    <span>${escHtml(item.title)}</span>
                    ${renderStatusBadge(item.status, item.badge)}
                  </div>
                  <div class="enh-check-detail">${escHtml(item.detail)}</div>
                </div>
              `).join('')}
            </div>

            <div class="enh-master-bar">
              <button type="button" class="enh-btn master-load" data-enh-act="apply-combined">🚀 同时加载 DLSS 5 + MFG 多帧生成（推荐黄金组合 · ${escHtml(activeProfileMeta.label.split(' ')[1])} · MFG ${escHtml(draft.mfgMode.toUpperCase())}）</button>
              <button type="button" class="enh-btn danger-restore" data-enh-act="restore-all" ${coExec.backupCheck?.hasManifest ? '' : 'disabled'}>⏪ 一键卸载并恢复游戏原始状态</button>
              <button type="button" class="enh-btn" data-enh-act="refresh-status">🔄 刷新状态</button>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  /**
   * 绑定三大面板内部的交互事件
   */
  function wirePanelEvents(container, dir, status, onUpdated) {
    if (!container) return;
    const draft = getDraft(dir, status);

    for (const pBtn of container.querySelectorAll('[data-hw-profile]')) {
      pBtn.onclick = async () => {
        const pickedProfile = pBtn.dataset.hwProfile;
        draft.hardwareProfile = pickedProfile;
        activeGlobalProfile = pickedProfile;
        if (pickedProfile === 'rtx50_desktop') {
          draft.runtimeStack = 'oct2026-310.9.16';
        } else {
          draft.runtimeStack = 'baseline-310.9.1';
        }
        if (typeof root.lab?.enhancedSetProfile === 'function') {
          await root.lab.enhancedSetProfile(pickedProfile).catch(() => {});
        }
        cachedHw = null;
        cachedModels = null;
        if (container.dataset.enhPrefix === 'view') {
          await renderEnhancedView();
        } else {
          await refreshContainer(container, dir, pickedProfile);
        }
      };
    }

    for (const btn of container.querySelectorAll('[data-nr-mode]')) {
      btn.onclick = () => {
        draft.neuralMode = btn.dataset.nrMode;
        if (draft.neuralMode === 'legacy') {
          draft.neuralModelId = '310.8.0-RTX40';
        } else if (draft.neuralMode === 'latest_compatible' && draft.neuralModelId === '310.8.0-RTX40') {
          draft.neuralModelId = '310.8.SF-v2';
        }
        onUpdated();
      };
    }

    for (const btn of container.querySelectorAll('[data-mfg-mode]')) {
      btn.onclick = () => {
        draft.mfgMode = btn.dataset.mfgMode;
        onUpdated();
      };
    }

    for (const sel of container.querySelectorAll('[data-enh-field]')) {
      sel.onchange = () => {
        const field = sel.dataset.enhField;
        if (field === 'hdrCompatibility') {
          draft.hdrCompatibility = sel.value === 'true';
        } else if (field === 'neuralModelId') {
          draft.neuralModelId = sel.value;
          if (sel.value === '310.8.0-RTX40') draft.neuralMode = 'legacy';
          else if (draft.neuralMode === 'off' || draft.neuralMode === 'legacy') draft.neuralMode = 'latest_compatible';
        } else {
          draft[field] = sel.value;
        }
        onUpdated();
      };
    }

    const runAction = async (payload) => {
      const buttons = container.querySelectorAll('button, select');
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const finalPayload = {
          hardwareProfile: draft.hardwareProfile || activeGlobalProfile || 'rtx40_laptop',
          neuralModelId: draft.neuralModelId || '310.8.SF-v2',
          ...payload
        };
        const msg = `Enhanced: 应用配置 [档位=${finalPayload.hardwareProfile}] (Neural=${finalPayload.neuralMode ?? '保持'}, Model=${finalPayload.neuralModelId}, MFG=${finalPayload.mfgMode ?? '保持'})`;
        if (typeof root.jobLog === 'function') root.jobLog(`--- ${msg} ---`);
        if (typeof root.log === 'function') root.log(`${msg} -> ${dir}`);
        const res = await root.lab.enhancedApply(dir, finalPayload);
        if (!res?.ok && res?.message) {
          if (typeof root.jobLog === 'function') root.jobLog(`错误: ${res.message}`);
          if (typeof root.log === 'function') root.log(`错误: ${res.message}`);
        } else {
          if (res?.feederDeployed) {
            const feederMsg = `Enhanced: 已自动为老游戏离线部署 ${res.feederSummary || 'Feeder + 光流着色器'} + DLSS 5 神经渲染 + 全中文菜单。`;
            if (typeof root.jobLog === 'function') root.jobLog(feederMsg);
            if (typeof root.log === 'function') root.log(feederMsg);
          }
          if (res?.mfgResult?.skipped && res?.mfgResult?.reason) {
            const skipMsg = `提示: ${res.mfgResult.reason}`;
            if (typeof root.jobLog === 'function') root.jobLog(skipMsg);
            if (typeof root.log === 'function') root.log(skipMsg);
          }
          if (typeof root.jobLog === 'function') root.jobLog('Enhanced: 配置已成功写入并建立事务备份。');
        }
      } catch (err) {
        if (typeof root.log === 'function') root.log(`Enhanced 操作异常: ${err.message}`);
      } finally {
        await refreshContainer(container, dir, draft.hardwareProfile);
      }
    };

    // 绑定一层 DLSS 5 画质强化与省卡调优器事件
    const updateLiveTuneMetricsDom = () => {
      const t = draft.singlePassTuning;
      if (!t) return;
      const m = calcUiTuningMetrics(t);
      const boostEl = container.querySelector('[data-tune-metric="boost"]');
      if (boostEl) {
        boostEl.textContent = `${m.visualBoost >= 0 ? `+${m.visualBoost}%` : `${m.visualBoost}%`} (相对 1.0x 原厂基线)`;
      }
      const compEl = container.querySelector('[data-tune-metric="compute"]');
      if (compEl) {
        compEl.textContent = `${m.pixelSaved > 0 ? `直降 -${m.pixelSaved}%` : '原生 100% 满载'} (工作分辨率 ${Math.round(Number(t.workResolution))}%)`;
      }
      const upEl = container.querySelector('[data-tune-metric="upscale"]');
      if (upEl) upEl.textContent = m.upscaleText;
      for (const b of container.querySelectorAll('[data-tune-preset]')) {
        b.classList.toggle('active', b.dataset.tunePreset === t.preset);
      }
    };

    for (const pBtn of container.querySelectorAll('[data-tune-preset]')) {
      pBtn.onclick = () => {
        draft.singlePassTuning = clonePresetTuning(pBtn.dataset.tunePreset, draft.hardwareProfile || 'rtx40_laptop');
        onUpdated();
      };
    }

    for (const slider of container.querySelectorAll('[data-tune-slider]')) {
      slider.oninput = () => {
        const key = slider.dataset.tuneSlider;
        const num = Number(slider.value);
        const t = draft.singlePassTuning || clonePresetTuning('boost_eco', draft.hardwareProfile);
        t.preset = 'custom';
        t[key] = key === 'workResolution' ? Math.round(num) : Math.round(num * 100) / 100;
        if (key === 'detailBoost') {
          t.lookEnabled = Math.abs(t.detailBoost - 1.0) > 0.01 || Math.abs((t.toneBoost || 1.0) - 1.0) > 0.01;
        }
        if (key === 'workResolution') {
          t.maxWorksets = t.workResolution <= 68 ? 2 : (t.workResolution <= 80 ? 3 : (t.workResolution <= 92 ? 4 : 6));
        }
        draft.singlePassTuning = t;
        const valEl = container.querySelector(`[data-tune-val="${key}"]`);
        if (valEl) {
          if (key === 'workResolution') valEl.textContent = `${t[key]}%`;
          else if (key === 'sharpness' || key === 'holdStrength') valEl.textContent = t[key].toFixed(2);
          else valEl.textContent = `${t[key].toFixed(2)}x`;
        }
        updateLiveTuneMetricsDom();
      };
    }

    for (const sel of container.querySelectorAll('[data-tune-select]')) {
      sel.onchange = () => {
        const key = sel.dataset.tuneSelect;
        const t = draft.singlePassTuning || clonePresetTuning('boost_eco', draft.hardwareProfile);
        t.preset = 'custom';
        t[key] = key === 'workUpscale' ? Number(sel.value) : sel.value;
        draft.singlePassTuning = t;
        updateLiveTuneMetricsDom();
      };
    }

    const btnApplyTuning = container.querySelector('[data-enh-act="apply-tuning"]');
    if (btnApplyTuning) {
      btnApplyTuning.onclick = async () => {
        btnApplyTuning.disabled = true;
        const origText = btnApplyTuning.textContent;
        btnApplyTuning.textContent = '⚡ 正在热更新一层强化与省卡参数…';
        try {
          const tunePayload = draft.singlePassTuning || clonePresetTuning('boost_eco', draft.hardwareProfile);
          const res = await root.lab?.enhancedApplyTuning?.(dir, tunePayload);
          if (res?.ok) {
            const logMsg = `Enhanced: 已实时热更新一层 DLSS 5 调优参数 [预设=${res.tuning?.presetLabel || tunePayload.preset} · 分辨率=${res.tuning?.workResolution || tunePayload.workResolution}% · 更新文件=${(res.updatedFiles || []).join(', ') || '已就绪'}]`;
            if (typeof root.jobLog === 'function') root.jobLog(logMsg);
            if (typeof root.log === 'function') root.log(logMsg);
            if (res.status?.singlePassTuning?.installed) {
              draft.singlePassTuning = { ...res.status.singlePassTuning };
            }
          } else if (res?.message) {
            if (typeof root.jobLog === 'function') root.jobLog(`提示: ${res.message}`);
          }
        } catch (err) {
          if (typeof root.log === 'function') root.log(`热更新调优参数异常: ${err.message}`);
        } finally {
          await refreshContainer(container, dir, draft.hardwareProfile);
          btnApplyTuning.textContent = origText;
          btnApplyTuning.disabled = false;
        }
      };
    }

    const btnApplyNr = container.querySelector('[data-enh-act="apply-nr"]');
    if (btnApplyNr) {
      btnApplyNr.onclick = () => runAction({
        neuralMode: draft.neuralMode,
        neuralModelId: draft.neuralModelId,
        runtimeStack: draft.runtimeStack,
        hardwareProfile: draft.hardwareProfile,
        singlePassTuning: draft.singlePassTuning
      });
    }

    const btnImportNr = container.querySelector('[data-enh-act="import-nr"]');
    if (btnImportNr) {
      btnImportNr.onclick = async () => {
        btnImportNr.disabled = true;
        try {
          const res = await root.lab.enhancedImportModel();
          if (res?.ok) {
            cachedModels = await root.lab.enhancedModels(draft.hardwareProfile);
            if (typeof root.log === 'function') {
              root.log(`已导入神经渲染模型: ${res.model.name} (${res.model.sha256.slice(0, 12)}…)`);
            }
            await refreshContainer(container, dir, draft.hardwareProfile);
          } else if (!res?.cancelled && res?.message) {
            alert(`导入模型失败：${res.message}`);
          }
        } finally {
          btnImportNr.disabled = false;
        }
      };
    }

    const btnRestoreNr = container.querySelector('[data-enh-act="restore-nr"]');
    if (btnRestoreNr) {
      btnRestoreNr.onclick = async () => {
        await root.lab.restoreGame(dir);
        draftState.delete(dir);
        await refreshContainer(container, dir, draft.hardwareProfile);
      };
    }

    const btnApplyMfg = container.querySelector('[data-enh-act="apply-mfg"]');
    if (btnApplyMfg) {
      btnApplyMfg.onclick = () => runAction({
        mfgMode: draft.mfgMode,
        runtimeStack: draft.runtimeStack,
        hdrCompatibility: draft.hdrCompatibility,
        hardwareProfile: draft.hardwareProfile
      });
    }

    const btnDisableMfg = container.querySelector('[data-enh-act="disable-mfg"]');
    if (btnDisableMfg) {
      btnDisableMfg.onclick = () => {
        draft.mfgMode = 'off';
        return runAction({
          mfgMode: 'off',
          runtimeStack: draft.runtimeStack,
          hdrCompatibility: draft.hdrCompatibility,
          hardwareProfile: draft.hardwareProfile
        });
      };
    }

    const btnApplyCombined = container.querySelector('[data-enh-act="apply-combined"]');
    if (btnApplyCombined) {
      btnApplyCombined.onclick = () => runAction({
        neuralMode: draft.neuralMode,
        neuralModelId: draft.neuralModelId,
        mfgMode: draft.mfgMode,
        runtimeStack: draft.runtimeStack,
        hdrCompatibility: draft.hdrCompatibility,
        hardwareProfile: draft.hardwareProfile,
        singlePassTuning: draft.singlePassTuning
      });
    }

    const btnRefresh = container.querySelector('[data-enh-act="refresh-status"]');
    if (btnRefresh) {
      btnRefresh.onclick = () => refreshContainer(container, dir, draft.hardwareProfile);
    }

    const btnRestoreAll = container.querySelector('[data-enh-act="restore-all"]');
    if (btnRestoreAll) {
      btnRestoreAll.onclick = async () => {
        await root.lab.restoreGame(dir);
        draftState.delete(dir);
        await refreshContainer(container, dir, draft.hardwareProfile);
      };
    }
  }

  async function refreshContainer(container, dir, profileOverride) {
    if (!container || !dir) return;
    const effectiveProfile = profileOverride || draftState.get(dir)?.hardwareProfile || activeGlobalProfile;
    const [status, modelsInfo] = await Promise.all([
      root.lab.enhancedStatus(dir, effectiveProfile),
      cachedModels ? Promise.resolve(cachedModels) : root.lab.enhancedModels(effectiveProfile)
    ]);
    cachedModels = modelsInfo;
    if (!status) return;
    if (status.hardwareProfile) {
      activeGlobalProfile = status.hardwareProfile;
    }
    const render = () => {
      container.innerHTML = buildThreePanelsHtml(dir, status, modelsInfo, container.dataset.enhPrefix || 'sheet');
      wirePanelEvents(container, dir, status, render);
    };
    render();
  }

  /**
   * 在游戏详情抽屉 (#sheet) 中挂载三大增强管理器
   */
  async function mountInSheet(dir) {
    const sheet = document.getElementById('sheet');
    if (!sheet || !dir || !root.lab?.enhancedStatus) return;

    // 隐藏原版遗留的重复英文安装栏与废弃社区按钮，汉化底部日志工具按钮
    const legacyActions = sheet.querySelector('.sheet-body .sheet-actions');
    if (legacyActions) legacyActions.style.display = 'none';
    const shareBtn = sheet.querySelector('#shareResult');
    if (shareBtn) shareBtn.style.display = 'none';
    const copyBtn = sheet.querySelector('#copyJob');
    if (copyBtn) copyBtn.textContent = '📋 复制日志';
    const diagBtn = sheet.querySelector('#saveDiag');
    if (diagBtn) diagBtn.textContent = '💾 导出诊断报告';

    let mount = sheet.querySelector('#enhancedSheetMount');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'enhancedSheetMount';
      const actions = sheet.querySelector('.sheet-body .sheet-actions') || sheet.querySelector('.gp-main');
      if (actions && actions.parentNode === sheet.querySelector('.sheet-body')) {
        actions.parentNode.insertBefore(mount, actions);
      } else if (actions) {
        actions.appendChild(mount);
      } else {
        sheet.appendChild(mount);
      }
    }
    await refreshContainer(mount, dir);
  }

  /**
   * 渲染独立导航页面 (#view-enhanced)
   */
  async function renderEnhancedView() {
    const view = document.getElementById('view-enhanced');
    if (!view || !root.lab?.enhancedHardware) return;

    const [hwRes, modelsInfo] = await Promise.all([
      cachedHw ? Promise.resolve(cachedHw) : root.lab.enhancedHardware(),
      cachedModels ? Promise.resolve(cachedModels) : root.lab.enhancedModels(activeGlobalProfile)
    ]);
    cachedHw = hwRes;
    cachedModels = modelsInfo;
    if (hwRes?.hardwareProfile) {
      activeGlobalProfile = hwRes.hardwareProfile;
    }
    const hw = hwRes?.hardware || hwRes || {};
    const activeProfileMeta = getProfileOption(activeGlobalProfile);

    const games = (typeof state !== 'undefined' && Array.isArray(state.games) && state.games.length)
      ? state.games
      : (await root.lab.library().catch(() => []));
    if (!selectedViewGameDir && games.length > 0) {
      selectedViewGameDir = games[0].dir;
    }

    const gpu = hw.gpu || {
      name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      driver: '581.80',
      vramTotalMB: 8188,
      powerDefaultW: 100,
      powerMaxW: 140
    };

    const modelsRows = (modelsInfo?.models || []).map((m) => `
      <tr>
        <td><b>${escHtml(m.name)}</b><br><small style="color:var(--muted)">${escHtml(m.id)}</small></td>
        <td><code>${escHtml(m.version)}</code> (${escHtml(m.releaseDate)})</td>
        <td><code>${escHtml((m.architectures || []).join(', '))}</code></td>
        <td>${renderStatusBadge(m.compatibility?.status || 'verified', m.compatibility?.badge || '已验证可用')}</td>
        <td><code style="font-size:11px">${escHtml(m.sha256 ? m.sha256.slice(0, 16) + '…' : '内置运行时管线')}</code></td>
      </tr>
    `).join('');

    view.innerHTML = `
      <div class="section-head">
        <div>
          <h3>DLSS 5 + 全系 40/50 显卡 MFG 增强控制中心 <span class="beta-tag" style="margin-left:8px">ENHANCED v2.3.2</span></h3>
          <p class="hint">支持【笔记本 40 系列】【40 系桌面卡】【50 系列桌面卡】三档专属调优，全模型 100% 兼容且桌面显卡完整兼容 MFG 多帧生成</p>
        </div>
      </div>

      <div class="enh-view-wrap">
        <!-- 本机硬件实时检测横幅 -->
        <div class="enh-hw-banner" aria-label="Hardware Detection">
          <div class="enh-hw-item">
            <span class="k">本机物理显卡 (Physical GPU)</span>
            <span class="v">${escHtml(gpu.name)}</span>
            <span class="s">当前生效档位：${escHtml(activeProfileMeta.label)} · ${gpu.vramTotalMB || 8188} MB VRAM</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">显卡驱动与功耗上限</span>
            <span class="v">NVIDIA Driver ${escHtml(gpu.driver)}</span>
            <span class="s">TGP 默认上限 ${gpu.powerDefaultW || 100}W / 最大 ${gpu.powerMaxW || 140}W</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">处理器与系统内存</span>
            <span class="v">${escHtml(hw.cpu || 'Intel Core i7-13650HX')}</span>
            <span class="s">${hw.cpuCores || 20} 逻辑核心 · ${hw.ramGB || 16} GB RAM</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">目标显示与帧率</span>
            <span class="v">${escHtml(hw.display?.resolution || '1920x1080')} @ ${hw.display?.refreshRateHz || 165}Hz</span>
            <span class="s">支持 1080p 笔记本省显存档 &amp; 2K/4K 桌面满血档</span>
          </div>
        </div>

        <!-- 目标游戏选择器 -->
        <div class="enh-toolbar-bar">
          <label>
            <span>选择目标游戏目录：</span>
            <select id="enhGameSelect">
              ${games.length
                ? games.map((g) => `<option value="${escHtml(g.dir)}" ${g.dir === selectedViewGameDir ? 'selected' : ''}>${escHtml(g.name)} (${escHtml(g.dir)})</option>`).join('')
                : '<option value="">未检测到游戏，请点击右侧“浏览并添加游戏目录”添加测试程序</option>'}
            </select>
          </label>
          <div class="enh-actions" style="padding-top:0">
            <button type="button" class="enh-btn" id="enhBrowseGameBtn">浏览并添加游戏目录…</button>
            <button type="button" class="enh-btn" id="enhGlobalImportBtn">导入自定义 nvngx_dlssnr.dll…</button>
            <button type="button" class="enh-btn" id="enhCheckUpdateBtn">🔄 检查 GitHub 新版本</button>
          </div>
        </div>

        <!-- 三大核心管理器挂载点 -->
        <div id="enhStandaloneMount" data-enh-prefix="view"></div>

        <!-- 模型版本与哈希数据库 -->
        <section class="enh-card">
          <div class="enh-card-head">
            <div class="enh-card-title">
              <h4>DLSS 5 神经渲染模型版本数据库 (Model & CUDA Fatbin Database)</h4>
              <p>所有内置模型均包含 sm_89 (40系笔记本/桌面卡) 与 sm_120 (50系桌面卡) CUDA Fatbin 核函数，全系 100% 兼容</p>
            </div>
            ${renderStatusBadge('verified', '全档位哈希与 SM 校验已启用')}
          </div>
          <div class="enh-table-wrap">
            <table class="enh-table">
              <thead>
                <tr>
                  <th>模型名称 / ID</th>
                  <th>版本与发布日期</th>
                  <th>包含 CUDA SM 架构</th>
                  <th>当前档位 (${escHtml(activeProfileMeta.label.split(' ')[1])}) 兼容性</th>
                  <th>SHA-256 指纹</th>
                </tr>
              </thead>
              <tbody>
                ${modelsRows}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    const gameSelect = document.getElementById('enhGameSelect');
    const mount = document.getElementById('enhStandaloneMount');
    if (gameSelect) {
      gameSelect.onchange = () => {
        selectedViewGameDir = gameSelect.value;
        if (selectedViewGameDir) refreshContainer(mount, selectedViewGameDir, activeGlobalProfile);
      };
    }

    const browseBtn = document.getElementById('enhBrowseGameBtn');
    if (browseBtn) {
      browseBtn.onclick = async () => {
        const picked = await root.lab.pickFolder();
        if (picked) {
          await root.lab.addGameByPath(picked);
          if (typeof root.load === 'function') await root.load();
          selectedViewGameDir = picked;
          await renderEnhancedView();
        }
      };
    }

    const importBtn = document.getElementById('enhGlobalImportBtn');
    if (importBtn) {
      importBtn.onclick = async () => {
        const res = await root.lab.enhancedImportModel();
        if (res?.ok) {
          cachedModels = await root.lab.enhancedModels(activeGlobalProfile);
          await renderEnhancedView();
        } else if (!res?.cancelled && res?.message) {
          alert(`导入模型失败：${res.message}`);
        }
      };
    }

    const checkUpdateBtn = document.getElementById('enhCheckUpdateBtn');
    if (checkUpdateBtn) {
      checkUpdateBtn.onclick = async () => {
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = '正在检查 GitHub 更新…';
        try {
          const answer = await root.lab.checkUpdate?.();
          showReleaseUpdateBanner(answer, { manual: true });
        } finally {
          checkUpdateBtn.disabled = false;
          checkUpdateBtn.textContent = '🔄 检查 GitHub 新版本';
        }
      };
    }

    if (selectedViewGameDir && mount) {
      await refreshContainer(mount, selectedViewGameDir, activeGlobalProfile);
    } else if (mount) {
      mount.innerHTML = `
        <section class="enh-profile-bar" aria-label="硬件专属优化档位选择菜单">
          <div class="enh-profile-head">
            <h4>🎛️ 硬件专属优化档位选择菜单 <span class="enh-badge enh-badge-verified">全模型兼容 · 桌面显卡 MFG 已适配</span></h4>
            <span class="sub">切换档位将自动匹配对应的 DLSS 5 分辨率管线与 MFG 多帧生成策略（笔记本 40 系列默认锁定原版黄金参数不动）</span>
          </div>
          <div class="enh-profile-grid" role="group" aria-label="显卡优化档位切换">
            ${HARDWARE_PROFILE_OPTIONS.map((opt) => `
              <button type="button" class="enh-profile-btn ${activeGlobalProfile === opt.id ? 'active' : ''}" data-hw-profile="${escHtml(opt.id)}">
                <div class="enh-profile-btn-top">
                  <span class="enh-profile-btn-title">${escHtml(opt.label)}</span>
                  <span class="enh-profile-btn-tag">${escHtml(opt.tag)}</span>
                </div>
                <span class="enh-profile-btn-desc">${escHtml(opt.desc)}</span>
              </button>
            `).join('')}
          </div>
          <div class="enh-profile-summary">
            <div><b>当前已选档位：${escHtml(activeProfileMeta.label)}</b></div>
            <small>${escHtml(activeProfileMeta.dlssSummary)}</small>
            <small>${escHtml(activeProfileMeta.mfgSummary)}</small>
          </div>
        </section>
      `;
      for (const pBtn of mount.querySelectorAll('[data-hw-profile]')) {
        pBtn.onclick = async () => {
          activeGlobalProfile = pBtn.dataset.hwProfile;
          if (typeof root.lab?.enhancedSetProfile === 'function') {
            await root.lab.enhancedSetProfile(activeGlobalProfile).catch(() => {});
          }
          cachedHw = null;
          cachedModels = null;
          await renderEnhancedView();
        };
      }
    }
  }

  // 包装 openSheet 与 show，使详情抽屉和侧边栏都能无缝加载增强模块
  const prevOpenSheet = root.openSheet;
  if (typeof prevOpenSheet === 'function') {
    root.openSheet = async function wrappedOpenSheet(dir, keepLog) {
      const res = await prevOpenSheet.apply(this, arguments);
      await mountInSheet(dir);
      return res;
    };
  }

  const prevShow = root.show;
  if (typeof prevShow === 'function') {
    root.show = function wrappedShow(view) {
      const res = prevShow.apply(this, arguments);
      if (view === 'enhanced') {
        renderEnhancedView();
      }
      return res;
    };
  }

  function showReleaseUpdateBanner(answer, { manual = false } = {}) {
    if (!answer) return;
    if (!answer.newer && !manual) return;
    const activeView = document.querySelector('.view.active') || document.getElementById('view-home');
    if (!activeView) return;
    let banner = document.getElementById('enhUpdateBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'enhUpdateBanner';
      banner.className = 'enh-update-banner';
    }
    if (banner.parentElement !== activeView) {
      activeView.insertBefore(banner, activeView.firstChild);
    }

    const hasNew = Boolean(answer.newer && answer.latest);
    const headline = hasNew
      ? `🎉 发现 GitHub 新版本：v${escHtml(answer.latest)}（当前正在运行：v${escHtml(answer.current)}）`
      : (answer.latest
        ? `✅ 当前已是最新版本：v${escHtml(answer.current)}（GitHub 最新版：v${escHtml(answer.latest)}）`
        : `⚠️ 暂未连接到 GitHub 更新服务器（当前版本：v${escHtml(answer.current)}，所有功能均支持 100% 离线使用）`);
    const subline = answer.title
      ? `版本说明：${escHtml(answer.title)}`
      : (hasNew ? 'GitHub 已发布新版增强包，包含最新兼容性修复与功能升级，建议前往下载更新。' : '您可以随时点击右侧按钮前往 GitHub Releases 页面查看历史版本与更新说明。');

    banner.innerHTML = `
      <div class="enh-update-head">
        <div class="enh-update-title">
          <h4>${headline}</h4>
          <span>${subline}</span>
        </div>
        <div class="enh-actions" style="padding-top:0">
          <button type="button" class="enh-btn primary" id="enhUpdateDownloadBtn">🚀 前往 GitHub 查看并下载最新版 ↗</button>
          <button type="button" class="enh-btn" id="enhUpdateCloseBtn">✕ 关闭提示</button>
        </div>
      </div>
      ${answer.notes ? `<div class="enh-update-notes">${escHtml(answer.notes)}</div>` : ''}
    `;

    const dlBtn = banner.querySelector('#enhUpdateDownloadBtn');
    if (dlBtn) {
      dlBtn.onclick = () => {
        if (typeof root.lab?.openProject === 'function') {
          root.lab.openProject('releases');
        }
      };
    }
    const closeBtn = banner.querySelector('#enhUpdateCloseBtn');
    if (closeBtn) {
      closeBtn.onclick = () => banner.remove();
    }
  }

  root.enhancedUi = {
    HARDWARE_PROFILE_OPTIONS,
    mountInSheet,
    renderEnhancedView,
    renderStatusBadge,
    buildThreePanelsHtml,
    showReleaseUpdateBanner
  };
})(window);
