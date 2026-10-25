'use strict';
// Native <input type=range> dragging relies on OS capture, which an offscreen
// Chromium window does not own. Handle pointer drags in the shared DOM instead.
// A custom theme stores one accent colour. The other three shades the panel
// needs are derived from it here, in one place, so the preview in the app and
// the surface drawn inside the game cannot drift apart.
//   bright  accent lifted toward white, for text on dark
//   soft    accent at low alpha, for selected rows
//   back    a dark tint over the panel's own base, for the gradient
window.overlayThemeVars = accent => {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(accent || ''));
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
  const pair = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  const mix = (c, target, amount) => pair(c + (target - c) * amount);
  return {
    '--ol-accent': `#${pair(r)}${pair(g)}${pair(b)}`,
    '--ol-bright': `#${mix(r, 255, .47)}${mix(g, 255, .47)}${mix(b, 255, .47)}`,
    '--ol-soft': `#${pair(r)}${pair(g)}${pair(b)}25`,
    '--ol-back': `#${mix(r, 16, .88)}${mix(g, 21, .88)}${mix(b, 25, .88)}`
  };
};

// Point an element at a theme. Built-in themes are pure CSS; a custom one adds
// the derived variables inline, which override the stylesheet's defaults.
window.applyOverlayTheme = (element, prefs) => {
  if (!element || !prefs) return;
  element.dataset.overlayTheme = prefs.theme;
  for (const name of ['--ol-accent', '--ol-bright', '--ol-soft', '--ol-back']) element.style.removeProperty(name);
  if (prefs.theme !== 'custom') return;
  const vars = window.overlayThemeVars(prefs.custom && prefs.custom.accent);
  if (vars) for (const [name, value] of Object.entries(vars)) element.style.setProperty(name, value);
};

window.bindOverlayRanges = root => {
  let active = null;
  const move = event => {
    if (!active) return;
    const r = active.getBoundingClientRect(), thumb = 7.5;
    const min = Number(active.min), max = Number(active.max), step = Number(active.step) || .01;
    const ratio = Math.max(0, Math.min(1, (event.clientX - r.left - thumb) / Math.max(1, r.width - 2 * thumb)));
    active.value = String(Math.max(min, Math.min(max, min + Math.round(ratio * (max - min) / step) * step)));
    active.dispatchEvent(new Event('input', { bubbles: true }));
  };
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.target.matches('input[type=range]:not(:disabled)')) return;
    active = event.target; event.preventDefault(); active.focus();
    active.dataset.dragging = 'true';
    try { active.setPointerCapture(event.pointerId); } catch {}
    move(event);
  });
  root.addEventListener('pointermove', move);
  const finish = () => { if (active) { delete active.dataset.dragging; active.dispatchEvent(new Event('change', { bubbles: true })); } active = null; };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
  root.addEventListener('lostpointercapture', finish);
};
// One DOM for the preview AND the in-game Chromium surface. No native
// reconstruction of controls: their metrics, fonts and behavior stay identical.
window.mountOverlayPanel = (root, footer = '按 F8 显示/隐藏游戏内控制面板 · 按 Home 键打开完整 ReShade / MFG 多帧生成 / DLSS 5 神经渲染高级中文菜单。') => {
  const slider = (id, label, value) => `<label class="ol-slider" for="${id}"><span>${label}</span><input id="${id}" type="range" min="0" max="1" step="0.01" value="${value}"/><output for="${id}">${value.toFixed(2)}</output></label>`;
  root.innerHTML = `<div class="ol-panel" dir="ltr">
    <header><span class="ol-eyebrow">DLSS 5 神经渲染控制中心</span><span class="ol-prototype">预览</span></header>
    <label class="ol-check ol-master"><input type="checkbox" checked/> 开启 DLSS 5 神经渲染 <small>预览模式</small></label>
    <label class="ol-check ol-badge"><input type="checkbox"/> 屏幕状态角标 <small>在游戏画面左上角显示 DLSS 5 开关状态</small></label>
    <section><h4>全局画质调节</h4>${slider('olStructure', '结构细节强度 (Structure)', .38)}${slider('olTone', '全局色调强度 (Global Tone)', .28)}</section>
    <section class="ol-muted"><label class="ol-check"><input type="checkbox" disabled/> MODEL AUTOMASK <small>需要运行时支持</small></label>${slider('olMaskStructure', '人物/皮肤结构强度 (Skin Structure)', 1)}</section>
    <section><label class="ol-check"><input type="checkbox" checked/> 分组遮罩控制 <small>演示分组</small></label>
      ${[['前景主体', .45, .35], ['植被与材质', 1, 1], ['高光与反射', 1, 1]].map(([label, structure, tone], i) => `<div class="ol-group"><label class="ol-check"><input type="checkbox" checked/> ${label}</label>${slider(`olGroup${i}s`, '结构细节强度', structure)}${slider(`olGroup${i}t`, '色调强度', tone)}</div>`).join('')}
    </section><section><h4>预设风格 <small>预览选择</small></h4><div class="ol-models">${['A', 'B', 'C'].map((m, i) => `<button class="ol-model ${i ? '' : 'selected'}" aria-pressed="${!i}">风格 ${m}</button>`).join('')}</div></section>
    <footer></footer></div>`;
  root.querySelector('footer').textContent = footer;
  root.querySelector('#olMaskStructure').disabled = true;
  for (const input of root.querySelectorAll('input[type="range"]')) input.oninput = () => { input.nextElementSibling.textContent = Number(input.value).toFixed(2); };
  for (const model of root.querySelectorAll('.ol-model')) model.onclick = () => {
    for (const item of root.querySelectorAll('.ol-model')) { item.classList.toggle('selected', item === model); item.setAttribute('aria-pressed', String(item === model)); }
  };
  if (!root.dataset.rangeBinding) { window.bindOverlayRanges(root); root.dataset.rangeBinding = 'true'; }
};
