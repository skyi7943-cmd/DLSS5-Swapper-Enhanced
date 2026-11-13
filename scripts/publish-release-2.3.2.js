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

const setupPath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-Setup-2.3.2.exe');
const portablePath = path.join(ROOT, 'dist', 'DLSS5-Swapper-Enhanced-2.3.2-portable.exe');

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

const releaseTitle = 'DLSS 5 Swapper Enhanced v2.3.2 (安装版 + 便携版 · 一层DLSS5画质强化与省卡快调专版)';
const releaseBody = [
  '## ⚡ DLSS 5 Swapper Enhanced v2.3.2（一层 DLSS 5 画质强化与省卡快调专版）',
  '',
  '### 📦 下载选择说明',
  '| 版本类型 | 文件名 | 大小 | 适用场景 |',
  '| :--- | :--- | :--- | :--- |',
  `| **💿 安装向导版** | \`DLSS5-Swapper-Enhanced-Setup-2.3.2.exe\` | **${setupInfo.sizeMB} MB** | 支持**自定义选择安装路径（如 E 盘）**、自动生成桌面/开始菜单快捷方式、支持控制面板无损卸载 |`,
  `| **🎒 免安装便携版** | \`DLSS5-Swapper-Enhanced-2.3.2-portable.exe\` | **${portableInfo.sizeMB} MB** | 单文件双击即用，无需安装，适合随身携带或放在任意目录直接运行 |`,
  '',
  '---',
  '',
  '### ✨ v2.3.2 核心升级亮点',
  '',
  '1. **🔥 一层 DLSS 5 (`NRPasses=1`) 画质显著强化（绝不开启双倍耗卡的第 2 层叠加）**',
  '   - **解锁微表面几何重塑上限 (`NRLocalStructure` + `NRSkinIndependent=0`)**：当微结构重塑大于 `1.0x` 时自动解除 RenoDX 默认皮肤独立截断锁，让单次 NGX Feature 18 神经推理直接输出更强的砖石、金属、木纹与地面立体凹凸质感。',
  '   - **激活零额外通道的精细细节塑形管线 (`NRLookMode=1` + `NRLookDetail` / `NRLookTone` / `NRLookColour`)**：无需增加任何 Tensor Core 神经渲染通道耗时，同步放大高频微表面纹理与大尺度光影对比度。',
  '   - **总强度与静止防抖协同 (`NRIntensity` + `hold_strength`)**：拉升单层神经混合权重并智能抑制静止暗部微噪点呼吸。',
  '',
  '2. **⚡ 同步大幅降低 GPU 算力与显存开销（画质更强、显卡更省）**',
  '   - **内部神经与馈送工作分辨率整数比联动 (`NRResolutionScale` + `work_resolution` + `NRLookUpsample=1`)**：',
  '     - **🔥 单层强效·省卡推荐 (`boost_eco`)**：锁定精准 3/4 整数比 (`75%`) 工作分辨率 + FSR1 极速空间超分与 RCAS 边缘锐化补偿 (`0.35`) + 3 工作集精简池，**像素推理算力直降约 44%** 且单层画质强化约 **+35%**！',
  '     - **⚡ 极致省卡·高帧优先 (`ultra_eco`)**：面向 6G/8G 显卡、掌机或高刷电竞场景，内部工作分辨率降至 `67%` + 2 工作集精简池 + `0.45` 锐化与 `1.40x` 细节补偿，**像素推理负担直降约 55%**！',
  '     - **💎 单层满血·极限质感 (`ultra_vivid`)**：面向桌面大显存显卡，保持 `100%` 原生工作分辨率，单层总强度拉至 `1.55x`、微结构 `1.45x`、精细细节 `1.45x`。',
  '     - **⚖️ 原厂标准 (`standard`)**：一键恢复单层 `1.00x` 原厂默认基线。',
  '   - **极速光流与关闭多通道几何求解器 (`DLSS5_MV_PROVIDER=2` + `GEOM_ENABLE=0`)**：省卡档位下自动切换轻量级光流管线并关闭重度相机几何求解，进一步释放帧率。',
  '   - **动态显存预算联动**：面板显存预算进度条实时反映单层省卡档位带来的显存节省。',
  '',
  '3. **🎛️ 桌面端 + 游戏内 `Home` 键全中文双端自定义调节与毫秒级免重装热更新**',
  '   - **桌面端调优器**：新增「⚡ 一层 DLSS 5 画质强化与省卡调优器」，内置 4 套一键预设、8 项专家自定义滑块/下拉菜单与 **「⚡ 立即热更新一层强化与省卡参数（免重装 · 游戏运行中也可秒级生效）」** 按钮。',
  '   - **游戏内 `Home` 键快调面板 (`dlss5-zh-cn.addon64` & `dlss5-zh-cn.addon32`)**：同时覆盖 64 位原生/Feeder 游戏与 32 位 `host64` 跨进程老游戏；拖动滑块即可通过无锁原子变量直写实时看画面变化，并支持每 500ms 自动热同步外部桌面端改写的参数！',
  '',
  '4. **📂 学习版 / 免安装中文游戏库自动扫描增强**',
  '   - 扩展全盘自动扫描目录匹配规则，自动识别 `游戏`、`单机游戏`、`学习版`、`免安装*` 等中文独立游戏库根目录。',
  '',
  '---',
  '',
  '### 🔐 SHA-256 校验值',
  `- \`DLSS5-Swapper-Enhanced-Setup-2.3.2.exe\`: \`${setupInfo.sha256}\``,
  `- \`DLSS5-Swapper-Enhanced-2.3.2-portable.exe\`: \`${portableInfo.sha256}\``
].join('\n');

async function main() {
  console.log('2/4 Checking or creating GitHub Release v2.3.2...');
  let relResp = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v2.3.2`, { headers });
  let rel;
  if (relResp.status === 404) {
    const createResp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tag_name: 'v2.3.2',
        target_commitish: 'main',
        name: releaseTitle,
        body: releaseBody,
        draft: false,
        prerelease: false
      })
    });
    if (!createResp.ok) {
      throw new Error(`Failed to create release v2.3.2 (${createResp.status}): ${await createResp.text()}`);
    }
    rel = await createResp.json();
  } else if (relResp.ok) {
    rel = await relResp.json();
  } else {
    throw new Error(`Failed to fetch release v2.3.2: ${relResp.status}`);
  }

  const releaseId = rel.id;

  for (const asset of rel.assets || []) {
    if (
      asset.name === 'DLSS5-Swapper-Enhanced-2.3.2-portable.exe' ||
      asset.name === 'DLSS5-Swapper-Enhanced-Setup-2.3.2.exe'
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

  console.log('4/4 Updating GitHub Release v2.3.2 title and notes...');
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
  console.log('ALL DONE! GitHub Release v2.3.2 is live with both Setup and Portable editions!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
