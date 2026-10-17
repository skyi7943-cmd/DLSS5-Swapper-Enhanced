<h1 align="center">DLSS 5 Swapper Enhanced (v2.2.9-Enhanced)</h1>

<p align="center">
  <b>最新 2026 年 10 月 DLSS 5 神经渲染 · RTX 40 系列 x3/x4 多帧生成解锁 · 双模块协同运行 · 游戏内 Home 菜单全量零崩溃简体中文汉化</b><br/>
  <sub>专为 NVIDIA GeForce RTX 4070 Laptop (8GB VRAM) 等主流移动端与桌面端 RTX 显卡深度调优</sub>
</p>

---

## 一、项目简介

**DLSS 5 Swapper Enhanced** 是基于原版 `DLSS 5 Swapper v2.2.9` 深度重构与扩展的增强版 Windows 图形增强工具。本项目在完整保留原版自动游戏扫描、三路由注入（RenoDX / Feeder / OptiScaler）与事务级备份还原的基础上，全新开发并集成了 **四大核心增强特性**：

1. **模块 A — 最新 2026 年 10 月 DLSS 5 神经渲染管线**：内置并管理 NVIDIA 最新 `nvngx_dlssnr.dll (310.8.SF-v2)` 神经渲染模型，全面升级 `RenoDX DLSS5 v8.5.0-rc10` 与 `DLSS 5 Feeder v1.19.0`，支持模型版本切换、SHA-256 校验、合法模型手动导入与一键回滚。
2. **模块 B — NVIDIA RTX 40 系列 x3/x4 多帧生成解锁 (`MFG Manager`)**：突破官方对 RTX 40 (Ada Lovelace) 系列的倍率限制，通过 `renodx-mfgunlock.addon64 (v1.4.4)` + 正版签名 `nvngx_dlssg.dll (310.9.16.0)` + `sl.dlss_g.dll (2.14.16.0)` 原生驱动路径，在 RTX 4070 Laptop 上实现真实的 **Off / x2 / x3 / x4** 多帧生成与 NVIDIA 动态 MFG。
3. **模块 C — DLSS 5 神经渲染 + MFG x3/x4 联合同时运行（8GB 显存专项优化）**：彻底解决原版与旧版插件在同时开启 DLSS 5 与多帧生成时的 Streamline 钩子抢占闪退与 8GB 显存溢出崩溃问题。内置 7 项实时协同诊断（DLL 冲突、Streamline 注入链、运动矢量边界保护、HUD/HDR 防闪烁、8GB 显存预算评估、Reflex 帧同步、事务级还原检查）。
4. **模块 D — 游戏内 `Home` 菜单全量零崩溃简体中文化 (`dlss5-zh-cn.addon64`) + 离线防升级锁**：将游戏内按 `Home` 键呼出的 ReShade 覆盖层菜单（含 `DLSS 5 Neural Rendering`、`MFG 多帧生成解锁`、`DLSS 5 Feeder`、`RenoDX DLSS`、`通用深度检测 Generic Depth`）100% 汉化为简体中文，采用内存级 ImGui 函数表钩子与 `###` 控件 ID 保持机制，**零磁盘二进制篡改、零游戏内崩溃**；同时彻底断开原作在线升级检查，防止误升级覆盖导致增强功能失效。

---

## 二、《杀手 3 / 杀手 47》(HITMAN World of Assassination) 实机运行截图与帧率实测

### 1. 测试平台配置（笔记本 RTX 4070 8GB 实机环境）

| 硬件 / 环境项 | 实机规格 |
| :--- | :--- |
| **处理器 (CPU)** | 13th Gen Intel Core i7-13650HX (14 核 20 线程) |
| **显卡 (GPU)** | **NVIDIA GeForce RTX 4070 Laptop GPU (8GB GDDR6 VRAM，140W TGP)** |
| **显卡驱动** | NVIDIA Game Ready Driver **595.59** |
| **系统内存** | 16 GB DDR5 |
| **分辨率与显示器** | **1920 × 1080 @ 165Hz (开启 G-SYNC，关闭驱动垂直同步)** |
| **测试游戏** | **《杀手 3 / 杀手 47》(HITMAN 3 / HITMAN World of Assassination — 意大利萨皮恩扎 Sapienza 高负载场景)** |

### 2. 笔记本 RTX 4070 实机性能表现：开启 DLSS 5 稳定 150~164 FPS，叠加 MFG 补帧飙升至 240~283+ FPS

