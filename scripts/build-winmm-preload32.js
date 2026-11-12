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

const cCode = `// Universal 32-bit Legacy Game Compatibility & Pre-Initializer Bridge (winmm.dll)
// Automatically solves universal Windows 10/11 32-bit legacy game issues:
// 1. CPU >8-core spinlock / worker bitmask overflow (e.g. Prototype on 16/24/32-thread CPUs).
// 2. Win9x/Win2000 GlobalMemoryStatus >2GB cap causing 0-byte swapfile errors (e.g. Task Force Dagger).
// 3. Zero-UAC HKLM\\SOFTWARE\\<Vendor> -> HKCU\\Software\\DLSS5Swapper\\VirtualHKLM\\<Vendor> fallback
//    for Steam installscript.vdf keys and Win9x KEY_ALL_ACCESS registry writes (e.g. Delta Force: Xtreme).
// 4. DxDiag early System32\\dxgi.dll poisoning & Loader-Lock Direct3DCreate8/9 deadlock prevention (e.g. Max Payne 2).
// 5. GoldSrc / SDL2 32-bit OpenGL local opengl32.dll deletion & full-path System32\\opengl32.dll bypass
//    via ReShade32.dll hook + automatic standalone GoldSrc mod (-game cstrike) fallback.

#include <windows.h>
#include <string.h>

#define BASE_ORD ${baseOrd}
#define NUM_FUNCS ${numFuncs}

FARPROC g_procs[NUM_FUNCS];
static HMODULE g_hSysWinmm = NULL;
static void* g_loader_lock = NULL;
static char g_game_dir[MAX_PATH] = {0};
static volatile LONG g_preload_state = 0;
static volatile LONG g_advapi_hooked = 0;
static DWORD_PTR g_clamped_affinity_mask = 0;
static char g_patched_cmdline[2048] = {0};

typedef HMODULE (WINAPI *pfnLoadLibraryA)(LPCSTR);
typedef HMODULE (WINAPI *pfnLoadLibraryW)(LPCWSTR);
typedef HMODULE (WINAPI *pfnLoadLibraryExA)(LPCSTR, HANDLE, DWORD);
typedef HMODULE (WINAPI *pfnLoadLibraryExW)(LPCWSTR, HANDLE, DWORD);
typedef HWND (WINAPI *pfnCreateWindowExA)(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef HWND (WINAPI *pfnCreateWindowExW)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef void (WINAPI *pfnGlobalMemoryStatus)(LPMEMORYSTATUS);
typedef void (WINAPI *pfnGetSystemInfo)(LPSYSTEM_INFO);
typedef LPSTR (WINAPI *pfnGetCommandLineA)(void);
typedef LONG (NTAPI *pfnNtQueryKey)(HANDLE, int, PVOID, ULONG, PULONG);
typedef LONG (APIENTRY *pfnRegOpenKeyExA)(HKEY, LPCSTR, DWORD, REGSAM, PHKEY);
typedef LONG (APIENTRY *pfnRegOpenKeyExW)(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY);
typedef LONG (APIENTRY *pfnRegOpenKeyA)(HKEY, LPCSTR, PHKEY);
typedef LONG (APIENTRY *pfnRegOpenKeyW)(HKEY, LPCWSTR, PHKEY);
typedef LONG (APIENTRY *pfnRegCreateKeyExA)(HKEY, LPCSTR, DWORD, LPSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
typedef LONG (APIENTRY *pfnRegCreateKeyExW)(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
typedef LONG (APIENTRY *pfnRegCreateKeyA)(HKEY, LPCSTR, PHKEY);
typedef LONG (APIENTRY *pfnRegCreateKeyW)(HKEY, LPCWSTR, PHKEY);
typedef HRESULT (WINAPI *pfnCoInitialize)(LPVOID);
typedef HRESULT (WINAPI *pfnCoInitializeEx)(LPVOID, DWORD);
typedef HRESULT (WINAPI *pfnCoCreateInstance)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID*);
typedef void* (__stdcall *pfnDirect3DCreate8)(UINT);
typedef void* (__stdcall *pfnDirect3DCreate9)(UINT);
typedef DWORD (WINAPI *pfnTimeGetTime)(void);

static pfnLoadLibraryA g_tramp_LoadLibraryA = NULL;
static pfnLoadLibraryW g_tramp_LoadLibraryW = NULL;
static pfnLoadLibraryExA g_tramp_LoadLibraryExA = NULL;
static pfnLoadLibraryExW g_tramp_LoadLibraryExW = NULL;
static pfnCreateWindowExA g_tramp_CreateWindowExA = NULL;
static pfnCreateWindowExW g_tramp_CreateWindowExW = NULL;
static pfnGlobalMemoryStatus g_tramp_GlobalMemoryStatus = NULL;
static pfnGetSystemInfo g_tramp_GetSystemInfo = NULL;
static pfnGetSystemInfo g_tramp_GetNativeSystemInfo = NULL;
static pfnGetCommandLineA g_tramp_GetCommandLineA = NULL;
static pfnNtQueryKey g_fnNtQueryKey = NULL;

static pfnRegOpenKeyExA g_tramp_kb_RegOpenKeyExA = NULL;
static pfnRegOpenKeyExW g_tramp_kb_RegOpenKeyExW = NULL;
static pfnRegCreateKeyExA g_tramp_kb_RegCreateKeyExA = NULL;
static pfnRegCreateKeyExW g_tramp_kb_RegCreateKeyExW = NULL;

static pfnRegOpenKeyExA g_tramp_adv_RegOpenKeyExA = NULL;
static pfnRegOpenKeyExW g_tramp_adv_RegOpenKeyExW = NULL;
static pfnRegOpenKeyA g_tramp_adv_RegOpenKeyA = NULL;
static pfnRegOpenKeyW g_tramp_adv_RegOpenKeyW = NULL;
static pfnRegCreateKeyExA g_tramp_adv_RegCreateKeyExA = NULL;
static pfnRegCreateKeyExW g_tramp_adv_RegCreateKeyExW = NULL;
static pfnRegCreateKeyA g_tramp_adv_RegCreateKeyA = NULL;
static pfnRegCreateKeyW g_tramp_adv_RegCreateKeyW = NULL;
static pfnCoInitialize g_tramp_CoInitialize = NULL;
static pfnCoInitializeEx g_tramp_CoInitializeEx = NULL;
static pfnCoCreateInstance g_tramp_CoCreateInstance = NULL;
static pfnDirect3DCreate8 g_tramp_Direct3DCreate8 = NULL;
static pfnDirect3DCreate9 g_tramp_Direct3DCreate9 = NULL;
static pfnTimeGetTime g_orig_timeGetTime = NULL;

static void* g_precreated_d3d8 = NULL;
static void* g_precreated_d3d9 = NULL;

static int ascii_tolower(int c) {
    return (c >= 'A' && c <= 'Z') ? (c + ('a' - 'A')) : c;
}

static int str_istarts_with_a(const char* s, const char* prefix) {
    while (*prefix) {
        char a = *s++;
        char b = *prefix++;
        if (a == '/') a = '\\\\';
        if (b == '/') b = '\\\\';
        if (ascii_tolower((unsigned char)a) != ascii_tolower((unsigned char)b)) return 0;
    }
    return 1;
}

static int str_istarts_with_w(const WCHAR* s, const char* prefix) {
    while (*prefix) {
        WCHAR a = *s++;
        WCHAR b = (unsigned char)*prefix++;
        if (a == L'/') a = L'\\\\';
        if (b == L'/') b = L'\\\\';
        if (ascii_tolower((int)a) != ascii_tolower((int)b)) return 0;
    }
    return 1;
}

static int str_icontains_a(const char* hay, const char* needle) {
    if (!hay || !needle || !*needle) return 0;
    size_t nlen = strlen(needle);
    for (const char* p = hay; *p; p++) {
        size_t i = 0;
        while (i < nlen && p[i] && ascii_tolower((unsigned char)p[i]) == ascii_tolower((unsigned char)needle[i])) i++;
        if (i == nlen) return 1;
    }
    return 0;
}

static int is_loader_lock_held(void) {
    if (!g_loader_lock) return 0;
    DWORD owning_tid = *(volatile DWORD*)((char*)g_loader_lock + 12);
    return owning_tid == GetCurrentThreadId() ? 1 : 0;
}

static void* install_hotpatch_hook(void* target, void* detour) {
    if (!target) return NULL;
    unsigned char* p = (unsigned char*)target;
    // Follow FF 25 [iat32] import thunk (e.g. kernel32 -> KernelBase on Windows 11)
    if (p[0] == 0xFF && p[1] == 0x25) {
        unsigned char** iat = NULL;
        memcpy(&iat, p + 2, 4);
        if (iat && *iat) p = *iat;
    }
    // Case 1: Standard 5-byte Win32 prologue: 8B FF 55 8B EC (mov edi, edi; push ebp; mov ebp, esp)
    if (p[0] == 0x8B && p[1] == 0xFF && p[2] == 0x55 && p[3] == 0x8B && p[4] == 0xEC) {
        unsigned char* tramp = (unsigned char*)VirtualAlloc(NULL, 16, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!tramp) return NULL;
        memcpy(tramp, p, 5);
        tramp[5] = 0xE9;
        DWORD backRel = (DWORD)(p + 5) - (DWORD)(tramp + 10);
        memcpy(tramp + 6, &backRel, 4);

        DWORD oldProt;
        if (VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &oldProt)) {
            DWORD detRel = (DWORD)detour - (DWORD)(p + 5);
            p[0] = 0xE9;
            memcpy(p + 1, &detRel, 4);
            VirtualProtect(p, 5, oldProt, &oldProt);
            FlushInstructionCache(GetCurrentProcess(), p, 5);
        }
        return tramp;
    }
    // Case 2: 6-byte mov eax, [imm32]; ret prologue (A1 xx xx xx xx C3, e.g. GetCommandLineA)
    if (p[0] == 0xA1 && p[5] == 0xC3) {
        unsigned char* tramp = (unsigned char*)VirtualAlloc(NULL, 16, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!tramp) return NULL;
        memcpy(tramp, p, 6);

        DWORD oldProt;
        if (VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &oldProt)) {
            DWORD detRel = (DWORD)detour - (DWORD)(p + 5);
            p[0] = 0xE9;
            memcpy(p + 1, &detRel, 4);
            VirtualProtect(p, 5, oldProt, &oldProt);
            FlushInstructionCache(GetCurrentProcess(), p, 5);
        }
        return tramp;
    }
    return NULL;
}

static void WINAPI hook_GlobalMemoryStatus(LPMEMORYSTATUS lpBuffer) {
    if (g_tramp_GlobalMemoryStatus) g_tramp_GlobalMemoryStatus(lpBuffer);
    if (!lpBuffer) return;
    const SIZE_T phys512 = 512u * 1024u * 1024u;
    const SIZE_T page1024 = 1024u * 1024u * 1024u;
    if (lpBuffer->dwTotalPhys > phys512) lpBuffer->dwTotalPhys = phys512;
    if (lpBuffer->dwAvailPhys > phys512) lpBuffer->dwAvailPhys = phys512;
    lpBuffer->dwTotalPageFile = page1024;
    lpBuffer->dwAvailPageFile = page1024;
    if (lpBuffer->dwMemoryLoad > 50) lpBuffer->dwMemoryLoad = 25;
}

static void WINAPI hook_GetSystemInfo(LPSYSTEM_INFO lpSystemInfo) {
    if (g_tramp_GetSystemInfo) g_tramp_GetSystemInfo(lpSystemInfo);
    if (lpSystemInfo && g_clamped_affinity_mask != 0 && lpSystemInfo->dwNumberOfProcessors > 8) {
        lpSystemInfo->dwNumberOfProcessors = 8;
        lpSystemInfo->dwActiveProcessorMask = g_clamped_affinity_mask;
    }
}

static void WINAPI hook_GetNativeSystemInfo(LPSYSTEM_INFO lpSystemInfo) {
    if (g_tramp_GetNativeSystemInfo) g_tramp_GetNativeSystemInfo(lpSystemInfo);
    if (lpSystemInfo && g_clamped_affinity_mask != 0 && lpSystemInfo->dwNumberOfProcessors > 8) {
        lpSystemInfo->dwNumberOfProcessors = 8;
        lpSystemInfo->dwActiveProcessorMask = g_clamped_affinity_mask;
    }
}

static LPSTR WINAPI hook_GetCommandLineA(void) {
    if (g_patched_cmdline[0] != 0) return g_patched_cmdline;
    return g_tramp_GetCommandLineA ? g_tramp_GetCommandLineA() : "";
}

static int build_virtual_hklm_a(LPCSTR lpSubKey, char* outBuf, size_t cap) {
    if (!lpSubKey || !str_istarts_with_a(lpSubKey, "Software\\\\")) return 0;
    const char* rest = lpSubKey + 9;
    while (*rest == '\\\\' || *rest == '/') rest++;
    if (str_istarts_with_a(rest, "WOW6432Node\\\\")) {
        rest += 12;
        while (*rest == '\\\\' || *rest == '/') rest++;
    }
    if (!*rest) return 0;
    if (str_istarts_with_a(rest, "Microsoft\\\\") ||
        str_istarts_with_a(rest, "Classes\\\\") ||
        str_istarts_with_a(rest, "Policies\\\\") ||
        str_istarts_with_a(rest, "RegisteredApplications")) {
        return 0;
    }
    const char* prefix = "Software\\\\DLSS5Swapper\\\\VirtualHKLM\\\\";
    size_t plen = strlen(prefix);
    size_t rlen = strlen(rest);
    if (plen + rlen + 1 >= cap) return 0;
    memcpy(outBuf, prefix, plen);
    memcpy(outBuf + plen, rest, rlen + 1);
    return 1;
}

static int build_virtual_hklm_w(LPCWSTR lpSubKey, WCHAR* outBuf, size_t cap) {
    if (!lpSubKey || !str_istarts_with_w(lpSubKey, "Software\\\\")) return 0;
    const WCHAR* rest = lpSubKey + 9;
    while (*rest == L'\\\\' || *rest == L'/') rest++;
    if (str_istarts_with_w(rest, "WOW6432Node\\\\")) {
        rest += 12;
        while (*rest == L'\\\\' || *rest == L'/') rest++;
    }
    if (!*rest) return 0;
    if (str_istarts_with_w(rest, "Microsoft\\\\") ||
        str_istarts_with_w(rest, "Classes\\\\") ||
        str_istarts_with_w(rest, "Policies\\\\") ||
        str_istarts_with_w(rest, "RegisteredApplications")) {
        return 0;
    }
    const WCHAR prefix[] = L"Software\\\\DLSS5Swapper\\\\VirtualHKLM\\\\";
    size_t plen = (sizeof(prefix) / sizeof(WCHAR)) - 1;
    size_t rlen = 0;
    while (rest[rlen]) rlen++;
    if (plen + rlen + 1 >= cap) return 0;
    memcpy(outBuf, prefix, plen * sizeof(WCHAR));
    memcpy(outBuf + plen, rest, (rlen + 1) * sizeof(WCHAR));
    return 1;
}

static int resolve_hklm_subkey_a(HKEY hKey, LPCSTR lpSubKey, char* fullBuf, size_t cap) {
    if (hKey == HKEY_LOCAL_MACHINE) {
        if (!lpSubKey || !*lpSubKey) return 0;
        size_t len = strlen(lpSubKey);
        if (len + 1 >= cap) return 0;
        memcpy(fullBuf, lpSubKey, len + 1);
        return 1;
    }
    if (!hKey || (((ULONG_PTR)hKey & 0xF0000000u) == 0x80000000u) || !g_fnNtQueryKey) {
        return 0;
    }
    struct {
        ULONG NameLength;
        WCHAR Name[1024];
    } info;
    ULONG retLen = 0;
    if (g_fnNtQueryKey((HANDLE)hKey, 3, &info, sizeof(info) - sizeof(WCHAR), &retLen) != 0) {
        return 0;
    }
    ULONG wlen = info.NameLength / sizeof(WCHAR);
    if (wlen >= 1024) wlen = 1023;
    info.Name[wlen] = 0;
    if (!str_istarts_with_w(info.Name, "\\\\REGISTRY\\\\MACHINE\\\\")) {
        return 0;
    }
    const WCHAR* wrest = info.Name + 18;
    size_t pos = 0;
    while (*wrest && pos + 2 < cap) {
        WCHAR wc = *wrest++;
        fullBuf[pos++] = (wc < 0x80) ? (char)wc : '?';
    }
    if (lpSubKey && *lpSubKey) {
        if (pos > 0 && fullBuf[pos - 1] != '\\\\' && lpSubKey[0] != '\\\\') {
            if (pos + 1 >= cap) return 0;
            fullBuf[pos++] = '\\\\';
        }
        size_t slen = strlen(lpSubKey);
        if (pos + slen + 1 >= cap) return 0;
        memcpy(fullBuf + pos, lpSubKey, slen);
        pos += slen;
    }
    fullBuf[pos] = 0;
    return pos > 0 ? 1 : 0;
}

static int resolve_hklm_subkey_w(HKEY hKey, LPCWSTR lpSubKey, WCHAR* fullBuf, size_t cap) {
    if (hKey == HKEY_LOCAL_MACHINE) {
        if (!lpSubKey || !*lpSubKey) return 0;
        size_t len = 0;
        while (lpSubKey[len]) len++;
        if (len + 1 >= cap) return 0;
        memcpy(fullBuf, lpSubKey, (len + 1) * sizeof(WCHAR));
        return 1;
    }
    if (!hKey || (((ULONG_PTR)hKey & 0xF0000000u) == 0x80000000u) || !g_fnNtQueryKey) {
        return 0;
    }
    struct {
        ULONG NameLength;
        WCHAR Name[1024];
    } info;
    ULONG retLen = 0;
    if (g_fnNtQueryKey((HANDLE)hKey, 3, &info, sizeof(info) - sizeof(WCHAR), &retLen) != 0) {
        return 0;
    }
    ULONG wlen = info.NameLength / sizeof(WCHAR);
    if (wlen >= 1024) wlen = 1023;
    info.Name[wlen] = 0;
    if (!str_istarts_with_w(info.Name, "\\\\REGISTRY\\\\MACHINE\\\\")) {
        return 0;
    }
    const WCHAR* wrest = info.Name + 18;
    size_t pos = 0;
    while (*wrest && pos + 2 < cap) {
        fullBuf[pos++] = *wrest++;
    }
    if (lpSubKey && *lpSubKey) {
        if (pos > 0 && fullBuf[pos - 1] != L'\\\\' && lpSubKey[0] != L'\\\\') {
            if (pos + 1 >= cap) return 0;
            fullBuf[pos++] = L'\\\\';
        }
        size_t slen = 0;
        while (lpSubKey[slen]) slen++;
        if (pos + slen + 1 >= cap) return 0;
        memcpy(fullBuf + pos, lpSubKey, slen * sizeof(WCHAR));
        pos += slen;
    }
    fullBuf[pos] = 0;
    return pos > 0 ? 1 : 0;
}

static LONG fallback_open_virtual_a(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult, LONG origRc, pfnRegOpenKeyExA fnOpenExA) {
    char fullSubKey[512];
    char vpath[512];
    if (resolve_hklm_subkey_a(hKey, lpSubKey, fullSubKey, sizeof(fullSubKey)) &&
        build_virtual_hklm_a(fullSubKey, vpath, sizeof(vpath))) {
        REGSAM cleanSam = samDesired & ~(KEY_WOW64_64KEY | KEY_WOW64_32KEY);
        if (cleanSam == 0) cleanSam = KEY_READ;
        pfnRegOpenKeyExA directOpen = g_tramp_kb_RegOpenKeyExA ? g_tramp_kb_RegOpenKeyExA : fnOpenExA;
        if (directOpen && directOpen(HKEY_CURRENT_USER, vpath, 0, cleanSam, phkResult) == ERROR_SUCCESS) {
            return ERROR_SUCCESS;
        }
        if (origRc == ERROR_ACCESS_DENIED && fnOpenExA) {
            REGSAM roSam = KEY_READ | (samDesired & (KEY_WOW64_64KEY | KEY_WOW64_32KEY));
            if (fnOpenExA(hKey, lpSubKey, ulOptions, roSam, phkResult) == ERROR_SUCCESS) {
                return ERROR_SUCCESS;
            }
        }
    }
    return origRc;
}

static LONG fallback_open_virtual_w(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult, LONG origRc, pfnRegOpenKeyExW fnOpenExW) {
    WCHAR fullSubKey[512];
    WCHAR vpath[512];
    if (resolve_hklm_subkey_w(hKey, lpSubKey, fullSubKey, 512) &&
        build_virtual_hklm_w(fullSubKey, vpath, 512)) {
        REGSAM cleanSam = samDesired & ~(KEY_WOW64_64KEY | KEY_WOW64_32KEY);
        if (cleanSam == 0) cleanSam = KEY_READ;
        pfnRegOpenKeyExW directOpen = g_tramp_kb_RegOpenKeyExW ? g_tramp_kb_RegOpenKeyExW : fnOpenExW;
        if (directOpen && directOpen(HKEY_CURRENT_USER, vpath, 0, cleanSam, phkResult) == ERROR_SUCCESS) {
            return ERROR_SUCCESS;
        }
        if (origRc == ERROR_ACCESS_DENIED && fnOpenExW) {
            REGSAM roSam = KEY_READ | (samDesired & (KEY_WOW64_64KEY | KEY_WOW64_32KEY));
            if (fnOpenExW(hKey, lpSubKey, ulOptions, roSam, phkResult) == ERROR_SUCCESS) {
                return ERROR_SUCCESS;
            }
        }
    }
    return origRc;
}

static LONG fallback_create_virtual_a(HKEY hKey, LPCSTR lpSubKey, DWORD Reserved, LPSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp, LONG origRc, pfnRegCreateKeyExA fnCreateExA) {
    char fullSubKey[512];
    char vpath[512];
    if (resolve_hklm_subkey_a(hKey, lpSubKey, fullSubKey, sizeof(fullSubKey)) &&
        build_virtual_hklm_a(fullSubKey, vpath, sizeof(vpath))) {
        REGSAM cleanSam = samDesired & ~(KEY_WOW64_64KEY | KEY_WOW64_32KEY);
        if (cleanSam == 0) cleanSam = KEY_ALL_ACCESS;
        pfnRegCreateKeyExA directCreate = g_tramp_kb_RegCreateKeyExA ? g_tramp_kb_RegCreateKeyExA : fnCreateExA;
        if (directCreate && directCreate(HKEY_CURRENT_USER, vpath, Reserved, lpClass, dwOptions, cleanSam, lpSec, phkResult, lpdwDisp) == ERROR_SUCCESS) {
            return ERROR_SUCCESS;
        }
    }
    return origRc;
}

static LONG fallback_create_virtual_w(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp, LONG origRc, pfnRegCreateKeyExW fnCreateExW) {
    WCHAR fullSubKey[512];
    WCHAR vpath[512];
    if (resolve_hklm_subkey_w(hKey, lpSubKey, fullSubKey, 512) &&
        build_virtual_hklm_w(fullSubKey, vpath, 512)) {
        REGSAM cleanSam = samDesired & ~(KEY_WOW64_64KEY | KEY_WOW64_32KEY);
        if (cleanSam == 0) cleanSam = KEY_ALL_ACCESS;
        pfnRegCreateKeyExW directCreate = g_tramp_kb_RegCreateKeyExW ? g_tramp_kb_RegCreateKeyExW : fnCreateExW;
        if (directCreate && directCreate(HKEY_CURRENT_USER, vpath, Reserved, lpClass, dwOptions, cleanSam, lpSec, phkResult, lpdwDisp) == ERROR_SUCCESS) {
            return ERROR_SUCCESS;
        }
    }
    return origRc;
}

// KernelBase hooks
static LONG APIENTRY hook_kb_RegOpenKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult) {
    LONG rc = g_tramp_kb_RegOpenKeyExA(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_a(hKey, lpSubKey, ulOptions, samDesired, phkResult, rc, g_tramp_kb_RegOpenKeyExA) : rc;
}
static LONG APIENTRY hook_kb_RegOpenKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult) {
    LONG rc = g_tramp_kb_RegOpenKeyExW(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_w(hKey, lpSubKey, ulOptions, samDesired, phkResult, rc, g_tramp_kb_RegOpenKeyExW) : rc;
}
static LONG APIENTRY hook_kb_RegCreateKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD Reserved, LPSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp) {
    LONG rc = g_tramp_kb_RegCreateKeyExA(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_a(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp, rc, g_tramp_kb_RegCreateKeyExA) : rc;
}
static LONG APIENTRY hook_kb_RegCreateKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp) {
    LONG rc = g_tramp_kb_RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_w(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp, rc, g_tramp_kb_RegCreateKeyExW) : rc;
}

// advapi32 hooks (Windows 10/11 WOW64 advapi32 jumps directly to RegOpenKeyExInternal*, bypassing KernelBase!RegOpenKeyEx*)
static LONG APIENTRY hook_adv_RegOpenKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegOpenKeyExA(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_a(hKey, lpSubKey, ulOptions, samDesired, phkResult, rc, g_tramp_adv_RegOpenKeyExA) : rc;
}
static LONG APIENTRY hook_adv_RegOpenKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegOpenKeyExW(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_w(hKey, lpSubKey, ulOptions, samDesired, phkResult, rc, g_tramp_adv_RegOpenKeyExW) : rc;
}
static LONG APIENTRY hook_adv_RegOpenKeyA(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegOpenKeyA(hKey, lpSubKey, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_a(hKey, lpSubKey, 0, KEY_READ, phkResult, rc, g_tramp_adv_RegOpenKeyExA) : rc;
}
static LONG APIENTRY hook_adv_RegOpenKeyW(HKEY hKey, LPCWSTR lpSubKey, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegOpenKeyW(hKey, lpSubKey, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_open_virtual_w(hKey, lpSubKey, 0, KEY_READ, phkResult, rc, g_tramp_adv_RegOpenKeyExW) : rc;
}
static LONG APIENTRY hook_adv_RegCreateKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD Reserved, LPSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp) {
    LONG rc = g_tramp_adv_RegCreateKeyExA(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_a(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp, rc, g_tramp_adv_RegCreateKeyExA) : rc;
}
static LONG APIENTRY hook_adv_RegCreateKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions, REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSec, PHKEY phkResult, LPDWORD lpdwDisp) {
    LONG rc = g_tramp_adv_RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_w(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSec, phkResult, lpdwDisp, rc, g_tramp_adv_RegCreateKeyExW) : rc;
}
static LONG APIENTRY hook_adv_RegCreateKeyA(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegCreateKeyA(hKey, lpSubKey, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_a(hKey, lpSubKey, 0, NULL, 0, KEY_ALL_ACCESS, NULL, phkResult, NULL, rc, g_tramp_adv_RegCreateKeyExA) : rc;
}
static LONG APIENTRY hook_adv_RegCreateKeyW(HKEY hKey, LPCWSTR lpSubKey, PHKEY phkResult) {
    LONG rc = g_tramp_adv_RegCreateKeyW(hKey, lpSubKey, phkResult);
    return (rc != ERROR_SUCCESS) ? fallback_create_virtual_w(hKey, lpSubKey, 0, NULL, 0, KEY_ALL_ACCESS, NULL, phkResult, NULL, rc, g_tramp_adv_RegCreateKeyExW) : rc;
}

static void ensure_advapi_hooks(void) {
    if (g_advapi_hooked != 0) return;
    HMODULE hAdv = GetModuleHandleA("advapi32.dll");
    if (!hAdv) return;
    if (InterlockedCompareExchange(&g_advapi_hooked, 1, 0) != 0) return;
    g_tramp_adv_RegOpenKeyExA = (pfnRegOpenKeyExA)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegOpenKeyExA"), (void*)hook_adv_RegOpenKeyExA);
    g_tramp_adv_RegOpenKeyExW = (pfnRegOpenKeyExW)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegOpenKeyExW"), (void*)hook_adv_RegOpenKeyExW);
    g_tramp_adv_RegOpenKeyA = (pfnRegOpenKeyA)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegOpenKeyA"), (void*)hook_adv_RegOpenKeyA);
    g_tramp_adv_RegOpenKeyW = (pfnRegOpenKeyW)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegOpenKeyW"), (void*)hook_adv_RegOpenKeyW);
    g_tramp_adv_RegCreateKeyExA = (pfnRegCreateKeyExA)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegCreateKeyExA"), (void*)hook_adv_RegCreateKeyExA);
    g_tramp_adv_RegCreateKeyExW = (pfnRegCreateKeyExW)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegCreateKeyExW"), (void*)hook_adv_RegCreateKeyExW);
    g_tramp_adv_RegCreateKeyA = (pfnRegCreateKeyA)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegCreateKeyA"), (void*)hook_adv_RegCreateKeyA);
    g_tramp_adv_RegCreateKeyW = (pfnRegCreateKeyW)install_hotpatch_hook(
        (void*)GetProcAddress(hAdv, "RegCreateKeyW"), (void*)hook_adv_RegCreateKeyW);
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
    ensure_advapi_hooks();
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

    // 32-bit OpenGL bridge (GoldSrc / Counter-Strike / Half-Life / SDL2):
    // If ReShade32.dll sits beside the game and local opengl32.dll was deleted by hl.exe
    // or bypassed by full-path System32\\opengl32.dll loading, load ReShade32.dll so it
    // hooks System32\\opengl32.dll directly without duplicating an already-loaded local opengl32.dll.
    char rs32_path[MAX_PATH];
    wsprintfA(rs32_path, "%s\\\\ReShade32.dll", g_game_dir);
    if (GetFileAttributesA(rs32_path) != INVALID_FILE_ATTRIBUTES) {
        int local_ogl_loaded = 0;
        HMODULE hOgl = GetModuleHandleA("opengl32.dll");
        if (hOgl) {
            char ogl_mod_path[MAX_PATH] = {0};
            if (GetModuleFileNameA(hOgl, ogl_mod_path, MAX_PATH) > 0 &&
                str_istarts_with_a(ogl_mod_path, g_game_dir)) {
                local_ogl_loaded = 1;
            }
        }
        if (!local_ogl_loaded && !GetModuleHandleA("ReShade32.dll")) {
            fnLoadA(rs32_path);
        }
    }

    char d3dimm_path[MAX_PATH];
    wsprintfA(d3dimm_path, "%s\\\\D3DImm.dll", g_game_dir);
    if (GetFileAttributesA(d3dimm_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(d3dimm_path);
    }

    char ddraw_path[MAX_PATH];
    wsprintfA(ddraw_path, "%s\\\\DDraw.dll", g_game_dir);
    if (GetFileAttributesA(ddraw_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(ddraw_path);
    }

    char d3d8_path[MAX_PATH];
    wsprintfA(d3d8_path, "%s\\\\D3D8.dll", g_game_dir);
    if (GetFileAttributesA(d3d8_path) != INVALID_FILE_ATTRIBUTES && !GetModuleHandleA("d3d8.dll")) {
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
    if (GetFileAttributesA(d3d9_path) != INVALID_FILE_ATTRIBUTES && !GetModuleHandleA("d3d9.dll")) {
        fnLoadA(d3d9_path);
    }

    g_preload_state = 2;
}

static HMODULE WINAPI hook_LoadLibraryA(LPCSTR lpLibFileName) {
    ensure_d3d_preloaded();
    HMODULE hMod = g_tramp_LoadLibraryA(lpLibFileName);
    if (!g_advapi_hooked) ensure_advapi_hooks();
    return hMod;
}

static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR lpLibFileName) {
    ensure_d3d_preloaded();
    HMODULE hMod = g_tramp_LoadLibraryW(lpLibFileName);
    if (!g_advapi_hooked) ensure_advapi_hooks();
    return hMod;
}

static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags) {
    if ((dwFlags & 0x62u) == 0) ensure_d3d_preloaded();
    HMODULE hMod = g_tramp_LoadLibraryExA(lpLibFileName, hFile, dwFlags);
    if (!g_advapi_hooked) ensure_advapi_hooks();
    return hMod;
}

static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags) {
    if ((dwFlags & 0x62u) == 0) ensure_d3d_preloaded();
    HMODULE hMod = g_tramp_LoadLibraryExW(lpLibFileName, hFile, dwFlags);
    if (!g_advapi_hooked) ensure_advapi_hooks();
    return hMod;
}

static HWND WINAPI hook_CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam) {
    ensure_d3d_preloaded();
    return g_tramp_CreateWindowExA(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam);
}

static HWND WINAPI hook_CreateWindowExW(DWORD dwExStyle, LPCWSTR lpClassName, LPCWSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam) {
    ensure_d3d_preloaded();
    return g_tramp_CreateWindowExW(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam);
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

static void setup_goldsrc_mod_fallback(const char* exe_name, HMODULE hKernel32) {
    if (!exe_name || lstrcmpiA(exe_name, "hl.exe") != 0) return;
    char valve_client[MAX_PATH];
    wsprintfA(valve_client, "%s\\\\valve\\\\cl_dlls\\\\client.dll", g_game_dir);
    if (GetFileAttributesA(valve_client) != INVALID_FILE_ATTRIBUTES) return;

    static const struct { const char* mod; const char* appid; } kMods[] = {
        { "cstrike", "10" },
        { "czero", "80" },
        { "dod", "30" },
        { "tfc", "20" },
        { "gearbox", "50" },
        { "bshift", "130" },
        { "ricochet", "60" },
        { "dmc", "40" },
        { "svencoop", "225840" }
    };
    const char* chosen_mod = NULL;
    const char* chosen_appid = NULL;
    for (int i = 0; i < (int)(sizeof(kMods) / sizeof(kMods[0])); i++) {
        char mod_client[MAX_PATH];
        wsprintfA(mod_client, "%s\\\\%s\\\\cl_dlls\\\\client.dll", g_game_dir, kMods[i].mod);
        if (GetFileAttributesA(mod_client) != INVALID_FILE_ATTRIBUTES) {
            chosen_mod = kMods[i].mod;
            chosen_appid = kMods[i].appid;
            break;
        }
    }
    if (!chosen_mod) return;

    char env_buf[32] = {0};
    if (GetEnvironmentVariableA("SteamAppId", env_buf, sizeof(env_buf)) == 0 && chosen_appid) {
        SetEnvironmentVariableA("SteamAppId", chosen_appid);
        SetEnvironmentVariableA("SteamGameId", chosen_appid);
    }

    const char* orig_cmd = GetCommandLineA();
    if (orig_cmd && !str_icontains_a(orig_cmd, "-game")) {
        wsprintfA(g_patched_cmdline, "%s -game %s", orig_cmd, chosen_mod);
        if (hKernel32) {
            g_tramp_GetCommandLineA = (pfnGetCommandLineA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "GetCommandLineA"), (void*)hook_GetCommandLineA);
        }
    }
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

        char exe_full[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe_full, MAX_PATH);
        lstrcpynA(g_game_dir, exe_full, MAX_PATH);
        char* last_slash = strrchr(g_game_dir, '\\\\');
        const char* exe_name = last_slash ? (last_slash + 1) : exe_full;
        if (last_slash) *last_slash = 0;

        // 1. Clamp >8 logical CPUs to first 8 cores (fixes Prototype 24-core hang & legacy 32-bit thread pool overflows)
        DWORD_PTR procMask = 0, sysMask = 0;
        if (GetProcessAffinityMask(GetCurrentProcess(), &procMask, &sysMask)) {
            int count = 0;
            DWORD_PTR clamped = 0;
            for (int bit = 0; bit < 32; bit++) {
                if (procMask & ((DWORD_PTR)1u << bit)) {
                    count++;
                    if (count <= 8) clamped |= ((DWORD_PTR)1u << bit);
                }
            }
            if (count > 8 && clamped != 0) {
                g_clamped_affinity_mask = clamped;
                SetProcessAffinityMask(GetCurrentProcess(), clamped);
            }
        }

        // 2. Forward real winmm.dll exports
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

        // 3. Install ntdll, kernel32, KernelBase & advapi32 compatibility hooks
        HMODULE hNtdll = GetModuleHandleA("ntdll.dll");
        if (hNtdll) {
            g_fnNtQueryKey = (pfnNtQueryKey)GetProcAddress(hNtdll, "NtQueryKey");
        }
        HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
        HMODULE hKernelBase = GetModuleHandleA("KernelBase.dll");
        if (hKernel32) {
            g_tramp_LoadLibraryA = (pfnLoadLibraryA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "LoadLibraryA"), (void*)hook_LoadLibraryA);
            g_tramp_LoadLibraryW = (pfnLoadLibraryW)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "LoadLibraryW"), (void*)hook_LoadLibraryW);
            g_tramp_GlobalMemoryStatus = (pfnGlobalMemoryStatus)install_hotpatch_hook(
                (void*)GetProcAddress(hKernel32, "GlobalMemoryStatus"), (void*)hook_GlobalMemoryStatus);
            if (g_clamped_affinity_mask != 0) {
                g_tramp_GetSystemInfo = (pfnGetSystemInfo)install_hotpatch_hook(
                    (void*)GetProcAddress(hKernel32, "GetSystemInfo"), (void*)hook_GetSystemInfo);
                g_tramp_GetNativeSystemInfo = (pfnGetSystemInfo)install_hotpatch_hook(
                    (void*)GetProcAddress(hKernel32, "GetNativeSystemInfo"), (void*)hook_GetNativeSystemInfo);
            }
            setup_goldsrc_mod_fallback(exe_name, hKernel32);
        }

        if (hKernelBase) {
            g_tramp_LoadLibraryExA = (pfnLoadLibraryExA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "LoadLibraryExA"), (void*)hook_LoadLibraryExA);
            g_tramp_LoadLibraryExW = (pfnLoadLibraryExW)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "LoadLibraryExW"), (void*)hook_LoadLibraryExW);
            g_tramp_kb_RegOpenKeyExA = (pfnRegOpenKeyExA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "RegOpenKeyExA"), (void*)hook_kb_RegOpenKeyExA);
            g_tramp_kb_RegOpenKeyExW = (pfnRegOpenKeyExW)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "RegOpenKeyExW"), (void*)hook_kb_RegOpenKeyExW);
            g_tramp_kb_RegCreateKeyExA = (pfnRegCreateKeyExA)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "RegCreateKeyExA"), (void*)hook_kb_RegCreateKeyExA);
            g_tramp_kb_RegCreateKeyExW = (pfnRegCreateKeyExW)install_hotpatch_hook(
                (void*)GetProcAddress(hKernelBase, "RegCreateKeyExW"), (void*)hook_kb_RegCreateKeyExW);
        }

        HMODULE hUser32 = GetModuleHandleA("user32.dll");
        if (hUser32) {
            g_tramp_CreateWindowExA = (pfnCreateWindowExA)install_hotpatch_hook(
                (void*)GetProcAddress(hUser32, "CreateWindowExA"), (void*)hook_CreateWindowExA);
            g_tramp_CreateWindowExW = (pfnCreateWindowExW)install_hotpatch_hook(
                (void*)GetProcAddress(hUser32, "CreateWindowExW"), (void*)hook_CreateWindowExW);
        }

        ensure_advapi_hooks();

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
