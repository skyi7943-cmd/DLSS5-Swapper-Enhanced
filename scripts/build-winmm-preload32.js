'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'src', 'native', 'dgv_preload32');
fs.mkdirSync(outDir, { recursive: true });

const sysWinmmPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'winmm.dll');
const buf = fs.readFileSync(sysWinmmPath);
const pe = buf.readUInt32LE(0x3c);
const expRva = buf.readUInt32LE(pe + 0x78);

function rvaToRaw(r) {
  const numSecs = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  for (let i = 0; i < numSecs; i++) {
    const sec = pe + 24 + optSize + i * 40;
    const va = buf.readUInt32LE(sec + 12);
    const rawSize = buf.readUInt32LE(sec + 16);
    const rawPtr = buf.readUInt32LE(sec + 20);
    if (r >= va && r < va + rawSize) return rawPtr + (r - va);
  }
  return r;
}

const expRaw = rvaToRaw(expRva);
const baseOrd = buf.readUInt32LE(expRaw + 16);
const numFuncs = buf.readUInt32LE(expRaw + 20);
const numNames = buf.readUInt32LE(expRaw + 24);
const addrNames = rvaToRaw(buf.readUInt32LE(expRaw + 32));
const addrOrds = rvaToRaw(buf.readUInt32LE(expRaw + 36));
const ordToName = new Map();

for (let i = 0; i < numNames; i++) {
  const nameRva = buf.readUInt32LE(addrNames + i * 4);
  const ordIdx = buf.readUInt16LE(addrOrds + i * 2);
  const nameRaw = rvaToRaw(nameRva);
  const end = buf.indexOf(0, nameRaw);
  ordToName.set(baseOrd + ordIdx, buf.subarray(nameRaw, end).toString('ascii'));
}

const defLines = ['LIBRARY winmm', 'EXPORTS'];
const stubLines = [];

for (let ord = baseOrd; ord < baseOrd + numFuncs; ord++) {
  const name = ordToName.get(ord) || `winmm_ord_${ord}`;
  const idx = ord - baseOrd;
  if (name === 'timeGetTime') {
    defLines.push(`  timeGetTime = wrap_timeGetTime@0 @${ord}`);
  } else if (ordToName.has(ord)) {
    defLines.push(`  ${name} = stub_${ord} @${ord}`);
    stubLines.push(`__attribute__((naked)) void stub_${ord}(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[${idx}])); }`);
  } else {
    defLines.push(`  ${name} = stub_${ord} @${ord} NONAME`);
    stubLines.push(`__attribute__((naked)) void stub_${ord}(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[${idx}])); }`);
  }
}

const defPath = path.join(outDir, 'winmm.def');
fs.writeFileSync(defPath, defLines.join('\n') + '\n', 'utf8');

