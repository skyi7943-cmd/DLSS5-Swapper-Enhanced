# Skyi DLSS Enhanced

独立维护的社区配置工具，仓库：**skyi7943-cmd/DLSS5-Swapper-Enhanced**。源自 Rakan Alkhaldi 发布的 MIT 版 DLSS 5 Swapper v2.2.9，保留游戏扫描、配置与备份还原代码。本 fork 不由原作者或 NVIDIA 维护、赞助或担保，也不接收原作者的程序更新或默认连接其社区服务。

## 支持范围与状态含义

NVIDIA 官方目前将 DLSS 5 神经渲染及 Multi Frame Generation 列为 RTX 50 系列功能；RTX 40 的原生 Frame Generation x2 与社区 x3/x4 实验必须区分。[NVIDIA 功能与兼容性](https://www.nvidia.com/en-us/geforce/technologies/dlss/)、[DLSS 5 技术说明](https://research.nvidia.com/labs/adlr/DLSS5/)。RTX 4070 Laptop 上的 NR、MFG x3/x4 属于非官方实验，不能由 DLL 名称、CUDA SM 列表或菜单选项证明已运行。

- **已配置**：文件和配置已写入，不等于游戏接受了请求。
- **实验性支持 / 尚未测试**：静态架构匹配、组件存在或缺少当前会话证据。
- **已验证可用（MFG）**：当前进程 PID、启动时间、可执行目录、近期心跳、当前请求倍率、applied、GetState 成功及呈现帧证据均匹配。只代表遥测确认；不代表独立 FPS 测量或长期稳定。
- **不兼容**：发现明确的架构或组件冲突。GPU 检测失败显示未知，不会冒充 RTX 4070 Laptop。

无法识别或缺少会话标识的旧版插件日志仅用于排错。当前验证器不把 ReShade 文本补丁日志拼接成成功证据。切换倍率、关闭功能、过期文件、applied=false、零呈现帧或未知 GPU 均不能升级为“已验证”。

## RTX 4070 Laptop 8GB：1080p / 165Hz 稳健起点

这是建议目标，并非检测到的显示器参数或达到 165 FPS 的保证。先用 NR Off、FG Off 测真实渲染帧时间，再单独测试游戏原生 FG x2；NR 若要尝试，从单通道开始，逐项调整。x3/x4 需用户主动选择并分别验证。UI 初始选择 Off，不自动安装实验模式。

在游戏与显示器已经启用 VRR 的情况下，可考虑通过游戏设置将最终输出限制在约 162 FPS；工具不修改驱动、功率、显示器或游戏帧率限制。观察基础渲染 FPS、1% low、帧时间、输入延迟、显存峰值和画面伪影。8GB 下先降低贴图/光追负载，给场景波动留余量；增加插帧倍率不能修复基础帧率不足。

显存面板为**未经当前游戏校准的估算**：沿用固定的 5400 MiB 游戏基线与每模式开销假设，可能严重高估或低估，不是防溢出机制。GPU 总量未知时不计算占比或余量，非 1080p 情况标为未建模。nvidia-smi 的使用量是整块 GPU 的快照，也不等于该游戏的峰值。多 GPU 机器展示首个 NVIDIA 适配器，不声称它就是游戏所用 GPU。

## 已有游戏记录与性能证据

用户报告 HITMAN 3 / HITMAN World of Assassination 在其 RTX 4070 Laptop 上运行良好。下图保留为用户提供的运行记录，不能单凭截图认定 x3/x4 实际倍率、基础 FPS、持续稳定性或全部组件的官方支持：

![HITMAN 3 用户截图](docs/screenshots/ingame-hitman3-scene.jpg)

原 README 的 150–164、240–283+ FPS、6.07 GB 等属于用户报告，缺少可复现的同场景 A/B 捕获、PresentMon 原始数据和会话对应关系，本次审查没有复测。NR 的 8.1–14.3 ms 计时也不能直接换算为整条渲染管线的 FPS。

仓库公开的 **007 First Light** x4 快照（与 HITMAN 3 不是同一游戏/会话）显示：

| 字段 | 公开 x4 文件 |
| --- | --- |
| applied | false |
| appliedMultiplier | 0 |
| actualFramesPresented | 0 |
| activeFrameGeneration | none |
| ngxEvaluateCalls | 2667 |

见 [原始快照](test-results/real-game/mode_x4/RTXMFG-Universal.status.json)。它没有证明 x4 已应用；NGX 调用数不代表插帧倍率或显示 FPS。这不否定用户在另一游戏的体验，但不能支撑普遍成功的宣传。

[A～F 历史报告](test-results/modes-a-to-f-verification.md)中的 FPS、延迟和 1% low 是参考/示例数字，**不是本仓库可复现实测**。模拟程序及合成日志只能验证配置、解析和还原逻辑，不能测游戏性能。本次审查的测试结果见 PR 与 [审计记录](docs/COMMUNITY_AUDIT.md)。

## 获取运行时与本机导入

新构建默认只分发管理程序，不包含 NVIDIA NGX DLL/模型、Streamline、ReShade、Feeder、RenoDX、MFG 插件或旧便携包。功能需用户提供相应组件；缺失时显示未就绪。这会比历史的全载荷 EXE 少一些开箱即用能力。

1. 从 [NVIDIA DLSS SDK](https://github.com/NVIDIA/DLSS)、[NVIDIA Streamline](https://github.com/NVIDIA-RTX/Streamline)、[ReShade](https://reshade.me/) 及所用插件的官方项目页面获取组件，阅读对应版本的条款。下载入口不代表本 fork 已获得再分发或修改授权。
2. NR 可使用增强面板的“手动导入”。结构/哈希检查只用于文件识别，不证明合法来源、授权或 Authenticode 信任。修改版 sm_89 NR 模型在取得具体来源和授权证明前不随发行包提供。
3. 完整组件文件夹可在本机私有目录按以下布局自行整理，保留每个组件的许可证。不要上传该文件夹：

```text
private-payload/
  streamline/                  # 用户提供的 nvngx_* 与所需 sl.* 文件
  renodx-dlss5.addon64          # 仅当对应路由需要且获准使用
  reshade-vulkan/              # 对应位数的 ReShade 文件（路由需要时）
  ReShade_Setup_*_Addon.exe    # 路由需要时，由用户获取
  feeder/                     # Feeder 路由所需的匹配版本与许可证
  enhanced/mfg/               # 用户选用的插件与 licenses/
  enhanced/streamline-2.14.16/ # 仅当用户明确选择该历史栈时
```

运行应用前设置 `DLSS5_ENHANCED_PAYLOAD_DIR` 为该私有目录的绝对路径。也可放在独立应用的 userData/payload 内。可选本地拷贝工具：

```powershell
npm run payload -- 'C:\my-components' 'C:\my-private-payload'
$env:DLSS5_ENHANCED_PAYLOAD_DIR = 'C:\my-private-payload'
npm start
```

该工具要求目标是不存在的目录且位于仓库之外，不下载文件、不改名、不搜桌面/下载目录，也不会把导入结果打入 EXE。导入和自己使用仍须满足原条款；自行导入不能化解技术限制绕过或修改条款的问题。

## 开发与构建

```powershell
npm ci
npm test
npm run build:portable
```

所有构建入口执行发布输入检查，发布模式禁用自动上传；便携 EXE 具有独立产品名、appId 和解包目录。CI 在 Windows 上跑测试和无载荷构建，不发布二进制。构建成功不等于签名验证、游戏注入成功或游戏 FPS 实测。

默认不检查程序在线更新；手动更新只前往[本仓库 Releases](https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced/releases)。旧作者社区服务默认禁用；管理员只有明确配置 `DLSS5_ENHANCED_COMMUNITY_API` 时才会连接自建服务，媒体仅允许同源，CSP 未开放自建远程图片域名。不要把旧服务密钥或用户数据自动迁移到此 fork。

## 许可、来源与历史发行包

[MIT LICENSE](LICENSE)保留 `Copyright (c) 2026 Rakan Alkhaldi` 及完整授权条款；本 fork 的维护者字段不取代原作者版权。原始来源：[rakanki911/DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper)。第三方组件不因本仓库使用 MIT 而自动变成 MIT，详见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

独立品牌与服务能减少混淆和更新耦合，不能保证无人投诉或平台不会下架。上游后来闭源收费并不代替对已发布 MIT 版本、来源证据及第三方许可的核查。应保存取得 MIT 源码时的版本和许可证证据，逐项处理有效投诉，不能靠移除版权规避。

本 PR 不删除历史 Release 或改写 Git 历史。旧便携 EXE 若包含来源/授权未核实的模型或 DLL，应在维护者完成逐文件许可核查前停止再分发；本次没有取得该 EXE，不能认证其内容、签名或许可。新构建的排除规则不追溯修复已发布文件。
