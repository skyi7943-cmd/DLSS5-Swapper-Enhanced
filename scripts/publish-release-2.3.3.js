'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// 1. 清理测试生成的重复缓存目录 payload/userData 与临时调试符号
fs.rmSync(path.join(ROOT, 'payload', 'userData'), { recursive: true, force: true });
for (const extFile of ['winmm.pdb', 'winmm_preload.lib', 'dlss5-zh-cn.pdb']) {
  fs.rmSync(path.join(ROOT, 'payload', 'enhanced', 'zh-cn', extFile), { force: true });
}

// 确保 vendor/enhanced-cache/zh-cn 与最新编译的 payload/enhanced/zh-cn 完全一致（防止 prebuild 执行 collect-payload.js 时回退为旧缓存）
for (const addonName of ['dlss5-zh-cn.addon64', 'dlss5-zh-cn.addon32']) {
  const builtAddon = path.join(ROOT, 'payload', 'enhanced', 'zh-cn', addonName);
  const cachedAddon = path.join(ROOT, 'vendor', 'enhanced-cache', 'zh-cn', addonName);
  if (fs.existsSync(builtAddon) && fs.existsSync(path.join(ROOT, 'vendor', 'enhanced-cache'))) {
    fs.mkdirSync(path.dirname(cachedAddon), { recursive: true });
    fs.copyFileSync(builtAddon, cachedAddon);
  }
}

// 校验所有核心离线载荷均完整存在
const requiredPayloadFiles = [
  'payload/streamline/nvngx_dlssnr.dll',
  'payload/renodx-dlss5.addon64',
  'payload/feeder/dlss5-feed-host64.exe',
  'payload/feeder/dlss5-feed.addon32',
  'payload/reshade-vulkan/ReShade32.dll',
  'payload/enhanced/components/dgVoodoo2-2.87.5.zip',
  'payload/enhanced/components/LumeniteFX-f8cbbb4e.zip',
  'payload/enhanced/zh-cn/dlss5-zh-cn.addon32',
  'payload/enhanced/zh-cn/dlss5-zh-cn.addon64',
  'payload/enhanced/zh-cn/winmm.dll'
];
for (const rel of requiredPayloadFiles) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    throw new Error(`Missing required payload file before packaging: ${rel}`);
  }
}

// 2. 构建 NSIS 安装版与 Portable 便携版
console.log('1/4 Building NSIS Setup + Portable packages via electron-builder...');
const buildRes = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', 'portable'],
  { stdio: 'inherit', cwd: ROOT }
);
if (buildRes.status !== 0) {
  throw new Error(`electron-builder exited with code ${buildRes.status}`);
}

const setupPath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-Setup-2.3.3.exe');
const portablePath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-2.3.3-portable.exe');

function getFileStats(filePath) {
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  let bytesRead = 0;
  while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, bytesRead));
  }
  fs.closeSync(fd);
  return {
    sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
    sizeBytes: stat.size,
    sha256: hash.digest('hex')
  };
}

const setupInfo = getFileStats(setupPath);
const portableInfo = getFileStats(portablePath);
console.log(`Setup:    ${setupInfo.sizeMB} MB | SHA256: ${setupInfo.sha256}`);
console.log(`Portable: ${portableInfo.sizeMB} MB | SHA256: ${portableInfo.sha256}`);

// 3. 获取 GitHub Token
const credOut = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
});
const m = credOut.match(/password=([^\r\n]+)/);
if (!m) throw new Error('GitHub token not found in git credential manager');
const token = m[1].trim();

const repo = 'skyi7943-cmd/DLSS5-Swapper-Enhanced';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DLSS5-Swapper-Enhanced-Publisher'
};

