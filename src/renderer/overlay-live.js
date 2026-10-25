'use strict';
// The same connected-panel renderer powers the isolated preview. Sample
// edits stay in this closure and never call IPC or alter a game's settings.
window.mountOverlayLive = (root, { designOnly = false } = {}) => {
  root._overlayDispose?.();
  const lifetime = new AbortController();
  const runtime = designOnly ? null : window.overlayRuntime;
  const sample = { epoch:1, nrAvailable:true, nrEnabled:true, effects:true, tools:[], nrTools:[
    ['Structure Intensity',0,1,0,2], ['Global Tone Intensity',0,1,0,2],
    ['Enable DLSS Neural Rendering',1,1,0,1], ['Automatic / Character Mask',1,1,0,1],
    ['Character/Skin Structure',0,1,-1,2], ['Overall Intensity',0,1,0,2],
    ['Local Tone Intensity',0,1,0,2], ['Diffuse White (nits)',0,203,80,500],
    ['Motion Scale X Multiplier',0,1,-2,2], ['Motion Scale Y Multiplier',0,1,-2,2],
    ['NR UI Correction',1,1,0,1], ['Enable Upscaling (WIP)',1,0,0,1],
    ['NR Preset',4,0,0,3,['Default','Preset #1','Preset #2','Preset #3']],
    ['NR Style',4,0,0,2,['Default','Natural','Cinematic']],
    ['Depth Convention',4,0,0,2,['Use game NGX flag','Force normal depth','Force inverted depth']]
  ].map(([name,kind,value,min,max,options],i)=>({id:101+i,name,kind,value,min,max,options,step:kind===0?.01:1,available:true,effect:'RenoDX 6.5.3'})) };
  let status = sample, epoch = 0, preview = true, connectedOnce = false, autoEpoch = 0;
  const ZH_TOOL_NAMES = {
    'Structure Intensity': '结构细节强度 (Structure)',
    'Global Tone Intensity': '全局色调强度 (Global Tone)',
    'Enable DLSS Neural Rendering': '开启 DLSS 5 神经渲染',
    'Automatic / Character Mask': '角色与皮肤自动遮罩',
    'Character/Skin Structure': '角色/皮肤结构强度',
    'Overall Intensity': '神经渲染总强度 (Overall Intensity)',
    'Local Tone Intensity': '局部对比度与色调 (Local Tone)',
    'Diffuse White (nits)': '漫反射参考白点 (尼特)',
    'Motion Scale X Multiplier': '运动矢量 X 轴缩放',
    'Motion Scale Y Multiplier': '运动矢量 Y 轴缩放',
    'NR UI Correction': 'HUD / UI 界面保护校正',
    'Enable Upscaling (WIP)': '启用超分辅助管线',
    'NR Preset': '神经渲染预设 (NR Preset)',
    'NR Style': '神经渲染风格 (NR Style)',
    'Depth Convention': '深度缓冲方向约定',
    'ReShade shader effects': '启用 ReShade 着色器效果',
    'On-screen status card': '屏幕左上角状态角标'
  };
  const zhName = (n) => ZH_TOOL_NAMES[n] || n;
  // Only reasons worth reading. While the bridge works the badge in the
  // header already says CONNECTED, so the line below it stays out of sight.
  const nrNote = () => !status ? '等待连接游戏进程…'
    : status.nrAvailable ? '' : status.nrReason || '暂未连接到 RenoDX DLSS 5 神经渲染运行时。';
  const observer = new ResizeObserver(() => runtime?.resize(Math.ceil(root.getBoundingClientRect().height)));
  observer.observe(root);
  root._overlayDispose = () => { lifetime.abort(); observer.disconnect(); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const send = (id, kind, value) => {
    if (status === sample) { const t=[...sample.nrTools,...(sample.feedTools||[])].find(t=>t.id===id);if(t&&value>=t.min&&value<=t.max){t.value=value;update();}return; }
    if (status) runtime?.setControl({ epoch: status.epoch, id, kind, value });
  };
  const closeChoices = except => root.querySelectorAll('.ol-dropdown').forEach(d => { if(d!==except) {d.querySelector('.ol-dropdown-menu').hidden=true;d.querySelector('.ol-dropdown-trigger').setAttribute('aria-expanded','false');} });
  document.addEventListener('pointerdown',e=>closeChoices(e.target.closest('.ol-dropdown')), {signal:lifetime.signal});
  root.addEventListener('scroll',e=>{if(!e.target.classList?.contains('ol-dropdown-menu'))closeChoices();},{capture:true,signal:lifetime.signal});
  function choice(t) {
    const box=el('div','ol-dropdown'), trigger=el('button','ol-dropdown-trigger'), menu=el('div','ol-dropdown-menu');
    trigger.type='button';trigger.dataset.liveId=t.id;trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-label',t.name);
    menu.hidden=true;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',t.name);
    box.append(trigger,menu);
    const close=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');};
    trigger.updateChoice = tool => {
      const options=tool.options||t.options||[];
      trigger.textContent=options[tool.value-t.min]||'Unavailable';
      if(JSON.stringify(options)!==menu.dataset.options) {
        menu.dataset.options=JSON.stringify(options);menu.replaceChildren(...options.map((text,i)=>{
          const option=el('button','ol-dropdown-option',text);option.type='button';option.dataset.value=i+t.min;option.setAttribute('role','option');
          option.onclick=()=>{send(t.id,t.kind,i+t.min);close();trigger.focus({preventScroll:true});};return option;
        }));
      }
      for(const o of menu.children)o.setAttribute('aria-selected',String(Number(o.dataset.value)===tool.value));
      if(trigger.disabled)close();
    };
    const open=()=>{
      if(trigger.disabled)return;closeChoices(box);menu.hidden=false;trigger.setAttribute('aria-expanded','true');
      const r=trigger.getBoundingClientRect(), height=Math.min(200,menu.scrollHeight), below=innerHeight-r.bottom-8;
      menu.style.width=`${r.width}px`;menu.style.left=`${r.left}px`;
      const upward=below<height&&r.top>below;
      menu.style.maxHeight=`${Math.max(40,Math.min(200,upward?r.top-8:below))}px`;
      menu.style.top=`${upward?Math.max(8,r.top-Math.min(height,r.top-8)):r.bottom+4}px`;
      (menu.querySelector('[aria-selected=true]')||menu.firstElementChild)?.focus({preventScroll:true});
    };
    trigger.onclick=()=>menu.hidden?open():close();
    trigger.onkeydown=e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open();}};
    box.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();trigger.focus();}
      if(e.key==='Tab')close();
      if(!menu.hidden&&menu.contains(e.target)&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
        e.preventDefault();const options=[...menu.children],index=options.indexOf(document.activeElement);
        options[e.key==='Home'?0:e.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,index+(e.key==='ArrowDown'?1:-1)))].focus({preventScroll:true});
      }
    });
    return box;
  }
  function editable(range) {
    const value = el('input', 'ol-number'); value.type = 'number'; value.dataset.liveId = range.dataset.liveId;
    value.setAttribute('aria-label', `${range.closest('label').querySelector('span').textContent} value`);
    range.nextElementSibling.replaceWith(value);
    range.addEventListener('input', () => { value.value = range.value; });
    const commit = () => {
      const t = status?.feedTools?.find(t => t.id === Number(value.dataset.liveId)) || status?.nrTools?.find(t => t.id === Number(value.dataset.liveId)) || status?.tools?.find(t => t.id === Number(value.dataset.liveId));
      if (t?.available && value.value !== '' && value.validity.valid) send(t.id, t.kind, Number(value.value));
      else if (t) value.value = t.value;
    };
    value.addEventListener('change', commit);
    value.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); value.blur(); } });
  }
  function addTool(target, t) {
    // Feeder's signed tri-state values use the same compact dropdown widget.
    const feedChoices={306:['自动 (Auto)','强制 SDR','强制 HDR'],307:['自动 (Auto)','正向深度 (Normal)','反向深度 (Inverted)'],308:['双线性 (Bilinear)','FSR 1','DLSS SR (实验性)'],309:['自动 (Auto)','关闭 (Off)','开启 (On)']};
    if(feedChoices[t.id])t={...t,options:feedChoices[t.id],name:{306:'HDR 色彩契约',307:'深度方向约定',308:'工作分辨率上采样',309:'HDR10 桥接'}[t.id]};
    const displayName = zhName(t.name);
    const isChoice=t.kind===4||!!t.options;
    const row = el(isChoice?'div':'label', isChoice?'ol-choice':t.kind===0?'ol-slider':'ol-check ol-live-toggle');
    row.title = `${t.effect || 'ReShade'} / ${displayName}`;
    if(isChoice){row.append(el('span','',displayName),choice(t));target.append(row);return;}
    const input = el('input', ''); input.dataset.liveId = t.id;
    if (t.kind === 0) {
      input.type = 'range'; input.min = t.min; input.max = t.max; input.step = t.step;
      row.append(el('span', '', displayName), input, el('output', '', ''));
      editable(input);
    } else { input.type = 'checkbox'; row.append(input, el('span', '', displayName)); }
    input.addEventListener('input', () => send(t.id, t.kind, [0, 4].includes(t.kind) ? Number(input.value) : Number(input.checked)));
    target.append(row);
  }
  function bindNr(panel) {
    for (const control of panel.querySelectorAll('input, button')) control.disabled = true;
    panel.querySelector('.ol-master small').textContent = status===sample?'仅预览':status?.nrAvailable ? 'RenoDX 实时生效中' : '等待 RenoDX 响应';
    const badgeNote = panel.querySelector('.ol-badge small');
    if (badgeNote) badgeNote.textContent = status===sample ? '仅预览' : '在游戏画面上显示 DLSS 5 开关状态';
    panel.querySelector('.ol-prototype').textContent = status===sample?'预览模式':status?.nrAvailable ? '已连接游戏' : '未连接';
    const mapping = [[panel.querySelector('#olStructure'), 101], [panel.querySelector('#olTone'), 102],
      [panel.querySelector('.ol-master input'), 103], [panel.querySelector('.ol-badge input'), 50],
      [panel.querySelector('.ol-muted input[type=checkbox]'), 104],
      [panel.querySelector('#olMaskStructure'), 105]];
    for (const [input, id] of mapping) {
      input.dataset.liveId = id;
      input.addEventListener('input', () => send(id, input.type === 'range' ? 0 : 1, input.type === 'range' ? Number(input.value) : Number(input.checked)));
      if (input.type === 'range') editable(input);
    }
    panel.querySelector('.ol-muted .ol-check small').textContent = 'RenoDX 角色/皮肤保护遮罩';
    const maskLabel = panel.querySelector('.ol-muted .ol-check');
    for (const node of maskLabel.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent.includes('MODEL AUTOMASK')) node.textContent = ' 角色自动遮罩 (CHARACTER MASK) ';
    panel.querySelector('.ol-muted').classList.toggle('ol-muted', !status?.nrAvailable);
    panel.querySelector('#olMaskStructure').previousElementSibling.textContent = '角色/皮肤结构强度';
    const extra = panel.querySelector('.ol-group').parentElement;
    extra.replaceChildren(el('h4', '', '更多 DLSS 5 神经渲染高级控制'));
    const tools = el('div', 'ol-additional'); extra.append(tools);
    for (const t of status?.nrTools || []) if (![101, 102, 103, 103, 104, 105, 114].includes(t.id)) addTool(tools, t);
    if (!status?.nrTools) tools.append(el('p', 'ol-live-note', '重启游戏或按 Home 键打开完整中文高级菜单。'));
    const models = panel.querySelector('.ol-models');
    models.parentElement.querySelector('h4').textContent = '神经渲染画质风格 (NR STYLE)';
    for (const [i, model] of [...models.children].entries()) {
      model.textContent = `模式 ${['A', 'B', 'C'][i]} · ${['默认 (Default)', '自然 (Natural)', '电影感 (Cinematic)'][i]}`;
      model.dataset.styleValue = i;
      model.onclick = () => send(114, 4, i);
      model.classList.remove('selected'); model.setAttribute('aria-pressed', 'false');
    }
    // The style buttons stay above the scrollable advanced controls.
    extra.before(models.parentElement);
    if(status?.feedPresent){
      const section=el('section','ol-feed-section');section.append(el('h4','','FEEDER 深度与运动矢量馈送控制'));
      const feed=el('div','ol-additional');for(const t of status.feedTools||[])addTool(feed,t);
      section.append(feed,el('p','ol-live-note ol-feed-status',status.feedReason));
      extra.after(section);
      // Keep the compact panel bounded: choose a backend section instead of
      // stacking two tall scroll areas. NR remains accessible above.
      const toggle=el('button','ol-model','显示 RenoDX 高级参数');extra.before(toggle);extra.hidden=true;
      toggle.onclick=()=>{extra.hidden=!extra.hidden;section.hidden=!extra.hidden;toggle.textContent=extra.hidden?'显示 RenoDX 高级参数':'显示 Feeder 馈送参数';};
    }
    panel.querySelector('footer').textContent = status===sample?'当前为交互式设计预览。进入游戏后自动连接 RenoDX DLSS 5，按 Home 键可呼出完整中文调节面板。':status?.nrAvailable
      ? '实时 RenoDX DLSS 5 设置已连接。A/B/C 切换神经渲染风格；按 Home 键可呼出完整 ReShade + MFG + DLSS 5 全中文高级菜单。'
      : '正在等待游戏加载 RenoDX DLSS 5 模块… 按 Home 键可随时打开完整中文菜单。';
  }
  function build() {
    window.mountOverlayPanel(root);
    const panel = root.querySelector('.ol-panel');
    panel.classList.add('ol-connected');
    const modes = el('div', 'ol-models ol-live-modes');
    for (const [label, design] of [['全部实时工具', false], ['DLSS 5 核心控制', true]]) {
      const b = el('button', `ol-model ${preview === design ? 'selected' : ''}`, label);
      b.onclick = () => { preview = design; build(); update(); }; modes.append(b);
    }
    // Preserve the requested panel itself; optional FX tools never replace it
    // automatically and are not presented as a RenoDX connection.
    panel.after(modes);
    if(designOnly){
      const backend=el('button','ol-preview-backend',sample.feedPresent?'预览模式：Feeder + RenoDX':'预览模式：RenoDX');
      backend.onclick=()=>{
        sample.feedPresent=!sample.feedPresent;
        sample.feedReason='仅预览模式：Feeder 参数需在无原生 DLSS 游戏中生效。';
        sample.badge=false;
        sample.feedTools=[['启用 Feeder 深度馈送',1,1,0,1],['工作分辨率 (%)',0,100,50,100],['工作锐度',0,.3,0,1],['运动矢量缩放 X',0,1,-2,2],['运动矢量缩放 Y',0,1,-2,2],['HDR 色彩契约',0,-1,-1,1],['深度方向约定',0,-1,-1,1],['工作分辨率上采样',0,0,0,2],['HDR10 桥接',0,-1,-1,1],['HDR 参考白点 (尼特)',0,203,50,1000],['输出稳定器保持',0,0,0,1],['稳定器变化容差',0,.04,0,1]].map(([name,kind,value,min,max],i)=>({id:301+i,name,kind,value,min,max,step:[0,1,5,6,7,8,9].includes(i)?1:.01,available:i!==0,effect:'Feeder 1.19.0'}));
        build();update();
      };
      modes.after(backend);
    }
    if(status!==sample){const note=el('p','ol-live-note ol-nr-status',nrNote());note.hidden=!note.textContent;modes.after(note);}
    if (preview) { bindNr(panel); return; }
    panel.querySelector('.ol-prototype').textContent = status ? '已连接游戏' : '未连接';
    panel.querySelector('.ol-eyebrow').textContent = 'DLSS 5 SWAPPER · 游戏内实时控制';
    for (const element of [...panel.children]) if (element !== modes && element.tagName !== 'HEADER') element.remove();
    const info = el('p', 'ol-live-note', status===sample?'设计预览模式，未连接游戏。':status?.nrAvailable ? 'RenoDX 神经渲染控制已实时连接。按 Home 键可打开原版完整中文高级菜单。' : '等待游戏加载兼容的 RenoDX 模块。');
    panel.append(info);
    const tools = el('div', 'ol-live-tools'); panel.append(tools);
    const add = t => addTool(tools, t);
    add({ id: 0, kind: 3, name: '启用 ReShade 着色器效果' });
    let previousEffect = '';
    for (const t of [...(status?.nrAvailable ? status.nrTools : []), ...(status?.feedPresent ? status.feedTools : []), ...(status?.tools || [])]) {
      if (t.effect !== previousEffect) { tools.append(el('h4', 'ol-live-effect', t.effect)); previousEffect = t.effect; }
      add(t);
    }
    if (!status?.tools.length) tools.append(el('p', 'ol-live-note', '未检测到额外的 .fx 着色器参数（RenoDX 原生插件无需 .fx 着色器即可运行）。'));
    panel.append(el('footer', 'ol-live-hotkey', `${root.dataset.overlayHotkey||'F8'}: 显示/隐藏 · 拖动顶部: 移动窗口 · Esc: 关闭 · Home: 完整高级菜单`));
  }
  function update() {
    const note = root.querySelector('.ol-nr-status'); if (note) { note.textContent = nrNote(); note.hidden = !note.textContent; }
    const feedNote=root.querySelector('.ol-feed-status');if(feedNote)feedNote.textContent=status?.feedReason||'';
    for (const input of root.querySelectorAll('[data-live-id]')) {
      const id = Number(input.dataset.liveId);
      const t = id >= 301 ? status?.feedPresent&&status.feedTools?.find(t=>t.id===id) : id === 0 ? { kind: 3, value: status?.effects ? 1 : 0, available: !!status } :
        // The on-screen status card is the add-on's own, so it is available
        // as soon as the overlay is connected - with or without a consumer.
        id === 50 ? { kind: 1, value: status?.badge ? 1 : 0, available: !!status, effect: 'DLSS 5 Swapper', name: 'On-screen status card' } :
        id >= 101 ? status?.nrAvailable && status.nrTools?.find(t => t.id === id) : status?.tools.find(t => t.id === id);
      input.disabled = !t?.available;
      if (!t || input.dataset.dragging || (document.activeElement === input && input.type === 'number')) continue;
      input.title = `${t.effect} / ${t.name}`;
      if (input.type === 'range' || input.type === 'number') { input.min = t.min; input.max = t.max; input.step = t.step; input.value = Number(t.value).toFixed(2); }
      else if(input.updateChoice) input.updateChoice(t);
      else input.checked = !!t.value;
    }
    const style = status?.nrAvailable && status.nrTools?.find(t => t.id === 114);
    const correctStyles = JSON.stringify(style?.options) === JSON.stringify(['Default', 'Natural', 'Cinematic']);
    for (const model of root.querySelectorAll('[data-style-value]')) {
      model.disabled = !style?.available || !correctStyles;
      const selected = !model.disabled && Number(model.dataset.styleValue) === style.value;
      model.classList.toggle('selected', selected); model.setAttribute('aria-pressed', String(selected));
    }
  }
  build(); update();
  runtime?.onStatus(value => {
    if (!value && !connectedOnce) return;
    const rebuild = !connectedOnce || epoch !== value?.epoch || status?.nrAvailable !== value?.nrAvailable || status?.nrEnabled !== value?.nrEnabled || !!status?.nrTools !== !!value?.nrTools || status?.feedPresent!==value?.feedPresent;
    status = value; epoch = value?.epoch || 0;
    connectedOnce = true;
    if(value?.nrTools&&!value.nrEnabled&&autoEpoch!==epoch){autoEpoch=epoch;send(200,1,1);}
    if (rebuild) build();
    update();
  });
};