- **单开 DLSS 5 神经渲染（1080p，质量档工作分辨率 / 渲染介入点，单通道 `叠加通道数 = 1`）**：
  - 在《杀手 47》意大利萨皮恩扎广场高复杂度光影与人群场景下，开启 **DLSS 5 Neural Rendering** 后画面局部色调、砖墙几何结构与人物皮肤质感显著提升，帧率稳定在 **150 – 164 FPS**（实测 NR 每帧 GPU 耗时仅 **8.1 ms – 14.3 ms**，单次会话连续增强超过 **10,015 帧** 零报错）。
- **DLSS 5 神经渲染 + RTX 40 MFG 多帧生成（x3 / x4）同时开启**：
  - 在保持 DLSS 5 神经渲染开启的同时，启用 **MFG 多帧生成解锁 (`DLSS-G 310.9.16.0` + `Streamline 2.14.16.0`)** 并开启 **自适应画质套件 V3（亮度感知 + 方向自适应 V3）**，输出帧率从 **~150 FPS** 直接提升至 **240 – 283+ FPS**，全程本地显存峰值稳定在 **~6.07 GB / 8.00 GB**，完全处于笔记本 8GB 显存安全红线之内，无任何闪烁、拖影或闪退。

### 3. 游戏内实测截图展示

#### （1）《杀手 47》(HITMAN 3) 开启 DLSS 5 神经渲染 + MFG 多帧生成实机画面
![杀手47 开启 DLSS 5 神经渲染与 MFG 多帧生成实机画面](docs/screenshots/ingame-hitman3-scene.jpg)

#### （2）游戏内 `Home` 菜单 — `DLSS 5 Neural Rendering` 全中文实时状态与外观微调面板（实测 150~164 FPS）
![游戏内 Home 菜单 DLSS 5 神经渲染中文面板 1](docs/screenshots/ingame-dlss5-nr-panel-1.png)

#### （3）游戏内 `Home` 菜单 — `DLSS 5 Neural Rendering` 性能、单通道叠加与工作分辨率优化面板
![游戏内 Home 菜单 DLSS 5 神经渲染中文面板 2](docs/screenshots/ingame-dlss5-nr-panel-2.png)

#### （4）游戏内 `Home` 菜单 — `MFG Unlock (MFG 多帧生成解锁)` 全中文控制面板（DLSS-G 310.9.16 + Streamline 2.14.16 + 自适应画质套件 V3）
![游戏内 Home 菜单 MFG 多帧生成解锁全中文面板](docs/screenshots/ingame-mfg-unlock-panel-zh.png)

---

## 三、DLSS 5 Swapper Enhanced 软件界面截图

#### （1）游戏库主界面（全中文界面、自动识别已安装游戏与图形 API）
![软件主界面 - 游戏库](docs/screenshots/app-games-library.png)

#### （2）`DLSS 5 + MFG` 增强控制中心（模块 A 神经渲染模型管理 + 模块 B RTX 40 x3/x4 多帧生成配置）
![软件界面 - DLSS 5 + MFG 增强控制中心](docs/screenshots/app-enhanced-control-center.png)

#### （3）模块 C 双模块联合运行 7 项诊断、8GB 显存预算监控与模型版本库
![软件界面 - 7 项协同诊断与显存监控](docs/screenshots/app-enhanced-diagnostics.png)

---

## 四、Enhanced 增强版 vs 原版 DLSS 5 Swapper (v2.2.9) 核心差异对比

