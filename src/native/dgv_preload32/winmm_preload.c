// Universal 32-bit dgVoodoo2 + ReShade Pre-Initializer Bridge (winmm.dll)
// Solves two universal legacy DirectX 8/9 engine issues:
// 1. Games that run DxDiag (dxdiagn.dll) at startup, which loads C:\Windows\System32\dxgi.dll
//    by full path before dgVoodoo2 loads, preventing ReShade's local dxgi.dll from loading.
// 2. Games with modular renderer driver DLLs (e.g. e2driver\e2_d3d8_driver_mfc.dll) that call
//    Direct3DCreate8 / Direct3DCreate9 inside DllMain(DLL_PROCESS_ATTACH) while holding the
//    Windows Loader Lock, causing DXGI CreateDXGIFactory1 (DXGI_ERROR_INVALID_CALL) and
//    D3D11CreateDevice worker-thread creation to fail or deadlock.

#include <windows.h>
#include <string.h>

#define BASE_ORD 2
#define NUM_FUNCS 193

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
    wsprintfA(dxgi_path, "%s\\dxgi.dll", g_game_dir);
    if (GetFileAttributesA(dxgi_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(dxgi_path);
    }

    char d3d11_path[MAX_PATH];
    wsprintfA(d3d11_path, "%s\\d3d11.dll", g_game_dir);
    if (GetFileAttributesA(d3d11_path) != INVALID_FILE_ATTRIBUTES) {
        fnLoadA(d3d11_path);
    }

    char d3d8_path[MAX_PATH];
    wsprintfA(d3d8_path, "%s\\D3D8.dll", g_game_dir);
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
    wsprintfA(d3d9_path, "%s\\D3D9.dll", g_game_dir);
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

__attribute__((naked)) void stub_2(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[0])); }
__attribute__((naked)) void stub_3(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[1])); }
__attribute__((naked)) void stub_4(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[2])); }
__attribute__((naked)) void stub_5(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[3])); }
__attribute__((naked)) void stub_6(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[4])); }
__attribute__((naked)) void stub_7(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[5])); }
__attribute__((naked)) void stub_8(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[6])); }
__attribute__((naked)) void stub_9(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[7])); }
__attribute__((naked)) void stub_10(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[8])); }
__attribute__((naked)) void stub_11(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[9])); }
__attribute__((naked)) void stub_12(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[10])); }
__attribute__((naked)) void stub_13(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[11])); }
__attribute__((naked)) void stub_14(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[12])); }
__attribute__((naked)) void stub_15(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[13])); }
__attribute__((naked)) void stub_16(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[14])); }
__attribute__((naked)) void stub_17(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[15])); }
__attribute__((naked)) void stub_18(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[16])); }
__attribute__((naked)) void stub_19(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[17])); }
__attribute__((naked)) void stub_20(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[18])); }
__attribute__((naked)) void stub_21(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[19])); }
__attribute__((naked)) void stub_22(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[20])); }
__attribute__((naked)) void stub_23(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[21])); }
__attribute__((naked)) void stub_24(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[22])); }
__attribute__((naked)) void stub_25(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[23])); }
__attribute__((naked)) void stub_26(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[24])); }
__attribute__((naked)) void stub_27(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[25])); }
__attribute__((naked)) void stub_28(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[26])); }
__attribute__((naked)) void stub_29(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[27])); }
__attribute__((naked)) void stub_30(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[28])); }
__attribute__((naked)) void stub_31(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[29])); }
__attribute__((naked)) void stub_32(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[30])); }
__attribute__((naked)) void stub_33(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[31])); }
__attribute__((naked)) void stub_34(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[32])); }
__attribute__((naked)) void stub_35(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[33])); }
__attribute__((naked)) void stub_36(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[34])); }
__attribute__((naked)) void stub_37(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[35])); }
__attribute__((naked)) void stub_38(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[36])); }
__attribute__((naked)) void stub_39(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[37])); }
__attribute__((naked)) void stub_40(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[38])); }
__attribute__((naked)) void stub_41(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[39])); }
__attribute__((naked)) void stub_42(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[40])); }
__attribute__((naked)) void stub_43(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[41])); }
__attribute__((naked)) void stub_44(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[42])); }
__attribute__((naked)) void stub_45(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[43])); }
__attribute__((naked)) void stub_46(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[44])); }
__attribute__((naked)) void stub_47(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[45])); }
__attribute__((naked)) void stub_48(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[46])); }
__attribute__((naked)) void stub_49(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[47])); }
__attribute__((naked)) void stub_50(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[48])); }
__attribute__((naked)) void stub_51(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[49])); }
__attribute__((naked)) void stub_52(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[50])); }
__attribute__((naked)) void stub_53(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[51])); }
__attribute__((naked)) void stub_54(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[52])); }
__attribute__((naked)) void stub_55(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[53])); }
__attribute__((naked)) void stub_56(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[54])); }
__attribute__((naked)) void stub_57(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[55])); }
__attribute__((naked)) void stub_58(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[56])); }
__attribute__((naked)) void stub_59(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[57])); }
__attribute__((naked)) void stub_60(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[58])); }
__attribute__((naked)) void stub_61(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[59])); }
__attribute__((naked)) void stub_62(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[60])); }
__attribute__((naked)) void stub_63(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[61])); }
__attribute__((naked)) void stub_64(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[62])); }
__attribute__((naked)) void stub_65(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[63])); }
__attribute__((naked)) void stub_66(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[64])); }
__attribute__((naked)) void stub_67(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[65])); }
__attribute__((naked)) void stub_68(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[66])); }
__attribute__((naked)) void stub_69(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[67])); }
__attribute__((naked)) void stub_70(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[68])); }
__attribute__((naked)) void stub_71(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[69])); }
__attribute__((naked)) void stub_72(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[70])); }
__attribute__((naked)) void stub_73(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[71])); }
__attribute__((naked)) void stub_74(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[72])); }
__attribute__((naked)) void stub_75(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[73])); }
__attribute__((naked)) void stub_76(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[74])); }
__attribute__((naked)) void stub_77(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[75])); }
__attribute__((naked)) void stub_78(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[76])); }
__attribute__((naked)) void stub_79(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[77])); }
__attribute__((naked)) void stub_80(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[78])); }
__attribute__((naked)) void stub_81(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[79])); }
__attribute__((naked)) void stub_82(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[80])); }
__attribute__((naked)) void stub_83(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[81])); }
__attribute__((naked)) void stub_84(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[82])); }
__attribute__((naked)) void stub_85(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[83])); }
__attribute__((naked)) void stub_86(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[84])); }
__attribute__((naked)) void stub_87(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[85])); }
__attribute__((naked)) void stub_88(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[86])); }
__attribute__((naked)) void stub_89(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[87])); }
__attribute__((naked)) void stub_90(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[88])); }
__attribute__((naked)) void stub_91(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[89])); }
__attribute__((naked)) void stub_92(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[90])); }
__attribute__((naked)) void stub_93(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[91])); }
__attribute__((naked)) void stub_94(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[92])); }
__attribute__((naked)) void stub_95(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[93])); }
__attribute__((naked)) void stub_96(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[94])); }
__attribute__((naked)) void stub_97(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[95])); }
__attribute__((naked)) void stub_98(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[96])); }
__attribute__((naked)) void stub_99(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[97])); }
__attribute__((naked)) void stub_100(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[98])); }
__attribute__((naked)) void stub_101(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[99])); }
__attribute__((naked)) void stub_102(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[100])); }
__attribute__((naked)) void stub_103(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[101])); }
__attribute__((naked)) void stub_104(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[102])); }
__attribute__((naked)) void stub_105(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[103])); }
__attribute__((naked)) void stub_106(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[104])); }
__attribute__((naked)) void stub_107(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[105])); }
__attribute__((naked)) void stub_108(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[106])); }
__attribute__((naked)) void stub_109(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[107])); }
__attribute__((naked)) void stub_110(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[108])); }
__attribute__((naked)) void stub_111(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[109])); }
__attribute__((naked)) void stub_112(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[110])); }
__attribute__((naked)) void stub_113(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[111])); }
__attribute__((naked)) void stub_114(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[112])); }
__attribute__((naked)) void stub_115(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[113])); }
__attribute__((naked)) void stub_116(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[114])); }
__attribute__((naked)) void stub_117(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[115])); }
__attribute__((naked)) void stub_118(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[116])); }
__attribute__((naked)) void stub_119(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[117])); }
__attribute__((naked)) void stub_120(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[118])); }
__attribute__((naked)) void stub_121(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[119])); }
__attribute__((naked)) void stub_122(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[120])); }
__attribute__((naked)) void stub_123(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[121])); }
__attribute__((naked)) void stub_124(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[122])); }
__attribute__((naked)) void stub_125(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[123])); }
__attribute__((naked)) void stub_126(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[124])); }
__attribute__((naked)) void stub_127(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[125])); }
__attribute__((naked)) void stub_128(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[126])); }
__attribute__((naked)) void stub_129(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[127])); }
__attribute__((naked)) void stub_130(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[128])); }
__attribute__((naked)) void stub_131(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[129])); }
__attribute__((naked)) void stub_132(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[130])); }
__attribute__((naked)) void stub_133(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[131])); }
__attribute__((naked)) void stub_134(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[132])); }
__attribute__((naked)) void stub_135(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[133])); }
__attribute__((naked)) void stub_136(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[134])); }
__attribute__((naked)) void stub_137(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[135])); }
__attribute__((naked)) void stub_138(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[136])); }
__attribute__((naked)) void stub_139(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[137])); }
__attribute__((naked)) void stub_140(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[138])); }
__attribute__((naked)) void stub_141(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[139])); }
__attribute__((naked)) void stub_142(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[140])); }
__attribute__((naked)) void stub_143(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[141])); }
__attribute__((naked)) void stub_144(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[142])); }
__attribute__((naked)) void stub_145(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[143])); }
__attribute__((naked)) void stub_146(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[144])); }
__attribute__((naked)) void stub_147(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[145])); }
__attribute__((naked)) void stub_148(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[146])); }
__attribute__((naked)) void stub_149(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[147])); }
__attribute__((naked)) void stub_150(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[148])); }
__attribute__((naked)) void stub_152(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[150])); }
__attribute__((naked)) void stub_153(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[151])); }
__attribute__((naked)) void stub_154(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[152])); }
__attribute__((naked)) void stub_155(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[153])); }
__attribute__((naked)) void stub_156(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[154])); }
__attribute__((naked)) void stub_157(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[155])); }
__attribute__((naked)) void stub_158(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[156])); }
__attribute__((naked)) void stub_159(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[157])); }
__attribute__((naked)) void stub_160(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[158])); }
__attribute__((naked)) void stub_161(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[159])); }
__attribute__((naked)) void stub_162(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[160])); }
__attribute__((naked)) void stub_163(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[161])); }
__attribute__((naked)) void stub_164(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[162])); }
__attribute__((naked)) void stub_165(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[163])); }
__attribute__((naked)) void stub_166(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[164])); }
__attribute__((naked)) void stub_167(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[165])); }
__attribute__((naked)) void stub_168(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[166])); }
__attribute__((naked)) void stub_169(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[167])); }
__attribute__((naked)) void stub_170(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[168])); }
__attribute__((naked)) void stub_171(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[169])); }
__attribute__((naked)) void stub_172(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[170])); }
__attribute__((naked)) void stub_173(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[171])); }
__attribute__((naked)) void stub_174(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[172])); }
__attribute__((naked)) void stub_175(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[173])); }
__attribute__((naked)) void stub_176(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[174])); }
__attribute__((naked)) void stub_177(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[175])); }
__attribute__((naked)) void stub_178(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[176])); }
__attribute__((naked)) void stub_179(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[177])); }
__attribute__((naked)) void stub_180(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[178])); }
__attribute__((naked)) void stub_181(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[179])); }
__attribute__((naked)) void stub_182(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[180])); }
__attribute__((naked)) void stub_183(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[181])); }
__attribute__((naked)) void stub_184(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[182])); }
__attribute__((naked)) void stub_185(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[183])); }
__attribute__((naked)) void stub_186(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[184])); }
__attribute__((naked)) void stub_187(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[185])); }
__attribute__((naked)) void stub_188(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[186])); }
__attribute__((naked)) void stub_189(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[187])); }
__attribute__((naked)) void stub_190(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[188])); }
__attribute__((naked)) void stub_191(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[189])); }
__attribute__((naked)) void stub_192(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[190])); }
__attribute__((naked)) void stub_193(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[191])); }
__attribute__((naked)) void stub_194(void) { __asm__ volatile("jmp *%0" : : "m"(g_procs[192])); }

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        void* peb = (void*)__readfsdword(0x30);
        if (peb) {
            g_loader_lock = *(void**)((char*)peb + 0xA0);
        }
        GetModuleFileNameA(NULL, g_game_dir, MAX_PATH);
        char* last_slash = strrchr(g_game_dir, '\\');
        if (last_slash) *last_slash = 0;

        char sys_dir[MAX_PATH];
        GetSystemDirectoryA(sys_dir, MAX_PATH);
        char winmm_path[MAX_PATH];
        wsprintfA(winmm_path, "%s\\winmm.dll", sys_dir);
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