const cCode = `// Universal 32-bit dgVoodoo2 + ReShade Pre-Initializer Bridge (winmm.dll)
// Solves two universal legacy DirectX 8/9 engine issues:
// 1. Games that run DxDiag (dxdiagn.dll) at startup, which loads C:\\Windows\\System32\\dxgi.dll
//    by full path before dgVoodoo2 loads, preventing ReShade's local dxgi.dll from loading.
// 2. Games with modular renderer driver DLLs (e.g. e2driver\\e2_d3d8_driver_mfc.dll) that call
//    Direct3DCreate8 / Direct3DCreate9 inside DllMain(DLL_PROCESS_ATTACH) while holding the
//    Windows Loader Lock, causing DXGI CreateDXGIFactory1 (DXGI_ERROR_INVALID_CALL) and
//    D3D11CreateDevice worker-thread creation to fail or deadlock.

#include <windows.h>
#include <string.h>

#define BASE_ORD ${baseOrd}
#define NUM_FUNCS ${numFuncs}

FARPROC g_procs[NUM_FUNCS];
static HMODULE g_hSysWinmm = NULL;
static void* g_loader_lock = NULL;
static char g_game_dir[MAX_PATH] = {0};
static volatile LONG g_preload_state = 0;

typedef HMODULE (WINAPI *pfnLoadLibraryA)(LPCSTR);
typedef HMODULE (WINAPI *pfnLoadLibraryW)(LPCWSTR);
typedef HRESULT (WINAPI *pfnCoInitialize)(LPVOID);
typedef HRESULT (WINAPI *pfnCoInitializeEx)(LPVOID, DWORD);
typedef HRESULT (WINAPI *pfnCoCreateInstance)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID*);
typedef void* (__stdcall *pfnDirect3DCreate8)(UINT);
typedef void* (__stdcall *pfnDirect3DCreate9)(UINT);
typedef DWORD (WINAPI *pfnTimeGetTime)(void);

static pfnLoadLibraryA g_tramp_LoadLibraryA = NULL;
static pfnLoadLibraryW g_tramp_LoadLibraryW = NULL;
static pfnCoInitialize g_tramp_CoInitialize = NULL;
static pfnCoInitializeEx g_tramp_CoInitializeEx = NULL;
static pfnCoCreateInstance g_tramp_CoCreateInstance = NULL;
static pfnDirect3DCreate8 g_tramp_Direct3DCreate8 = NULL;
static pfnDirect3DCreate9 g_tramp_Direct3DCreate9 = NULL;
static pfnTimeGetTime g_orig_timeGetTime = NULL;

static void* g_precreated_d3d8 = NULL;
static void* g_precreated_d3d9 = NULL;

static int is_loader_lock_held(void) {
    if (!g_loader_lock) return 0;
    DWORD owning_tid = *(volatile DWORD*)((char*)g_loader_lock + 12);
    return owning_tid == GetCurrentThreadId() ? 1 : 0;
}

static void* install_hotpatch_hook(void* target, void* detour) {
    if (!target) return NULL;
    unsigned char* p = (unsigned char*)target;
    // Standard 5-byte Win32 prologue: 8B FF 55 8B EC (mov edi, edi; push ebp; mov ebp, esp)
    if (!(p[0] == 0x8B && p[1] == 0xFF && p[2] == 0x55 && p[3] == 0x8B && p[4] == 0xEC)) {
        return NULL;
    }
    unsigned char* tramp = (unsigned char*)VirtualAlloc(NULL, 16, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tramp) return NULL;
    memcpy(tramp, p, 5);
    tramp[5] = 0xE9;
    *(DWORD*)(tramp + 6) = (DWORD)(p + 5) - (DWORD)(tramp + 10);

    DWORD oldProt;
    if (VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &oldProt)) {
        p[0] = 0xE9;
        *(DWORD*)(p + 1) = (DWORD)detour - (DWORD)(p + 5);
        VirtualProtect(p, 5, oldProt, &oldProt);
        FlushInstructionCache(GetCurrentProcess(), p, 5);
    }
    return tramp;
}

static void* __stdcall hook_Direct3DCreate8(UINT sdkVer) {
    if (g_precreated_d3d8) {
        void** vtbl = *(void***)g_precreated_d3d8;
        typedef ULONG (__stdcall *pfnAddRef)(void*);
        ((pfnAddRef)vtbl[1])(g_precreated_d3d8);
        return g_precreated_d3d8;
    }
    return g_tramp_Direct3DCreate8 ? g_tramp_Direct3DCreate8(sdkVer) : NULL;
}

static void* __stdcall hook_Direct3DCreate9(UINT sdkVer) {
    if (g_precreated_d3d9 && is_loader_lock_held()) {
        void** vtbl = *(void***)g_precreated_d3d9;
        typedef ULONG (__stdcall *pfnAddRef)(void*);
        ((pfnAddRef)vtbl[1])(g_precreated_d3d9);
        return g_precreated_d3d9;
    }
    return g_tramp_Direct3DCreate9 ? g_tramp_Direct3DCreate9(sdkVer) : NULL;
}

static void ensure_d3d_preloaded(void) {
    if (g_preload_state != 0 || is_loader_lock_held()) return;
    if (InterlockedCompareExchange(&g_preload_state, 1, 0) != 0) return;

    pfnLoadLibraryA fnLoadA = g_tramp_LoadLibraryA ? g_tramp_LoadLibraryA : LoadLibraryA;

    char dxgi_path[MAX_PATH];
    wsprintfA(dxgi_path, "%s\\\\dxgi.dll", g_game_dir);
    if (GetFileAttributesA(dxgi_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(dxgi_path);
    }

    char d3d11_path[MAX_PATH];
    wsprintfA(d3d11_path, "%s\\\\d3d11.dll", g_game_dir);
    if (GetFileAttributesA(d3d11_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(d3d11_path);
    }

    char d3d8_path[MAX_PATH];
    wsprintfA(d3d8_path, "%s\\\\D3D8.dll", g_game_dir);
    if (GetFileAttributesA(d3d8_path) != INVALID_FILE_ATTRIBUTES) {
        HMODULE hD3D8 = fnLoadA(d3d8_path);
        if (hD3D8) {
            pfnDirect3DCreate8 fnCreate8 = (pfnDirect3DCreate8)GetProcAddress(hD3D8, "Direct3DCreate8");
            if (fnCreate8) {
                g_precreated_d3d8 = fnCreate8(220);
                if (g_precreated_d3d8) {
                    g_tramp_Direct3DCreate8 = (pfnDirect3DCreate8)install_hotpatch_hook((void*)fnCreate8, (void*)hook_Direct3DCreate8);
                }
            }
        }
    }

    char d3d9_path[MAX_PATH];
    wsprintfA(d3d9_path, "%s\\\\D3D9.dll", g_game_dir);
    if (GetFileAttributesA(d3d9_path) != INVALID_FILE_ATTRIBUTES) {
        HMODULE hD3D9 = fnLoadA(d3d9_path);
        if (hD3D9) {
            pfnDirect3DCreate9 fnCreate9 = (pfnDirect3DCreate9)GetProcAddress(hD3D9, "Direct3DCreate9");
            if (fnCreate9) {
                g_precreated_d3d9 = fnCreate9(32);
                if (g_precreated_d3d9) {
                    g_tramp_Direct3DCreate9 = (pfnDirect3DCreate9)install_hotpatch_hook((void*)fnCreate9, (void*)hook_Direct3DCreate9);
                }
            }
        }
    }

    g_preload_state = 2;
}

static HMODULE WINAPI hook_LoadLibraryA(LPCSTR lpLibFileName) {
    ensure_d3d_preloaded();
    return g_tramp_LoadLibraryA(lpLibFileName);
}

static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR lpLibFileName) {
    ensure_d3d_preloaded();
    return g_tramp_LoadLibraryW(lpLibFileName);
}

static HRESULT WINAPI hook_CoInitialize(LPVOID pvReserved) {
    ensure_d3d_preloaded();
    return g_tramp_CoInitialize(pvReserved);
}

static HRESULT WINAPI hook_CoInitializeEx(LPVOID pvReserved, DWORD dwCoInit) {
    ensure_d3d_preloaded();
    return g_tramp_CoInitializeEx(pvReserved, dwCoInit);
}

static HRESULT WINAPI hook_CoCreateInstance(REFCLSID rclsid, LPUNKNOWN pUnkOuter, DWORD dwClsContext, REFIID riid, LPVOID* ppv) {
    ensure_d3d_preloaded();
    return g_tramp_CoCreateInstance(rclsid, pUnkOuter, dwClsContext, riid, ppv);
}

DWORD WINAPI wrap_timeGetTime(void) {
    ensure_d3d_preloaded();
    return g_orig_timeGetTime ? g_orig_timeGetTime() : GetTickCount();
}

${stubLines.join('\n')}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        void* peb = (void*)__readfsdword(0x30);
        if (peb) {
            g_loader_lock = *(void**)((char*)peb + 0xA0);
        }
        GetModuleFileNameA(NULL, g_game_dir, MAX_PATH);
        char* last_slash = strrchr(g_game_dir, '\\\\');
        if (last_slash) *last_slash = 0;

        char sys_dir[MAX_PATH];
        GetSystemDirectoryA(sys_dir, MAX_PATH);
        char winmm_path[MAX_PATH];
        wsprintfA(winmm_path, "%s\\\\winmm.dll", sys_dir);
        g_hSysWinmm = LoadLibraryA(winmm_path);
        if (g_hSysWinmm) {
            for (int i = 0; i < NUM_FUNCS; i++) {
                g_procs[i] = GetProcAddress(g_hSysWinmm, MAKEINTRESOURCEA(BASE_ORD + i));
            }
            g_orig_timeGetTime = (pfnTimeGetTime)GetProcAddress(g_hSysWinmm, "timeGetTime");
        }

        HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
        if (hKernel32) {
            g_tramp_LoadLibraryA = (pfnLoadLibraryA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "LoadLibraryA"), (void*)hook_LoadLibraryA);
            g_tramp_LoadLibraryW = (pfnLoadLibraryW)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "LoadLibraryW"), (void*)hook_LoadLibraryW);
        }

        HMODULE hOle32 = GetModuleHandleA("ole32.dll");
        if (hOle32) {
            g_tramp_CoInitialize = (pfnCoInitialize)install_hotpatch_hook(
                (void*)GetProcAddress(hOle32, "CoInitialize"), (void*)hook_CoInitialize);
            g_tramp_CoInitializeEx = (pfnCoInitializeEx)install_hotpatch_hook(
                (void*)GetProcAddress(hOle32, "CoInitializeEx"), (void*)hook_CoInitializeEx);
            g_tramp_CoCreateInstance = (pfnCoCreateInstance)install_hotpatch_hook(
                (void*)GetProcAddress(hOle32, "CoCreateInstance"), (void*)hook_CoCreateInstance);
        }
    }
    return TRUE;
}
`;

const cPath = path.join(outDir, 'winmm_preload.c');
fs.writeFileSync(cPath, cCode, 'utf8');

const zigExe = path.join(rootDir, 'tools', 'zig-x86_64-windows-0.14.1', 'zig.exe');
const outDll = path.join(rootDir, 'payload', 'enhanced', 'zh-cn', 'winmm.dll');
fs.mkdirSync(path.dirname(outDll), { recursive: true });

execFileSync(zigExe, [
  'cc',
  '-target', 'x86-windows-gnu',
  '-shared',
  '-O2',
  cPath,
  defPath,
  '-o', outDll
], { stdio: 'inherit' });

console.log('Built:', outDll, fs.statSync(outDll).size, 'bytes');
