'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// 1. 清理测试生成的重复缓存目录 payload/userData 与临时调试符号
fs.rmSync(path.join(ROOT, 'payload', 'userData'), { recursive: true, force: true });
for (const extFile of ['winmm.pdb', 'winmm_preload.lib']) {
  fs.rmSync(path.join(ROOT, 'payload', 'enhanced', 'zh-cn', extFile), { force: true });
}

// 校验所有核心离线载荷均完整存在
const requiredPayloadFiles = [
  'payload/streamline/nvngx_dlssnr.dll',
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

const setupPath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-Setup-2.3.1.exe');
const portablePath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-2.3.1-portable.exe');

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

const releaseTitle = 'DLSS 5 Swapper Enhanced v2.3.1 (安装版 + 便携版 · 经典老游戏全栈兼容增强版)';
const releaseBody = [
  '## 🚀 DLSS 5 Swapper Enhanced v2.3.1（经典老游戏全栈兼容增强版）',
  '',
  '### 📦 下载选择说明',
  '| 版本类型 | 文件名 | 大小 | 适用场景 |',
  '| :--- | :--- | :--- | :--- |',
  `| **💿 安装向导版** | \`DLSS5-Swapper-Enhanced-Setup-2.3.1.exe\` | **${setupInfo.sizeMB} MB** | 支持**自定义选择安装路径（如 E 盘）**、自动生成桌面/开始菜单快捷方式、支持控制面板无损卸载 |`,
  `| **🎒 免安装便携版** | \`DLSS5-Swapper-Enhanced-2.3.1-portable.exe\` | **${portableInfo.sizeMB} MB** | 单文件双击即用，无需安装，适合随身携带或放在任意目录直接运行 |`,
  '',
  '---',
  '',
  '### ✨ v2.3.1 核心审计与老游戏兼容修复内容',
  '',
  '1. **🛡️ 通用 32 位兼容与预加载桥 (`winmm.dll`) 全面升级**',
  '   - **多核 CPU (>8 逻辑核心) 引擎死锁自动收敛**：在 `DllMain` 阶段自动将 32 位老游戏进程收敛至前 8 逻辑核心并同步虚拟化 `GetSystemInfo` / `GetNativeSystemInfo`，彻底解决《虐杀原形 (Prototype)》等老引擎在 16/24/32 线程处理器上的启动卡死问题，同时 `host64` 64 位神经渲染进程保持全核心满速运行。',
  '   - **Win9x/Win2000 大内存页文件溢出修复 (`GlobalMemoryStatus`)**：解决《三角洲特种部队：大地勇士 (Delta Force: Task Force Dagger)》等老游戏在现代大内存系统上误报 `< 140MB` 虚拟内存不足无法启动的问题。',
  '   - **零 UAC Steam 安装脚本注册表虚拟化 (`legacy-installscript.js` + `NtQueryKey` / `advapi32` 钩子)**：自动解析游戏目录中的 `installscript.vdf` / `*_install.vdf` 及关联 `.reg` 脚本（如《三角洲特种部队：极限版 (Delta Force: Xtreme)》的 `Path` 与 `CDKIID`），免管理员弹窗预置到 `HKCU\\Software\\DLSS5Swapper\\VirtualHKLM\\...` 并在运行时透明回退读取。',
  '   - **全路径窗口与扩展加载预挂载 (`CreateWindowExA/W` + `LoadLibraryExA/W`)**：确保静态导入 `d3d8.dll` / `d3d9.dll` 的引擎模块（如 `prototypeenginef.dll`、`e2_d3d8_driver_mfc.dll`）在初始化 `dgVoodoo2` 之前完成本地 ReShade `dxgi.dll` 预加载，消除系统目录 `System32\\dxgi.dll` 抢占与 Loader Lock 死锁。',
  '2. **🎮 32 位 OpenGL (GoldSrc / SDL2) 跨进程 DLSS 5 桥接 (`Counter-Strike 1.6` / `Half-Life`)**',
  '   - 自动额外部署受控 `ReShade32.dll` 配合 `winmm.dll` 按需挂载，彻底解决 GoldSrc 引擎 (`hl.exe`) 启动时自动删除本地 `opengl32.dll` 以及 SDL2 绝对路径加载 `System32\\opengl32.dll` 导致无法注入的问题。',
  '   - 优化 Steam 库共享基底包去重逻辑 (`StateFlags & 64`)，在共享 `Half-Life` 目录中准确展示实际已安装的《反恐精英 (Counter-Strike)》。',
  '3. **🖥️ `dgVoodoo2` 32 位专属显存防溢出与无边框伪全屏优化**',
  '   - 32 位老游戏自动设置 `VRAM = 1024`（规避 `4096 MB = 0x100000000` 字节级 32 位整数溢出）、`[GeneralExt] FullscreenAttributes = fake`（彻底解决《侠盗猎车手：罪恶都市 (GTA: Vice City)》DirectShow 开场视频独占全屏切换闪退，并保障 Windows 11 DWM 下 `host64` 神经渲染叠加层稳定贴合）以及补充 `640x480` / `800x600` / `1024x768` 经典低分辨率枚举。',
  '4. **🧹 扫描器与兼容性守卫精细化修复**',
  '   - 修复 `compatibility.js` 对 DirectDraw (`DDraw.dll` + `D3DImm.dll`) 包装层与 `d3d11` 代理选项的识别；修复 `apply.js` 在包装 API 下对已有 `dgVoodoo` DLL 的误冲突判断及 `dlss5-zh-cn.addon32` 无损还原清理。',
  '   - 自动降权地图编辑器 (`*med.exe` / `*editor.exe`)、排除升级工具 (`REVUPDAT.EXE` / `hltv.exe`)，并自动过滤 Steam 卸载残留且缺失核心静态依赖的孤立目录。',
  '',
  '---',
  '',
  '### ✅ 本次实机启动与神经渲染全链路验证通过的经典老游戏清单',
  '- 《三角洲特种部队 2 (Delta Force 2)》 (`32-bit DirectDraw`)',
  '- 《三角洲特种部队：大地勇士 (Delta Force: Task Force Dagger)》 (`32-bit DirectDraw`)',
  '- 《三角洲特种部队：极限版 (Delta Force: Xtreme)》 (`32-bit DirectX 9`)',
  '- 《侠盗猎车手：罪恶都市 (Grand Theft Auto: Vice City)》 (`32-bit DirectX 8`)',
  '- 《马克思佩恩 2 (Max Payne 2: The Fall of Max Payne)》 (`32-bit DirectX 8`)',
  '- 《反恐精英 1.6 (Counter-Strike / GoldSrc)》 (`32-bit OpenGL`)',
  '- 《虐杀原形 (Prototype)》 (`32-bit DirectX 9`)',
  '',
  '---',
  '',
  '### 🔐 SHA-256 校验值',
  `- \`DLSS5-Swapper-Enhanced-Setup-2.3.1.exe\`: \`${setupInfo.sha256}\``,
  `- \`DLSS5-Swapper-Enhanced-2.3.1-portable.exe\`: \`${portableInfo.sha256}\``
].join('\n');

async function main() {
  console.log('2/4 Checking or creating GitHub Release v2.3.1...');
  let relResp = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v2.3.1`, { headers });
  let rel;
  if (relResp.status === 404) {
    const createResp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tag_name: 'v2.3.1',
        target_commitish: 'main',
        name: releaseTitle,
        body: releaseBody,
        draft: false,
        prerelease: false
      })
    });
    if (!createResp.ok) {
      throw new Error(`Failed to create release v2.3.1 (${createResp.status}): ${await createResp.text()}`);
    }
    rel = await createResp.json();
  } else if (relResp.ok) {
    rel = await relResp.json();
  } else {
    throw new Error(`Failed to fetch release v2.3.1: ${relResp.status}`);
  }

  const releaseId = rel.id;

  for (const asset of rel.assets || []) {
    if (
      asset.name === 'DLSS5-Swapper-Enhanced-2.3.1-portable.exe' ||
      asset.name === 'DLSS5-Swapper-Enhanced-Setup-2.3.1.exe'
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

  console.log('4/4 Updating GitHub Release v2.3.1 title and notes...');
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
  console.log('ALL DONE! GitHub Release v2.3.1 is live with both Setup and Portable editions!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