const releaseTitle = 'DLSS 5 Swapper Enhanced v2.3.3 (安装版 + 便携版 · 修复游戏内 Home 键闪退 & 纯净游戏内一层DLSS5快调专版)';
const releaseBody = [
  '## 🛠️ DLSS 5 Swapper Enhanced v2.3.3（修复按 `Home` 键闪退 & 游戏内专属一层 DLSS 5 快调版）',
  '',
  '### 📦 下载选择说明',
  '| 版本类型 | 文件名 | 大小 | 适用场景 |',
  '| :--- | :--- | :--- | :--- |',
  `| **💿 安装向导版** | \`DLSS5-Swapper-Enhanced-Setup-2.3.3.exe\` | **${setupInfo.sizeMB} MB** | 支持**自定义选择安装路径（如 E 盘）**、自动生成桌面/开始菜单快捷方式、支持控制面板无损卸载 |`,
  `| **🎒 免安装便携版** | \`DLSS5-Swapper-Enhanced-2.3.3-portable.exe\` | **${portableInfo.sizeMB} MB** | 单文件双击即用，无需安装，适合随身携带或放在任意目录直接运行 |`,
  '',
  '---',
  '',
  '### 🚨 v2.3.3 关键修复与架构收敛（基于《影之刃零》实机验证）',
  '',
  '1. **🐛 彻底修复游戏内按 `Home` 键闪退崩溃 (`0xC0000005` MinGW/MSVC ABI 冲突)**',
  '   - **根因定位**：`dlss5-zh-cn.addon64` 采用 Zig MinGW (`x86_64-windows-gnu`) 编译，而 `ReShade64.dll` 采用 MSVC 编译；跨 ABI 调用按值返回非 POD 结构体 `ImVec2` 的 `ImGui::GetContentRegionAvail()` 时，MSVC 期望 `RCX` 传入隐藏返回缓冲区指针 (`sret`) 而 MinGW 未传，导致按下 `Home` 键首次渲染快调面板瞬间触发空指针/野指针写入异常。',
  '   - **彻底根除**：全面移除 `zh-cn-overlay.cpp` 中所有按值返回 `ImVec2` / `ImVec4` 的 ImGui 函数调用，改为纯标量/引用接口（`GetWindowWidth() - GetCursorPosX() - style.WindowPadding.x`），直通 `g_orig` 原始函数表，并通过 64 位与 32 位双架构汇编指令级扫描确认 **0 处结构体按值返回调用**。',
  '',
  '2. **🧹 桌面端界面精简回归，所有一层 DLSS 5 调优参数集中收归游戏内 `Home` 菜单**',
  '   - 移除桌面软件内的冗余单层调优滑块面板，保持桌面端一键配置界面清爽简洁。',
  '   - 游戏内按 **`Home` 键**即可**自动同步弹出右侧悬浮「★ 一层 DLSS 5 增效与省卡快调」面板**（无需翻找小标签，再次按 `Home` 同步收起；同时亦提供顶栏 `★ 一层 DLSS5 快调` 标签页、`插件 (Add-ons)` 折叠栏及 32 位游戏侧边栏），实时切换 4 套预设（`[推荐] 单层强效·省卡 (-44%)`、`[省卡] 极致省卡·高帧 (-55%)`、`[满血] 单层满血·极限 (100%)`、`[基准] 原厂标准 1.0x`）与精细滑块，边看游戏画面边调参、零延迟生效！',
  '',
  '3. **🔒 游戏内自定义参数防覆盖与 ReShade 内存缓存同步**',
  '   - 64 位原生游戏通过 `reshade::set_config_value` 直接同步写入 ReShade 内存配置缓存并落盘，彻底杜绝关闭 `Home` 菜单时被 ReShade 旧缓存覆盖回退；并支持与 `renodx-dlss5.addon64` 原生滑块双向实时同步。',
  '   - 桌面端再次点击「保存并应用增强配置」（例如切换多帧生成倍率）时，自动快照保留玩家在游戏内 `Home` 菜单调好的参数，绝不重置玩家心仪的画质设定。',
  '   - 限制 `on_reshade_present` 配置文件轮询仅在 32 位跨进程 `dlss5-feed-host64.exe` 中启用，64 位原生游戏帧呈现阶段保持 **零磁盘 I/O 开销**。',
  '',
  '---',
  '',
  '### 🔐 SHA-256 校验值',
  `- \`DLSS5-Swapper-Enhanced-Setup-2.3.3.exe\`: \`${setupInfo.sha256}\``,
  `- \`DLSS5-Swapper-Enhanced-2.3.3-portable.exe\`: \`${portableInfo.sha256}\``
].join('\n');

async function main() {
  console.log('2/4 Checking or creating GitHub Release v2.3.3...');
  let relResp = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v2.3.3`, { headers });
  let rel;
  if (relResp.status === 404) {
    const createResp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tag_name: 'v2.3.3',
        target_commitish: 'main',
        name: releaseTitle,
        body: releaseBody,
        draft: false,
        prerelease: false
      })
    });
    if (!createResp.ok) {
      throw new Error(`Failed to create release v2.3.3 (${createResp.status}): ${await createResp.text()}`);
    }
    rel = await createResp.json();
  } else if (relResp.ok) {
    rel = await relResp.json();
  } else {
    throw new Error(`Failed to fetch release v2.3.3: ${relResp.status}`);
  }

  const releaseId = rel.id;

  for (const asset of rel.assets || []) {
    if (
      asset.name === 'DLSS5-Swapper-Enhanced-2.3.3-portable.exe' ||
      asset.name === 'DLSS5-Swapper-Enhanced-Setup-2.3.3.exe'
    ) {
      console.log(`Deleting old asset ${asset.name} (id=${asset.id})...`);
      const delResp = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
        method: 'DELETE',
        headers
      });
      if (!delResp.ok && delResp.status !== 204) {
        throw new Error(`Failed to delete asset ${asset.name}: ${delResp.status}`);
      }
    }
  }

  for (const [filePath, info] of [
    [setupPath, setupInfo],
    [portablePath, portableInfo]
  ]) {
    const fileName = path.basename(filePath);
    console.log(`3/4 Uploading ${fileName} (${info.sizeMB} MB)...`);
    const blob = await fs.openAsBlob(filePath, { type: 'application/octet-stream' });
    const upResp = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.sizeBytes)
        },
        body: blob
      }
    );
    if (!upResp.ok) {
      const errText = await upResp.text();
      throw new Error(`Failed to upload ${fileName} (${upResp.status}): ${errText}`);
    }
    console.log(`Uploaded ${fileName} successfully!`);
  }

  console.log('4/4 Updating GitHub Release v2.3.3 title and notes...');
  const patchResp = await fetch(`https://api.github.com/repos/${repo}/releases/${releaseId}`, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      name: releaseTitle,
      body: releaseBody
    })
  });
  if (!patchResp.ok) {
    throw new Error(`Failed to patch release notes: ${patchResp.status}`);
  }
  console.log('ALL DONE! GitHub Release v2.3.3 is live with both Setup and Portable editions!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