| 功能维度 | 原版 DLSS 5 Swapper v2.2.9 | DLSS 5 Swapper Enhanced (本仓库增强版) |
| :--- | :--- | :--- |
| **DLSS 5 神经渲染插件内核** | 旧版 RenoDX v4.7 (`88116071`) + Feeder v1.17.0，在多款 DX12/Streamline 新游戏中触发异常导致闪退 | 全面升级至 **2026 年 10 月最新 `RenoDX DLSS5 v8.5.0-rc10`** + **`Feeder v1.19.0`**，彻底修复新游戏启动闪退与编码器崩溃 |
| **DLSS 5 神经渲染模型管理** | 仅支持单一固定 DLL 替换，无模型版本库或哈希校验 | 内置 **`310.8.SF-v2` (2026.10 最新)** 与基线模型双轨管理，支持 SHA-256 校验、自定义合法 `nvngx_dlssnr.dll` 导入与切换 |
| **RTX 40 系列 x3/x4 多帧生成** | ❌ 不支持（仅负责神经渲染，无帧生成管理能力） | ✅ **内置独立 `MFG Manager` 模块**，支持 **Off / x2 / x3 / x4** 倍率选择、NVIDIA 动态 MFG、Ada 时域中点修正与自适应画质套件 V3 |
| **DLSS-G 与 Streamline 运行时栈** | 旧版 `2.14.1` 组件，缺少 `sl.dlss_g.dll` 动态多帧生成支持 | 内置 NVIDIA 正版签名 **`nvngx_dlssg.dll (310.9.16.0)`** + **`sl.dlss_g.dll (2.14.16.0)`** 完整运行时栈 |
| **DLSS 5 + MFG 同时开启协同** | ❌ 自行混装极易因 Streamline 钩子冲突或双通道显存翻倍导致游戏闪退 | ✅ 自动配置 **`LoadFromDllMain` 早期加载** + **强制默认单通道 (`NRPasses=1`)**，在 RTX 4070 Laptop 8GB 显存下稳定同开 |
| **笔记本 8GB 显存防爆优化** | 默认可能残留 2x/3x 多通道叠加，每帧执行多次 NR 推理导致显存溢出与帧率腰斩 | 自动锁定 **1 次单通道推理** + 支持 **渲染超分前 (`Pre-SR`) / 质量档工作分辨率**，每帧 GPU 开销降低 40% 以上 |
| **游戏内 `Home` 菜单全中文汉化** | 仅部分面板有翻译，`MFG Unlock`、`Feeder`、`Generic Depth` 及高级诊断全部为纯英文 | ✅ **独创 `dlss5-zh-cn.addon64` 零崩溃内存级全量汉化插件**，包含 653 条精确词条与 65 条动态规则，游戏内所有菜单 100% 简体中文 |
| **防误升级覆盖保护** | 启动时自动请求原作者 GitHub 检查更新并弹出升级横幅，更新后会覆盖丢失增强功能 | ✅ **已彻底断开原作在线升级检查与跳转按钮**，永久保持本地增强版功能稳定独立运行 |

---

## 五、针对笔记本 RTX 4070 (8GB VRAM) 的专项底层优化详解

为了让 **NVIDIA GeForce RTX 4070 Laptop GPU (8GB VRAM)** 在 1080p/2K 分辨率下同时运行 **DLSS 5 神经渲染 + x3/x4 多帧生成** 依然保持 150~280+ FPS 的极致流畅度且绝不闪退，本项目实施了五项关键工程优化：

1. **单通道神经渲染锁定 (`NRPasses=1`)**：
   - 神经渲染每增加 1 个叠加通道（Stack Pass），就会额外分配一套独立的全屏时域历史缓冲并多执行一次完整的 Tensor Core 推理。增强版在安装与配置时自动将 `ReShade.ini` 中的 `NRPasses` 重置为 `1`（单通道），消除约 `450 MB` 冗余显存占用，帧率直接翻倍。
2. **介入点与工作分辨率优化（150+ FPS 秘诀）**：
   - 在游戏内 `Home` -> `DLSS 5 Neural Rendering` 菜单中，支持将 **介入点** 设为 **“渲染 (超分前 Pre-SR)”** 或将 **分辨率** 设为 **“质量 (67%)”**。此时神经渲染直接在 DLSS 超分前的原生低分辨率工作纹理与硬件深度/运动矢量上运行，再由 DLSS 超分辨率统一放大输出，每帧 GPU 耗时可从 `14.3 ms` 进一步降至 **`~8.1 ms`**，轻松突破 150~164 FPS。
3. **Streamline 早期钩子协同 (`RuntimeSelectionMode=1` / `LoadFromDllMain`)**：
   - 当游戏同时加载 `renodx-dlss5.addon64` 与 `renodx-mfgunlock.addon64` 时，增强版自动将两者注册进 `ReShade.ini` 的 `[ADDON] LoadFromDllMain` 列表，确保在游戏引擎调用 `slInit` 之前按序完成 `sl.interposer.dll` 与 `NGX` 的无冲突挂钩。
4. **Ada 架构 x3/x4 专属画质增强（Adaptive Quality Suite V3）**：
   - 针对 RTX 40 系列开启 x3/x4 多帧生成时的光流边界与人物轮廓，默认启用 **“自适应画质套件 V3 — 亮度感知 + 方向自适应 V3”** 与 **“Ada 架构高倍率时域中点修正”**，有效抑制高速旋转镜头下的 HUD 闪烁、细小树叶/栅栏拖影与屏幕边缘伪影。
