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

  // 每个游戏目录独立的 UI 选择状态（未点击“应用”前不会虚假声称已生效）
  const draftState = new Map();
  let cachedHw = null;
  let cachedModels = null;
  let selectedViewGameDir = '';

  function getDraft(dir, status) {
    if (!draftState.has(dir)) {
      const currentNrMode = status?.neural?.mode && status.neural.mode !== 'off'
        ? status.neural.mode
        : 'off';
      const currentMfgMode = status?.mfg?.currentConfig?.mode && status.mfg.currentConfig.mode !== 'off'
        ? status.mfg.currentConfig.mode
        : 'off';
      draftState.set(dir, {
        neuralMode: currentNrMode,
        runtimeStack: status?.neural?.runtimeStack || 'baseline-310.9.1',
        mfgMode: currentMfgMode,
        hdrCompatibility: true
      });
    }
    return draftState.get(dir);
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
    if (norm === 'verified') {
      cls = 'enh-badge-verified';
      if (!customLabel) text = '已验证可用';
    } else if (norm === 'experimental') {
      cls = 'enh-badge-experimental';
      if (!customLabel) text = '实验性支持';
    } else if (norm === 'incompatible') {
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
  function buildCoExecCheckItems(coExec) {
    if (!coExec) return [];
    const conflicts = coExec.dllConflicts || [];
    const hasErrConflict = conflicts.some((c) => c.severity === 'error');
    const vram = coExec.vramBudget || {};
    return [
      {
        title: '1. 模块 DLL 冲突检查',
        status: hasErrConflict ? 'incompatible' : 'untested',
        badge: hasErrConflict ? '不兼容' : '静态文件冲突检查',
        detail: conflicts.length ? conflicts.map((c) => c.message).join(' ') : '无 DLL 命名或 Hook 冲突'
      },
      {
        title: '2. Streamline / NGX 注入链协同',
        status: 'untested',
        badge: '仅静态配置检查',
        detail: coExec.slChainCheck?.message || '注入链尚未检测'
      },
      {
        title: '3. 运动矢量与补帧质量保护',
        status: 'untested',
        badge: '画质尚未实测',
        detail: coExec.motionVectorCheck?.message || 'Boundary Artifact Mitigation 保护边缘光流'
      },
      {
        title: '4. HUD / HDR 闪烁与拖影抑制',
        status: 'untested',
        badge: 'HUD/HDR 尚未实测',
        detail: coExec.hudFlickerCheck?.message || 'Native HUD/UI 标记直通正常'
      },
      {
        title: '5. RTX 4070 Laptop 8GB 显存预算',
        status: 'untested',
        badge: '估算，非安全验证',
        detail: vram.summary || '没有当前游戏显存测量'
      },
      {
        title: '6. Reflex 帧同步与延迟控制',
        status: 'untested',
        badge: '延迟尚未实测',
        detail: coExec.reflexCheck?.message || 'Reflex 尚未检测'
      },
      {
        title: '7. 游戏退出后完整恢复原状能力',
        status: coExec.backupCheck?.ok ? 'verified' : 'incompatible',
        badge: coExec.backupCheck?.badge || '尚未检查',
        detail: coExec.backupCheck?.message || '事务级备份完整'
      }
    ];
  }

  /**
   * 构建三大功能区域 HTML（可同时嵌入游戏详情抽屉 #sheet 与独立增强视图 #view-enhanced）
   */
  function buildThreePanelsHtml(dir, status, modelsInfo, prefix = 'sheet') {
    const draft = getDraft(dir, status);
    const nr = status.neural || {};
    const mfg = status.mfg || {};
    const diag = status.diagnostics || {};
    const coExec = diag.coExecution || {};
    const vram = coExec.vramBudget || {};
    const checks = buildCoExecCheckItems(coExec);

    // 1. Neural Rendering Manager 状态判定
    const nrBadge = renderStatusBadge(nr.overallStatus, nr.overallBadge);

    const currentModelText = nr.currentModel
      ? `${nr.currentModel.name} (${nr.currentModel.version || '310.8.0.0'})`
      : '未安装 (Off)';

    const latestModelText = nr.latestCompatibleModel
      ? `${nr.latestModel.name} · v${nr.latestModel.version}`
      : '310.8.SF-v2 (Oct 2026)';

    const runtimeVerText = nr.runtimeVersion
      ? `DLSS ${nr.dlssVersion} / SL ${nr.streamlineVersion || '未知'} / Feeder 1.19.0`
      : '待用户导入运行时';

    const gpuCompatText = `${status.hardware?.gpu?.name || '未知 GPU'} — ${nr.gpuCompatibility?.reason || '架构未确认，游戏内尚未验证'}`;

    // 2. Multi Frame Generation Manager 状态判定
    // 严格遵守要求：x3/x4 只有经测试确实生效时才能标记为“已验证可用”
    const mfgBadgeHtml = renderStatusBadge(mfg.status, mfg.statusBadge);

    const effectiveMultiplierText = mfg.runtimeVerification?.verifiedActive
      ? `${mfg.runtimeVerification.effectiveMultiplier}x (运行时日志已确认生效)`
      : mfg.currentConfig?.installed
        ? `已配置 ${mfg.currentConfig.mode} (${mfg.currentConfig.multiplier}x) · 实际生效倍率：尚未测试 (需运行游戏产生日志后验证)`
        : '未激活 (1x 原始帧输出)';

    const dlssgVerText = mfg.dlssg?.exists
      ? `${mfg.dlssg.version} (${mfg.dlssg.valid ? '原生 NVIDIA NGX DLSS-G' : '非原生 DLL'})`
      : '未检测到，需用户提供获准使用的组件';

    // 3. Compatibility & Diagnostics 状态判定
    const diagBadgeHtml = renderStatusBadge(diag.combinedStatus, diag.combinedBadge);

    return `
      <div class="enh-sheet-section" data-enh-dir="${escHtml(dir)}" data-enh-prefix="${escHtml(prefix)}">
        <div class="enh-grid">
          <!-- ==================== 模块 A: Neural Rendering Manager ==================== -->
          <section class="enh-card" aria-label="Neural Rendering Manager">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Neural Rendering Manager <small style="font-weight:500;color:var(--muted)">模块 A · DLSS 5 神经渲染</small></h4>
                <p>管理 DLSS 5 神经渲染模型 (nvngx_dlssnr.dll)、CUDA SM 架构校验与 2026-10 运行时栈</p>
              </div>
              ${nrBadge}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">当前模型 (Current Model)</span><span class="v">${escHtml(currentModelText)}</span></div>
              <div class="enh-kv-row"><span class="k">最新模型 (Latest Model)</span><span class="v">${escHtml(latestModelText)}</span></div>
              <div class="enh-kv-row"><span class="k">2026-10 官方模型追踪</span><span class="v">v310.9.16 (118M Faster AI Model · 2026-10-16)</span></div>
              <div class="enh-kv-row"><span class="k">运行时版本 (Runtime Version)</span><span class="v mono">${escHtml(runtimeVerText)}</span></div>
              <div class="enh-kv-row"><span class="k">GPU 兼容性 (GPU Compatibility)</span><span class="v">${escHtml(gpuCompatText)}</span></div>
              <div class="enh-kv-row"><span class="k">安装状态 (Install Status)</span><span class="v">${nr.installed ? `已安装 (${escHtml(nr.mode)})` : '未安装'}</span></div>
            </div>

            <div class="enh-control-group">
              <div class="enh-control-label">
                <span>Neural Rendering 模式选择</span>
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
                  <span>Latest Compatible</span><small>310.8.SF-v2 柔光抗闪烁</small>
                </button>
              </div>
            </div>

            <div class="enh-select-row">
              <label>
                <span>运行时栈版本 (Streamline / DLSS / Feeder)</span>
                <select data-enh-field="runtimeStack">
                  <option value="oct2026-310.9.16" ${draft.runtimeStack === 'oct2026-310.9.16' ? 'selected' : ''}>用户提供的可选运行时 (DLSS 310.9.16 + SL 2.14.16 + Feeder 1.19.0)</option>
                  <option value="baseline-310.9.1" ${draft.runtimeStack === 'baseline-310.9.1' ? 'selected' : ''}>v2.2.9 基线运行时 (DLSS 310.9.1 + SL 2.13.0 + Feeder 1.17.0)</option>
                </select>
              </label>
            </div>

            <div class="enh-note">
              <b>说明</b>：社区实验配置不代表 NVIDIA 官方支持。新发行包不附带模型或运行时；请导入获准使用的文件。结构、哈希及架构检查不能证明许可、真实性或游戏内已生效。
            </div>

            <div class="enh-actions">
              <button type="button" class="enh-btn primary" data-enh-act="apply-nr">更新 / 应用神经渲染</button>
              <button type="button" class="enh-btn" data-enh-act="import-nr">手动导入模型 (.dll)</button>
              <button type="button" class="enh-btn" data-enh-act="restore-nr" ${coExec.backupCheck?.hasManifest ? '' : 'disabled'}>一键恢复原状</button>
            </div>
          </section>

          <!-- ==================== 模块 B: Multi Frame Generation Manager ==================== -->
          <section class="enh-card" aria-label="Multi Frame Generation Manager">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Multi Frame Generation Manager <small style="font-weight:500;color:var(--muted)">模块 B · RTX 40 x3/x4 多帧生成</small></h4>
                <p>基于原生 NVIDIA DLSS-G (nvngx_dlssg.dll) 与 sl.dlss_g 常量劫持的 Ada 多帧生成管理器</p>
              </div>
              ${mfgBadgeHtml}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">当前显卡 (Current GPU)</span><span class="v">${escHtml(mfg.gpuSupport?.gpuName || '未知 GPU')}</span></div>
              <div class="enh-kv-row"><span class="k">DLSS-G 版本 (DLSS-G Version)</span><span class="v mono">${escHtml(dlssgVerText)}</span></div>
              <div class="enh-kv-row"><span class="k">支持模式 (Supported Modes)</span><span class="v">${mfg.gpuSupport?.nativeX2 ? 'Off / x2 (硬件支持，待游戏验证) / x3、x4 (社区实验)' : 'GPU 未确认或不支持；请刷新检测'}</span></div>
              <div class="enh-kv-row"><span class="k">实际生效倍率 (Effective Multiplier)</span><span class="v">${escHtml(effectiveMultiplierText)}</span></div>
              <div class="enh-kv-row"><span class="k">当前游戏兼容性 (Game Compatibility)</span><span class="v">${escHtml(mfg.knownGame ? `${mfg.knownGame.title} (${mfg.knownGame.notes})` : '此游戏兼容性尚未验证')}</span></div>
            </div>

            <div class="enh-control-group">
              <div class="enh-control-label">
                <span>Multi Frame Generation 倍率选择</span>
                <span>仅运行时日志验证后标为“已验证可用”</span>
              </div>
              <div class="enh-seg" role="group" aria-label="Multi Frame Generation Mode">
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'off' ? 'active' : ''}" data-mfg-mode="off">
                  <span>Off</span><small>关闭补帧</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x2' ? 'active' : ''}" data-mfg-mode="x2">
                  <span>x2</span><small>标准 FG (待验证)</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x3' ? 'active' : ''}" data-mfg-mode="x3">
                  <span>x3</span><small>3帧输出 (实验性)</small>
                </button>
                <button type="button" class="enh-seg-btn ${draft.mfgMode === 'x4' ? 'active' : ''}" data-mfg-mode="x4">
                  <span>x4</span><small>4帧输出 (实验性)</small>
                </button>
              </div>
            </div>

            <div class="enh-select-row">
              <label>
                <span>HDR / UI 防闪烁保护 (QualityGuardMode)</span>
                <select data-enh-field="hdrCompatibility">
                  <option value="true" ${draft.hdrCompatibility !== false ? 'selected' : ''}>启用 (推荐：自动同步 HDR UI Composition 与 TemporalFix)</option>
                  <option value="false" ${draft.hdrCompatibility === false ? 'selected' : ''}>关闭 (仅 Native HUD 标记直通)</option>
                </select>
              </label>
            </div>

            <div class="enh-actions">
              <button type="button" class="enh-btn primary" data-enh-act="apply-mfg">安装 / 应用 MFG 配置</button>
              <button type="button" class="enh-btn" data-enh-act="disable-mfg" ${mfg.currentConfig?.installed ? '' : 'disabled'}>回滚 / 移除 MFG</button>
            </div>
          </section>

          <!-- ==================== 模块 C: Compatibility & Diagnostics ==================== -->
          <section class="enh-card enh-card-full" aria-label="Compatibility & Diagnostics">
            <div class="enh-card-head">
              <div class="enh-card-title">
                <h4>Compatibility & Diagnostics <small style="font-weight:500;color:var(--muted)">模块 C · DLSS 5 + MFG 协同运行与诊断</small></h4>
                <p>独立控制 Neural Rendering 与 Multi Frame Generation 同时运行，实时检查 7 项底层兼容性指标与 8GB 显存预算</p>
              </div>
              ${diagBadgeHtml}
            </div>

            <div class="enh-kv-list">
              <div class="enh-kv-row"><span class="k">游戏名称 (Game Name)</span><span class="v">${escHtml(diag.gameName || '未选择游戏')}</span></div>
              <div class="enh-kv-row"><span class="k">图形 API (Graphics API)</span><span class="v">${escHtml(diag.graphicsApi || 'DirectX 12')} (${status.bitness || 64}-bit)</span></div>
              <div class="enh-kv-row"><span class="k">神经渲染状态 (Neural Rendering Status)</span><span class="v">${escHtml(diag.neuralStatus || '尚未测试')}</span></div>
              <div class="enh-kv-row"><span class="k">MFG 状态 (MFG Status)</span><span class="v">${escHtml(diag.mfgStatus || '尚未测试')}</span></div>
              <div class="enh-kv-row"><span class="k">DLL 冲突 (DLL Conflicts)</span><span class="v">${diag.dllConflicts?.length ? escHtml(diag.dllConflicts.map((c) => c.message).join('；')) : '无冲突 (0 项冲突)'}</span></div>
              <div class="enh-kv-row"><span class="k">错误日志 (Error Logs)</span><span class="v">${diag.errorLogs?.length ? escHtml(diag.errorLogs.join(' | ')) : '无错误记录 (0 项异常)'}</span></div>
              <div class="enh-kv-row"><span class="k">备份状态 (Backup Status)</span><span class="v">${escHtml(diag.backupStatus || '原版纯净状态')}</span></div>
            </div>

            <!-- RTX 4070 Laptop 8GB VRAM 预算进度条 -->
            <div class="enh-vram-box">
              <div class="enh-vram-head">
                <span>显存预算估算，非实测 (1920×1080 · 附加开销 +${vram.totalAddedOverheadMB || 0} MB)</span>
                <span>预计占用 ${vram.estimatedTotalMB ?? '未知'} MiB / ${vram.vramTotalMB ?? '未知'} MiB (${vram.usagePercent ?? '未知'}% · 余量 ${vram.headroomMB ?? '未知'} MiB)</span>
              </div>
              <div class="enh-vram-bar">
                <div class="enh-vram-fill ${vram.usagePercent > 88 ? 'warn' : ''}" style="width:${Math.max(0, Math.min(100, vram.usagePercent || 0))}%"></div>
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

            <div class="enh-actions">
              <button type="button" class="enh-btn primary" data-enh-act="apply-combined">一键协同应用 (Neural: ${escHtml(draft.neuralMode.toUpperCase())} + MFG: ${escHtml(draft.mfgMode.toUpperCase())})</button>
              <button type="button" class="enh-btn" data-enh-act="refresh-status">重新扫描运行时日志与生效状态</button>
              <button type="button" class="enh-btn" data-enh-act="restore-all" ${coExec.backupCheck?.hasManifest ? '' : 'disabled'}>完整卸载并恢复游戏原始状态</button>
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

    for (const btn of container.querySelectorAll('[data-nr-mode]')) {
      btn.onclick = () => {
        draft.neuralMode = btn.dataset.nrMode;
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
        if (field === 'hdrCompatibility') draft.hdrCompatibility = sel.value === 'true';
        else draft[field] = sel.value;
        onUpdated();
      };
    }

    const runAction = async (payload) => {
      const buttons = container.querySelectorAll('button, select');
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const msg = `Enhanced: 应用配置 (Neural=${payload.neuralMode ?? '保持'}, MFG=${payload.mfgMode ?? '保持'})`;
        if (typeof root.jobLog === 'function') root.jobLog(`--- ${msg} ---`);
        if (typeof root.log === 'function') root.log(`${msg} -> ${dir}`);
        const res = await root.lab.enhancedApply(dir, payload);
        if (!res?.ok && res?.message) {
          if (typeof root.jobLog === 'function') root.jobLog(`错误: ${res.message}`);
          if (typeof root.log === 'function') root.log(`错误: ${res.message}`);
        } else {
          if (typeof root.jobLog === 'function') root.jobLog('Enhanced: 配置已成功写入并建立事务备份。');
        }
      } catch (err) {
        if (typeof root.log === 'function') root.log(`Enhanced 操作异常: ${err.message}`);
      } finally {
        await refreshContainer(container, dir);
      }
    };

    const btnApplyNr = container.querySelector('[data-enh-act="apply-nr"]');
    if (btnApplyNr) {
      btnApplyNr.onclick = () => runAction({
        neuralMode: draft.neuralMode,
        runtimeStack: draft.runtimeStack
      });
    }

    const btnImportNr = container.querySelector('[data-enh-act="import-nr"]');
    if (btnImportNr) {
      btnImportNr.onclick = async () => {
        btnImportNr.disabled = true;
        try {
          const res = await root.lab.enhancedImportModel();
          if (res?.ok) {
            cachedModels = await root.lab.enhancedModels();
            if (typeof root.log === 'function') {
              root.log(`已导入神经渲染模型: ${res.model.name} (${res.model.sha256.slice(0, 12)}…)`);
            }
            await refreshContainer(container, dir);
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
        await refreshContainer(container, dir);
      };
    }

    const btnApplyMfg = container.querySelector('[data-enh-act="apply-mfg"]');
    if (btnApplyMfg) {
      btnApplyMfg.onclick = () => runAction({
        mfgMode: draft.mfgMode,
        runtimeStack: draft.runtimeStack,
        hdrCompatibility: draft.hdrCompatibility
      });
    }

    const btnDisableMfg = container.querySelector('[data-enh-act="disable-mfg"]');
    if (btnDisableMfg) {
      btnDisableMfg.onclick = () => {
        draft.mfgMode = 'off';
        return runAction({
          mfgMode: 'off',
          runtimeStack: draft.runtimeStack,
          hdrCompatibility: draft.hdrCompatibility
        });
      };
    }

    const btnApplyCombined = container.querySelector('[data-enh-act="apply-combined"]');
    if (btnApplyCombined) {
      btnApplyCombined.onclick = () => runAction({
        neuralMode: draft.neuralMode,
        mfgMode: draft.mfgMode,
        runtimeStack: draft.runtimeStack,
        hdrCompatibility: draft.hdrCompatibility
      });
    }

    const btnRefresh = container.querySelector('[data-enh-act="refresh-status"]');
    if (btnRefresh) {
      btnRefresh.onclick = () => refreshContainer(container, dir);
    }

    const btnRestoreAll = container.querySelector('[data-enh-act="restore-all"]');
    if (btnRestoreAll) {
      btnRestoreAll.onclick = async () => {
        await root.lab.restoreGame(dir);
        draftState.delete(dir);
        await refreshContainer(container, dir);
      };
    }
  }

  async function refreshContainer(container, dir) {
    if (!container || !dir) return;
    const [status, modelsInfo] = await Promise.all([
      root.lab.enhancedStatus(dir),
      cachedModels ? Promise.resolve(cachedModels) : root.lab.enhancedModels()
    ]);
    cachedModels = modelsInfo;
    if (!status) return;
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
      root.lab.enhancedHardware(),
      cachedModels ? Promise.resolve(cachedModels) : root.lab.enhancedModels()
    ]);
    cachedHw = hwRes;
    cachedModels = modelsInfo;
    const hw = hwRes?.hardware || hwRes || {};

    const games = (typeof state !== 'undefined' && Array.isArray(state.games) && state.games.length)
      ? state.games
      : (await root.lab.library().catch(() => []));
    if (!selectedViewGameDir && games.length > 0) {
      selectedViewGameDir = games[0].dir;
    }

    const gpu = hw.gpu || {};

    const modelsRows = (modelsInfo?.models || []).map((m) => `
      <tr>
        <td><b>${escHtml(m.name)}</b><br><small style="color:var(--muted)">${escHtml(m.id)}</small></td>
        <td><code>${escHtml(m.version)}</code> (${escHtml(m.releaseDate)})</td>
        <td><code>${escHtml((m.architectures || []).join(', '))}</code></td>
        <td>${renderStatusBadge(m.compatStatus || 'untested', m.compatBadge || '尚未测试')}</td>
        <td><code style="font-size:11px">${escHtml(m.sha256 ? m.sha256.slice(0, 16) + '…' : '待导入验证')}</code></td>
      </tr>
    `).join('');

    view.innerHTML = `
      <div class="section-head">
        <div>
          <h3>DLSS 5 + RTX 40 MFG 增强控制中心 <span class="beta-tag" style="margin-left:8px">ENHANCED v2.3.0</span></h3>
          <p class="hint">独立管理 DLSS 5 神经渲染模型 (Module A)、RTX 40 x3/x4 多帧生成 (Module B) 与双模块协同诊断 (Module C)</p>
        </div>
      </div>

      <div class="enh-view-wrap">
        <!-- 本机硬件实时检测横幅 -->
        <div class="enh-hw-banner" aria-label="Hardware Detection">
          <div class="enh-hw-item">
            <span class="k">显卡与架构 (GPU)</span>
            <span class="v">${escHtml(gpu.name || '未知 GPU')}</span>
            <span class="s">${escHtml(gpu.architecture?.family || '未知架构')} · ${gpu.vramTotalMB ?? '未知'} MiB VRAM（首个 NVIDIA 适配器，游戏所用 GPU 未确认）</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">显卡驱动与功耗上限</span>
            <span class="v">NVIDIA Driver ${escHtml(gpu.driver || '未知')}</span>
            <span class="s">TGP 默认上限 ${gpu.powerDefaultW ?? '未知'}W / 最大 ${gpu.powerMaxW ?? '未知'}W</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">处理器与系统内存</span>
            <span class="v">${escHtml(hw.cpu || '未知 CPU')}</span>
            <span class="s">${hw.cpuCores ?? '未知'} 逻辑核心 · ${hw.ramGB ?? '未知'} GB RAM</span>
          </div>
          <div class="enh-hw-item">
            <span class="k">目标显示与帧率</span>
            <span class="v">建议目标：1920×1080 @ 165Hz（非检测结果）</span>
            <span class="s">建议从 NR Off / 原生 FG x2 开始；NR 单通道逐项测试。VRR 已开启时可考虑 162 FPS 上限；实际 FPS 未验证。</span>
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
          </div>
        </div>

        <!-- 三大核心管理器挂载点 -->
        <div id="enhStandaloneMount" data-enh-prefix="view"></div>

        <!-- 模型版本与哈希数据库 -->
        <section class="enh-card">
          <div class="enh-card-head">
            <div class="enh-card-title">
              <h4>DLSS 5 神经渲染模型版本数据库 (Model & CUDA Fatbin Database)</h4>
              <p>所有模型均通过 PE 签名、SHA-256 哈希与 CUDA Fatbin (0xBA55ED50) SM 架构指令集校验，拒绝伪造或改名 DLL</p>
            </div>
            ${renderStatusBadge('verified', '哈希与 SM 校验已启用')}
          </div>
          <div class="enh-table-wrap">
            <table class="enh-table">
              <thead>
                <tr>
                  <th>模型名称 / ID</th>
                  <th>版本与发布日期</th>
                  <th>包含 CUDA SM 架构</th>
                  <th>RTX 4070 Laptop 兼容性</th>
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
        if (selectedViewGameDir) refreshContainer(mount, selectedViewGameDir);
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
          cachedModels = await root.lab.enhancedModels();
          await renderEnhancedView();
        } else if (!res?.cancelled && res?.message) {
          alert(`导入模型失败：${res.message}`);
        }
      };
    }

    if (selectedViewGameDir && mount) {
      await refreshContainer(mount, selectedViewGameDir);
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

  root.enhancedUi = {
    mountInSheet,
    renderEnhancedView,
    renderStatusBadge,
    buildThreePanelsHtml
  };
})(window);
