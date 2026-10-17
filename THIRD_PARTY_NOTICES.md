# Third-party notices

## Source attribution and distribution scope

Skyi DLSS Enhanced is an independent community fork of the MIT release of
rakanki911/DLSS5-Swapper v2.2.9, originally Copyright (c) 2026 Rakan Alkhaldi.
The original copyright and full grant remain in LICENSE, which is also packaged.
Source: https://github.com/rakanki911/DLSS5-Swapper
Fork maintenance: https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced

New community builds do not bundle game runtimes, models or plug-ins. Electron
and npm dependencies retain their own licenses (Electron packaging retains its
LICENSE and LICENSES.chromium.html). This notice does not license NVIDIA files.
Historical bundled-version claims below have been replaced with the current
source-only distribution policy; old EXEs need a separate artifact audit.

## NVIDIA DLSS / NGX and neural rendering models

Official terms: https://github.com/NVIDIA/DLSS/blob/main/LICENSE.txt
Official downloads: https://github.com/NVIDIA/DLSS

The RTX SDK license conditionally permits application redistribution; it is
not a blanket permission to mirror standalone DLLs or modified neural models.
Sections 1(c), 2 and 4 govern distribution, retention of notices, modification,
technical limitations and endorsement. Applicable supplements also matter.
Read the license accompanying the exact downloaded version.

No provenance or specific redistribution permission was supplied for the
historical nvngx_dlssnr.dll sm_89 / 310.8.SF-v2 model. Its PDB strings, CUDA
fatbin contents, hash or alleged signature do not establish those permissions.
It and nvngx_dlss.dll / nvngx_dlssg.dll are excluded from new releases pending
version-specific license and provenance evidence. User import is for files the
user is entitled to use, not permission to modify, bypass restrictions or share.

## Streamline

Source and release terms: https://github.com/NVIDIA-RTX/Streamline
Audit the LICENSE and per-component notices of the exact release. Do not assume
all sl.* binaries and their bundled NVIDIA dependencies are MIT merely because
some Streamline source files are MIT. No Streamline binaries are bundled here.
The claimed historical 2.14.16 package was not available in this checkout for
artifact-level verification.

## Optional independently licensed components

| Component | Source / license review point | Current delivery |
| --- | --- | --- |
| ReShade | https://github.com/crosire/reshade (BSD-3-Clause source; inspect actual release notices) | User supplied |
| RenoDX consumers | https://github.com/clshortfuse/renodx and the precise release/source revision | User supplied; no binary grant inferred from a mirror |
| DLSS5-Feeder | https://github.com/jlrouzies-fr/DLSS5-Feeder (upstream MIT; retain complete notice with each version) | User supplied |
| MFGAdaUnlock-RenoDx | https://github.com/mavismmg/MFGAdaUnlock-RenoDx (historical metadata says MIT; review exact source/release) | User supplied; NVIDIA rights remain separate |
| MFG-Unlocker | https://github.com/dashdogy/MFG-Unlocker (historical metadata says MIT; review exact source/release) | User supplied; NVIDIA rights remain separate |
| OptiScaler DLSS-NR | https://github.com/Dagherbou/OptiScaler_DLSSNR/tree/393e070 (GPL-3.0) | Optional upstream download; independent code, preserve source/license notices |
| OptiScaler pre-SR fork | https://github.com/jlrouzies-fr/OptiScaler-DLSSNR-PreSR-Multipass/tree/v0.8.92 | Optional upstream download; GPL and included PeripheralWarp/FidelityFX/XeSS notices retained |
| dgVoodoo2 | https://github.com/dege-diosg/dgVoodoo2 and https://dege.freeweb.hu/dgVoodoo2/ReadmeGeneral/ | Optional full upstream archive; separately licensed; never bundled |
| VORT shaders | https://github.com/vortigern11/vort_Shaders | User supplied with matching license |

The optional downloaders retain their existing checksum and license handling;
this review does not certify every file within an upstream archive. A future
bundled release needs an inventory of each binary, origin, hash, applicable
terms, required notices and source obligations. No unreviewed executable may be
added to the packaged src/assets inputs or extraResources. Existing releases
and their embedded ASAR/resources were not supplied and are not certified.

## DLSS5-Autopilot

The emulator profile table and parts of the Vulkan/Feeder installation model
were adapted from DLSS5-Autopilot:
https://github.com/Kizzuwatnaa/DLSS5-Autopilot

MIT License

Copyright (c) 2026 DLSS 5 Autopilot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

DLSS5-Autopilot downloads third-party components at runtime. Those components
remain under their own licences.