5. **零崩溃内存级中文化架构 (`dlss5-zh-cn.addon64`)**：
   - **绝不修改原版 DLL/Addon 磁盘字节**：所有第三方 `.addon64` 与 `ReShade64.dll` 的磁盘文件与 SHA-256 签名保持 100% 原样，杜绝因二进制篡改引发的哈希校验失败或段错误。
   - **`###` 控件 ID 保持机制**：所有复选框、滑块、下拉菜单与折叠面板在翻译为中文时，底层自动格式化为 `"中文译文###原始英文标签"`，Dear ImGui 画面显示中文，而内部状态哈希仍 100% 绑定原英文 ID，绝不导致滑块失灵或配置错乱。
   - **编译期 + 运行期双重 `printf` 保护**：653 条精确词条全部经过编译期占位符数量与类型一致性校验；运行期内置 `has_printf_specifier()` 过滤器，防止 `"Work resolution (%)"`、`"100%"` 等非格式化百分号被误传给 `vsnprintf` 导致栈崩溃。

---

## 六、下载、运行与构建说明

### 1. 直接运行便携版 (Portable EXE)

1. 前往本仓库的 **[Releases](../../releases)** 页面，下载最新发布的便携版程序 **`DLSS5-Swapper-Enhanced-2.2.9-portable.exe`**（或解压版压缩包）。
2. 双击即可直接运行（无需安装 Node.js 或任何开发环境）。
3. 在软件左侧导航栏点击 **“游戏 (Games)”** 或 **“DLSS 5 + MFG”**：
   - 选择目标游戏（如 `HITMAN 3`），勾选所需的 **神经渲染模型 (`Latest Compatible Model`)** 与 **多帧生成倍率 (`x2 / x3 / x4`)**，点击 **“一键应用联合配置”**。
4. 启动游戏后，按键盘 **`Home`** 键即可呼出 **100% 简体中文** 的 `DLSS 5 Neural Rendering` 与 `MFG Unlock` 实时调参菜单；按 **`F6`** 键可在游戏中随时开关 DLSS 5 神经渲染实时对比效果。

### 2. 从源代码编译与开发

```powershell
# 1. 克隆仓库
git clone https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced.git
cd DLSS5-Swapper-Enhanced

# 2. 安装依赖
npm install

# 3. 启动开发环境
npm start

# 4. 运行全量单元测试 (312+ 测试用例)
node --test --test-concurrency=1 test/*.test.js

# 5. 重新编译游戏内零崩溃中文汉化插件 (dlss5-zh-cn.addon64)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-zh-cn-addon.ps1

# 6. 打包 Windows 便携版 EXE
npm run build:portable
```

---

## 七、目录结构

```text
DLSS5-Swapper-Enhanced/
├── main.js                          # Electron 主进程（含 Enhanced IPC 与离线防升级锁）
├── preload.js                       # 安全上下文桥接层
├── overlay/
│   ├── zh-cn-overlay.cpp            # 游戏内 Home 菜单全量零崩溃中文化插件源码
│   ├── zh-cn-dict.hpp               # 编译期校验的 653 条精确词条 + 65 条动态规则字典
│   └── overlay.cpp                  # F8 紧凑型悬浮窗源码
├── src/
│   ├── core/
│   │   ├── neural-models.js         # 模块 A：DLSS 5 神经渲染模型数据库与哈希校验
│   │   ├── mfg-manager.js           # 模块 B：RTX 40 x3/x4 多帧生成解锁管理器
│   │   ├── combined-manager.js      # 模块 C：DLSS 5 + MFG 联合配置与 7 项协同诊断引擎
│   │   ├── apply.js                 # 事务级安装、自动部署汉化插件与一键还原
│   │   └── scan.js                  # 游戏可执行文件、图形 API 与 DLSS/Streamline 深度扫描
│   └── renderer/
│       ├── index.html               # 软件主界面布局
│       ├── enhanced-ui.js           # 三大增强模块前端交互控制器
│       └── enhanced-ui.css          # 增强控制中心样式表
├── payload/                         # 运行时组件载荷（构建时自动打入 extraResources）
├── scripts/
│   └── build-zh-cn-addon.ps1        # 使用 Zig 工具链编译 dlss5-zh-cn.addon64 的自动化脚本
└── test/                            # 314 项自动化回归与模块单元测试
```

---

## 八、开源许可与致谢 (License & Credits)

- 本项目源代码基于 **MIT License** 开源（继承自 [rakanki911/DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper)）。
- 第三方组件致谢与许可证详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：
  - **ReShade** (`BSD-3-Clause`)
  - **MFGAdaUnlock-RenoDx** (`MIT License`)
  - **OptiScaler** (`GPL-3.0`)
  - **NVIDIA NGX / DLSS / Streamline Runtime DLLs**：归 NVIDIA Corporation 所有，遵循 NVIDIA 相关运行时许可协议。
