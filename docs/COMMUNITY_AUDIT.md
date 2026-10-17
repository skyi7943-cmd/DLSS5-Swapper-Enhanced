# Community fork audit — 2026-10-18

Scope: source at `fbe5d03a38c1582b4a475db8e851b087b4f3ac08`, plus this PR. This is a code, packaging and evidence review, not certification of game performance or an assurance against takedowns. Execution was on the available Windows desktop runner. No callable ChatGPT Work cloud terminal was exposed; a Windows GitHub Actions workflow is included for cloud validation.

## Findings and changes

| Priority | Finding | Change |
| --- | --- | --- |
| High | nvidia-smi failure fabricated RTX 4070 Laptop, driver, 8GB capacity and display values | Unknown/null on failure or invalid data, error/source/time recorded; 5-second hardware cache; all reported adapters exposed; first adapter is not assumed to be the game adapter |
| High | x2 static component presence and partial x3/x4 log fields could produce verified badges | Current-session JSON snapshot, freshness, process birth/PID/executable directory, applied state, accepted options, successful GetState, exact selected multiplier and presentation evidence required; no positive-field merging across files; unknown GPU cannot verify; text-only logs remain diagnostic |
| High | Runtime `effectiveMultiplier` text could say verified even when the overall verifier rejected evidence | Verified multiplier only exposed after complete checks; Off, mismatches, errors, no frames, dead/stale/unknown sessions fail closed |
| High | Binary identity/SM kernels and fixed VRAM estimates were presented as successful game validation | NR SM matches are experimental static evidence; VRAM is explicitly uncalibrated; unknown capacity has no percentage/headroom; over-budget percentages are not clamped to 100%; non-1080p is unmodeled; quality and Reflex remain untested |
| High | Build searched private desktop/download locations, copied arbitrary runtimes and optional add-ons, including an NR model with unproven provenance | Replaced automatic collector with explicit private local import outside repo; removed extraResources; beforePack source gate and afterPack ASAR/resource checks; all build commands prohibit publishing |
| Medium | Original author/appId/product/service/update/donation identity persisted | Independent Skyi DLSS Enhanced name, appId `io.github.skyi7943cmd.dlssenhanced`, maintainer, icons, repository links, portable directory; manual fork updates only; inherited community disabled by default; no old funding link |
| Medium | MFG-only action could implicitly install NR; hidden developer path could copy an unselected localization add-on | Removed implicit NR activation and untracked automatic localization deployment; explicit per-module control retained |
| Medium | Missing-payload message blamed antivirus and advised exclusions/deleting extraction folders | Explains intentional source-only delivery and private import instead |

No display, driver, power or frame limiter setting is forced. The 1080p/165Hz profile is a conservative suggestion (NR Off, native FG x2 first, single-pass NR separately; 162 FPS cap only when VRR is already active). It is not a benchmark or a guaranteed stable preset. Existing transactional backups/restoration remain in place.

## Evidence corrections

HITMAN 3 screenshots and user-reported 150–164 / 240–283+ FPS are preserved as user reports without a reproducible A/B trace. They do not establish x3/x4 ratios, base render rate, 1% low, latency or all-game stability.

The separate public 007 First Light x4 snapshot has `applied=false`, `appliedMultiplier=0`, `actualFramesPresented=0`, `activeFrameGeneration=none`, `ngxEvaluateCalls=2667`. This is not proof of x4 application. A regression test uses that exact fixture and also makes it fresh to ensure the negative state still wins.

A–F FPS, 1% low and latency values were reference numbers; the historical JSON and Markdown now carry a superseding correction. The described `scripts/verify-modes-a-to-f.js` is absent from this checkout. Hardware also conflicts across those artifacts (i7-13650HX/165Hz vs i7-13700HX/144Hz). No synthetic harness or counter extrapolation is reported as actual gameplay performance.

## License and prior portable EXE audit boundary

Original MIT LICENSE and Rakan Alkhaldi copyright remain unchanged and are included in the application archive. Historical upstream source attribution remains in README, notices and the source-attribution link. Renaming the maintainer is not removal or transfer of that copyright. Later upstream monetization does not establish that these particular sources or all bundled assets were authorized; retain evidence of the original MIT version and investigate specific rights claims.

Checked primary NVIDIA terms: [RTX SDK license](https://github.com/NVIDIA/DLSS/blob/main/LICENSE.txt), distribution sections 1(c)/2 and restrictions 4; exact component/version terms and supplements must also be reviewed. Conditional SDK redistribution is not a blanket standalone-binary or modified-model license. Source MIT notices for an injector or Streamline component do not relicense NVIDIA NGX binaries. User import does not authorize bypassing technical restrictions or modification forbidden by original terms.

This checkout tracks no `.exe`, `.dll`, `.asi`, `.addon64` or model/archive runtime payload. The historical 286,873,616-byte portable EXE and its baseline backup were not provided. Its embedded NVIDIA files, Authenticode signature and redistribution rights therefore remain **unverified**. Existing release assets were not deleted or rewritten; the maintainer should stop redistributing any unreviewed package until a per-file origin/hash/license/notice/authorization inventory is available. This PR cannot repair an already-distributed EXE retroactively.

New builds omit NVIDIA runtimes/models, Streamline, ReShade, Feeder, RenoDX and MFG plug-ins. Official external sources and user-owned local import layout are documented. Missing components disable the relevant routes rather than being secretly supplied by a release packager. Optional upstream component downloaders retain their own licenses and source obligations; this review does not certify every file in every external archive.

## Validation

- Node test suite: **325 tests, 319 passed, 6 skipped, 0 failed** after the fork changes; final run recorded in the PR if a later run differs.
- Four skipped integration tests require an explicitly supplied private payload (`DLSS5_ENHANCED_TEST_PAYLOAD`); two pre-existing platform/runtime skips remain. They were not counted as successful runtime or game tests.
- New synthetic regression tests exercise CSV failure/N/A/zero/multi-GPU parsing, unknown capacity, model static evidence, actual panel rendering, current/negative/stale/mismatched/off/dead runtime snapshots, exact 007 fixture, disabled network, packaging exclusion and explicit import. Existing installation/restore tests still run with inert fixtures.
- Windows portable build succeeds locally without third-party game payload. Original MIT copyright and third-party notices were inspected inside `resources/app.asar`; no game DLL/model/add-on/archive entries or payload/addons/overlay resource directories were found. Electron's own DLLs and electron-builder's elevate helper are application infrastructure, not game runtime payload.
- The built EXE is **unsigned** (`Get-AuthenticodeSignature: NotSigned`); builder log messages about signing are not proof of a valid signing certificate. No public binary release is uploaded by this PR.
- Actual game FPS, input latency, VRR behavior, GPU adapter binding, thermal/power behavior and long-session stability were not exercised. No game or anti-cheat process was launched or modified for this review.

For session binding the runtime verifier requires Windows process access. If process start time/path cannot be read (for example, elevated game vs unelevated app), it deliberately stays unverified. Older/text-only telemetry schemas likewise remain unverified until a schema-specific, session-bound adapter can be tested. JSON telemetry is locally generated evidence, not an independent anti-tamper or PresentMon capture.
