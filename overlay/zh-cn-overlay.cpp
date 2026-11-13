// SPDX-License-Identifier: MIT
// DLSS 5 Swapper Enhanced - 游戏内 Home (ReShade) 菜单全量简体中文化插件
// 设计原则：
// 1. 零磁盘篡改：绝不修改任何原版 .addon64 或 ReShade64.dll 磁盘文件，保持所有 SHA-256 签名与探针兼容。
// 2. 零格式化崩溃：所有 printf/vsnprintf 格式化字符串在编译期与运行期双重校验占位符，向底层 ImGui 仅传递 "%s"。
// 3. 控件 ID 100% 保持：所有交互式控件使用 "中文译文###原始英文标签" 语法，保证 ImGuiID 与原版英文完全一致。

#define ImTextureID ImU64
#include <imgui.h>
#include <reshade.hpp>
#include <windows.h>
#include <dxgi1_4.h>
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <unordered_map>
#include "zh-cn-dict.hpp"

extern "C" __declspec(dllexport) const char *NAME =
    "\xe7\x95\x8c\xe9\x9d\xa2\xe4\xb8\xad\xe6\x96\x87\xe5\x8c\x96\xe7\xbb\x84\xe4\xbb\xb6 (ZH-CN)";
extern "C" __declspec(dllexport) const char *DESCRIPTION =
    "\xe4\xb8\xba ReShade\xe3\x80\x81" "DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe3\x80\x81"
    "MFG \xe5\xa4\x9a\xe5\xb8\xa7\xe7\x94\x9f\xe6\x88\x90\xe8\xa7\xa3\xe9\x94\x81\xe3\x80\x81"
    "DLSS 5 Feeder \xe4\xb8\x8e\xe9\x80\x9a\xe7\x94\xa8\xe6\xb7\xb1\xe5\xba\xa6\xe6\xa3\x80\xe6\xb5\x8b"
    "\xe6\x8f\x90\xe4\xbe\x9b\xe5\xae\x8c\xe6\x95\xb4\xe7\xae\x80\xe4\xbd\x93\xe4\xb8\xad\xe6\x96\x87\xe7\x95\x8c\xe9\x9d\xa2\xe7\xbf\xbb\xe8\xaf\x91\xe3\x80\x82";
extern "C" __declspec(dllexport) const char *AUTHOR = "DLSS 5 Swapper Enhanced";

static_assert(IMGUI_VERSION_NUM == 19250, "Expected ImGui 1.92.5 (19250)");

namespace {

imgui_function_table g_orig = {};
bool g_table_hooked = false;
bool g_reshade_patched = false;
HMODULE g_reshade_module = nullptr;

// 线程本地环形缓冲区，避免同一帧多次翻译调用互相覆盖且零堆分配
constexpr size_t kRingSlots = 32;
constexpr size_t kRingBufSize = 4096;
thread_local char tl_ring[kRingSlots][kRingBufSize];
thread_local size_t tl_ring_idx = 0;

inline char *next_tl_buf() {
    char *b = tl_ring[tl_ring_idx & (kRingSlots - 1)];
    ++tl_ring_idx;
    return b;
}

struct ExactValue {
    const char *zh;
    bool has_printf_specs;
};

const std::unordered_map<std::string_view, ExactValue> &exact_map() {
    static const auto *map = []() {
        auto *m = new std::unordered_map<std::string_view, ExactValue>();
        m->reserve(zh_cn::kExactEntryCount * 2);
        for (size_t i = 0; i < zh_cn::kExactEntryCount; ++i) {
            const auto &e = zh_cn::kExactEntries[i];
            m->emplace(std::string_view(e.en), ExactValue{e.zh, e.has_printf_specs});
        }
        return m;
    }();
    return *map;
}

// ReShade 6.8.0 已内置完整简体中文字库并启用 zh-Hans，直接返回 true 避免对 ImFont 指针做额外间接调用
inline bool can_render_chinese() {
    return true;
}

// 检查字符串是否包含合法的 printf 格式化占位符（排除 %n 及类似 "(%)"、"100%" 的非占位符百分号）
inline bool has_printf_specifier(const char *s) {
    if (!s) return false;
    while (*s) {
        if (*s == '%') {
            ++s;
            if (*s == '%') {
                ++s;
                continue;
            }
            while (*s == '-' || *s == '+' || *s == ' ' || *s == '#' || *s == '0') ++s;
            while (*s >= '0' && *s <= '9') ++s;
            if (*s == '.') {
                ++s;
                while (*s >= '0' && *s <= '9') ++s;
            }
            while (*s == 'h' || *s == 'l' || *s == 'L' || *s == 'z' || *s == 'j' || *s == 't' || *s == 'I') ++s;
            switch (*s) {
                case 'd': case 'i': case 'u': case 'o': case 'x': case 'X':
                case 'f': case 'F': case 'e': case 'E': case 'g': case 'G':
                case 'a': case 'A': case 'c': case 's': case 'p':
                    return true;
                default:
                    break;
            }
        } else {
            ++s;
        }
    }
    return false;
}

// 对动态拼接字符串执行子串替换
const char *apply_substring_rules(std::string_view input, bool *changed_out = nullptr) {
    if (changed_out) *changed_out = false;
    if (input.empty()) return "";

    std::string work(input);
    bool changed = false;
    for (size_t i = 0; i < zh_cn::kSubstringRuleCount; ++i) {
        const auto &rule = zh_cn::kSubstringRules[i];
        size_t pos = 0;
        while ((pos = work.find(rule.en, pos, rule.en_len)) != std::string::npos) {
            work.replace(pos, rule.en_len, rule.zh, rule.zh_len);
            pos += rule.zh_len;
            changed = true;
        }
    }
    if (!changed) return nullptr;
    if (changed_out) *changed_out = true;
    char *out = next_tl_buf();
    const size_t n = work.size() < (kRingBufSize - 1) ? work.size() : (kRingBufSize - 1);
    memcpy(out, work.data(), n);
    out[n] = '\0';
    return out;
}

// 翻译纯文本（不附加 ###id）
const char *translate_plain(const char *text, const char *text_end = nullptr) {
    if (!text || !text[0] || !can_render_chinese()) return nullptr;
    const size_t len = text_end ? static_cast<size_t>(text_end - text) : strlen(text);
    if (len == 0 || len >= kRingBufSize) return nullptr;

    std::string_view sv(text, len);
    const auto &m = exact_map();
    auto it = m.find(sv);
    if (it != m.end() && !it->second.has_printf_specs) {
        return it->second.zh;
    }
    return apply_substring_rules(sv);
}

// 翻译交互式控件标签，并通过 "中文译文###原始英文标签" 严格保持原有 ImGuiID
const char *translate_widget_label(const char *label) {
    if (!label || !label[0] || !can_render_chinese()) return label;
    // 以 ## 开头的隐藏标签直接原样返回
    if (label[0] == '#' && label[1] == '#') return label;

    const char *hash = strstr(label, "##");
    const auto &m = exact_map();

    if (!hash) {
        std::string_view sv(label);
        auto it = m.find(sv);
        const char *zh = nullptr;
        if (it != m.end() && !it->second.has_printf_specs) {
            zh = it->second.zh;
        } else {
            zh = apply_substring_rules(sv);
        }
        if (!zh) return label;
        char *out = next_tl_buf();
        snprintf(out, kRingBufSize, "%s###%s", zh, label);
        return out;
    }

    // 处理包含 ##id 或 ###id 的标签
    const size_t vis_len = static_cast<size_t>(hash - label);
    if (vis_len == 0) return label;
    std::string_view vis_sv(label, vis_len);
    auto it = m.find(vis_sv);
    const char *zh_vis = nullptr;
    if (it != m.end() && !it->second.has_printf_specs) {
        zh_vis = it->second.zh;
    } else {
        zh_vis = apply_substring_rules(vis_sv);
    }
    if (!zh_vis) return label;

    char *out = next_tl_buf();
    if (hash[2] == '#') {
        // 原本已经是 "Visible###id"
        snprintf(out, kRingBufSize, "%s%s", zh_vis, hash);
    } else {
        // 原本是 "Visible##id"，完整字符串参与了哈希，转为 "中文###Visible##id"
        snprintf(out, kRingBufSize, "%s###%s", zh_vis, label);
    }
    return out;
}

// 安全格式化并翻译 printf 风格文本，绝不让异常占位符进入底层 ImGui
const char *format_and_translate_v(const char *fmt, va_list args) {
    if (!fmt) return "";
    if (!fmt[0]) return "";

    const bool zh_ok = can_render_chinese();
    const auto &m = exact_map();

    if (zh_ok) {
        std::string_view fmt_sv(fmt);
        auto it = m.find(fmt_sv);
        if (it != m.end()) {
            if (!it->second.has_printf_specs) {
                // 纯静态字符串（即使包含 100% 等字面量百分号），直接返回中文译文，不调用 vsnprintf
                return it->second.zh;
            }
            // 编译期已严格校验占位符一致的格式化模板
            char *formatted = next_tl_buf();
            va_list copy;
            va_copy(copy, args);
            vsnprintf(formatted, kRingBufSize, it->second.zh, copy);
            va_end(copy);

            // 对格式化后的结果再做一次精确/子串替换（例如 %s 参数本身是 "open" / "disabled"）
            std::string_view res_sv(formatted);
            auto it2 = m.find(res_sv);
            if (it2 != m.end() && !it2->second.has_printf_specs) return it2->second.zh;
            if (const char *sub = apply_substring_rules(res_sv)) return sub;
            return formatted;
        }
    }

    // 未命中模板字典：仅当包含合法 printf 占位符时才调用 vsnprintf
    char *raw = next_tl_buf();
    if (!has_printf_specifier(fmt)) {
        const size_t n = strlen(fmt) < (kRingBufSize - 1) ? strlen(fmt) : (kRingBufSize - 1);
        memcpy(raw, fmt, n);
        raw[n] = '\0';
    } else {
        va_list copy;
        va_copy(copy, args);
        vsnprintf(raw, kRingBufSize, fmt, copy);
        va_end(copy);
    }

    if (!zh_ok) return raw;

    std::string_view raw_sv(raw);
    auto it = m.find(raw_sv);
    if (it != m.end() && !it->second.has_printf_specs) {
        return it->second.zh;
    }
    if (const char *sub = apply_substring_rules(raw_sv)) {
        return sub;
    }
    return raw;
}

void call_text_v(void (*fn)(const char *, va_list), const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fn(fmt, args);
    va_end(args);
}

void call_text_colored_v(void (*fn)(const ImVec4 &, const char *, va_list), const ImVec4 &col, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fn(col, fmt, args);
    va_end(args);
}

void call_label_text_v(void (*fn)(const char *, const char *, va_list), const char *label, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fn(label, fmt, args);
    va_end(args);
}

bool call_tree_node_v(bool (*fn)(const char *, const char *, va_list), const char *str_id, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    bool res = fn(str_id, fmt, args);
    va_end(args);
    return res;
}

bool call_tree_node_ex_v(bool (*fn)(const char *, ImGuiTreeNodeFlags, const char *, va_list), const char *str_id, ImGuiTreeNodeFlags flags, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    bool res = fn(str_id, flags, fmt, args);
    va_end(args);
    return res;
}

// === ImGui 函数表挂钩实现 ===

void hook_TextUnformatted(const char *text, const char *text_end) {
    if (const char *zh = translate_plain(text, text_end)) {
        g_orig.TextUnformatted(zh, zh + strlen(zh));
        return;
    }
    g_orig.TextUnformatted(text, text_end);
}

void hook_TextV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.TextV, "%s", out);
}

void hook_TextColoredV(const ImVec4 &col, const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_colored_v(g_orig.TextColoredV, col, "%s", out);
}

void hook_TextDisabledV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.TextDisabledV, "%s", out);
}

void hook_TextWrappedV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.TextWrappedV, "%s", out);
}

void hook_LabelTextV(const char *label, const char *fmt, va_list args) {
    const char *zh_label = translate_widget_label(label);
    const char *out = format_and_translate_v(fmt, args);
    call_label_text_v(g_orig.LabelTextV, zh_label, "%s", out);
}

void hook_BulletTextV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.BulletTextV, "%s", out);
}

void hook_SeparatorText(const char *label) {
    if (const char *zh = translate_plain(label)) {
        g_orig.SeparatorText(zh);
        return;
    }
    g_orig.SeparatorText(label);
}

bool hook_Button(const char *label, const ImVec2 &size) {
    return g_orig.Button(translate_widget_label(label), size);
}

bool hook_SmallButton(const char *label) {
    return g_orig.SmallButton(translate_widget_label(label));
}

bool hook_Checkbox(const char *label, bool *v) {
    return g_orig.Checkbox(translate_widget_label(label), v);
}

bool hook_CheckboxFlags(const char *label, int *flags, int flags_value) {
    return g_orig.CheckboxFlags(translate_widget_label(label), flags, flags_value);
}

bool hook_CheckboxFlags2(const char *label, unsigned int *flags, unsigned int flags_value) {
    return g_orig.CheckboxFlags2(translate_widget_label(label), flags, flags_value);
}

bool hook_RadioButton(const char *label, bool active) {
    return g_orig.RadioButton(translate_widget_label(label), active);
}

bool hook_RadioButton2(const char *label, int *v, int v_button) {
    return g_orig.RadioButton2(translate_widget_label(label), v, v_button);
}

bool hook_BeginCombo(const char *label, const char *preview_value, ImGuiComboFlags flags) {
    const char *zh_label = translate_widget_label(label);
    const char *zh_preview = preview_value ? translate_plain(preview_value) : nullptr;
    return g_orig.BeginCombo(zh_label, zh_preview ? zh_preview : preview_value, flags);
}

bool hook_Combo(const char *label, int *current_item, const char *const items[], int items_count, int popup_max_height_in_items) {
    const char *zh_label = translate_widget_label(label);
    if (!items || items_count <= 0 || items_count > 64 || !can_render_chinese()) {
        return g_orig.Combo(zh_label, current_item, items, items_count, popup_max_height_in_items);
    }
    const char *zh_items[64];
    for (int i = 0; i < items_count; ++i) {
        const char *zh = items[i] ? translate_plain(items[i]) : nullptr;
        zh_items[i] = zh ? zh : items[i];
    }
    return g_orig.Combo(zh_label, current_item, zh_items, items_count, popup_max_height_in_items);
}

bool hook_Combo2(const char *label, int *current_item, const char *items_separated_by_zeros, int popup_max_height_in_items) {
    const char *zh_label = translate_widget_label(label);
    if (!items_separated_by_zeros || !can_render_chinese()) {
        return g_orig.Combo2(zh_label, current_item, items_separated_by_zeros, popup_max_height_in_items);
    }
    char *buf = next_tl_buf();
    size_t out_pos = 0;
    const char *p = items_separated_by_zeros;
    while (*p) {
        const size_t len = strlen(p);
        const char *zh = translate_plain(p, p + len);
        const char *use = zh ? zh : p;
        const size_t use_len = strlen(use);
        if (out_pos + use_len + 2 >= kRingBufSize) {
            return g_orig.Combo2(zh_label, current_item, items_separated_by_zeros, popup_max_height_in_items);
        }
        memcpy(buf + out_pos, use, use_len + 1);
        out_pos += use_len + 1;
        p += len + 1;
    }
    buf[out_pos] = '\0';
    return g_orig.Combo2(zh_label, current_item, buf, popup_max_height_in_items);
}

bool hook_DragFloat(const char *label, float *v, float v_speed, float v_min, float v_max, const char *format, ImGuiSliderFlags flags) {
    return g_orig.DragFloat(translate_widget_label(label), v, v_speed, v_min, v_max, format, flags);
}

bool hook_DragInt(const char *label, int *v, float v_speed, int v_min, int v_max, const char *format, ImGuiSliderFlags flags) {
    return g_orig.DragInt(translate_widget_label(label), v, v_speed, v_min, v_max, format, flags);
}

bool hook_SliderFloat(const char *label, float *v, float v_min, float v_max, const char *format, ImGuiSliderFlags flags) {
    return g_orig.SliderFloat(translate_widget_label(label), v, v_min, v_max, format, flags);
}

bool hook_SliderInt(const char *label, int *v, int v_min, int v_max, const char *format, ImGuiSliderFlags flags) {
    return g_orig.SliderInt(translate_widget_label(label), v, v_min, v_max, format, flags);
}

bool hook_InputFloat(const char *label, float *v, float step, float step_fast, const char *format, ImGuiInputTextFlags flags) {
    return g_orig.InputFloat(translate_widget_label(label), v, step, step_fast, format, flags);
}

bool hook_InputInt(const char *label, int *v, int step, int step_fast, ImGuiInputTextFlags flags) {
    return g_orig.InputInt(translate_widget_label(label), v, step, step_fast, flags);
}

bool hook_TreeNode(const char *label) {
    return g_orig.TreeNode(translate_widget_label(label));
}

bool hook_TreeNodeV(const char *str_id, const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    return call_tree_node_v(g_orig.TreeNodeV, str_id, "%s", out);
}

bool hook_TreeNodeEx(const char *label, ImGuiTreeNodeFlags flags) {
    return g_orig.TreeNodeEx(translate_widget_label(label), flags);
}

bool hook_TreeNodeExV(const char *str_id, ImGuiTreeNodeFlags flags, const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    return call_tree_node_ex_v(g_orig.TreeNodeExV, str_id, flags, "%s", out);
}

bool hook_CollapsingHeader(const char *label, ImGuiTreeNodeFlags flags) {
    return g_orig.CollapsingHeader(translate_widget_label(label), flags);
}

bool hook_CollapsingHeader2(const char *label, bool *p_visible, ImGuiTreeNodeFlags flags) {
    return g_orig.CollapsingHeader2(translate_widget_label(label), p_visible, flags);
}

bool hook_Selectable(const char *label, bool selected, ImGuiSelectableFlags flags, const ImVec2 &size) {
    return g_orig.Selectable(translate_widget_label(label), selected, flags, size);
}

bool hook_Selectable2(const char *label, bool *p_selected, ImGuiSelectableFlags flags, const ImVec2 &size) {
    return g_orig.Selectable2(translate_widget_label(label), p_selected, flags, size);
}

void hook_SetTooltipV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.SetTooltipV, "%s", out);
}

void hook_SetItemTooltipV(const char *fmt, va_list args) {
    const char *out = format_and_translate_v(fmt, args);
    call_text_v(g_orig.SetItemTooltipV, "%s", out);
}

void hook_TableSetupColumn(const char *label, ImGuiTableColumnFlags flags, float init_width_or_weight, ImGuiID user_id) {
    g_orig.TableSetupColumn(translate_widget_label(label), flags, init_width_or_weight, user_id);
}

void hook_TableHeader(const char *label) {
    g_orig.TableHeader(translate_widget_label(label));
}

bool hook_BeginTabItem(const char *label, bool *p_open, ImGuiTabItemFlags flags) {
    static bool s_logged_home_open = false;
    if (!s_logged_home_open && label && strcmp(label, "Home") == 0) {
        s_logged_home_open = true;
        reshade::log::message(reshade::log::level::info, "DLSS 5 Swapper Enhanced: ReShade Home menu opened in Chinese.");
    }
    return g_orig.BeginTabItem(translate_widget_label(label), p_open, flags);
}

bool hook_TabItemButton(const char *label, ImGuiTabItemFlags flags) {
    return g_orig.TabItemButton(translate_widget_label(label), flags);
}

// === v2.3.2 新增：一层 DLSS 5 (NRPasses=1) 画质强化与显卡降开销实时快调引擎 ===

struct SinglePassTunerState {
    bool initialized = false;
    bool has_feeder_cfg = false;
    bool is_host64 = false;
    int preset_idx = 0; // 0: 单层强效·省卡, 1: 极致省卡·高帧, 2: 单层满血, 3: 原厂标准, 4: 自定义
    float intensity = 1.35f;
    float structure = 1.30f;
    float local_tone = 1.22f;
    bool look_enabled = true;
    float detail_boost = 1.35f;
    float tone_boost = 1.15f;
    float color_boost = 1.08f;
    int nr_style = 1;
    int work_res = 75;
    int work_upscale = 1;
    float sharpness = 0.35f;
    float hold_strength = 0.30f;
};

SinglePassTunerState g_tuner = {};
std::wstring g_exe_dir_w;
std::wstring g_consumer_ini_w;
std::wstring g_feed_cfg_w;
FILETIME g_last_ini_mtime = {0, 0};
ULONGLONG g_last_poll_tick = 0;

bool file_exists_w(const std::wstring &p) {
    if (p.empty()) return false;
    DWORD attr = GetFileAttributesW(p.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool get_file_mtime_w(const std::wstring &p, FILETIME *out) {
    if (p.empty() || !out) return false;
    WIN32_FILE_ATTRIBUTE_DATA fad = {};
    if (!GetFileAttributesExW(p.c_str(), GetFileExInfoStandard, &fad)) return false;
    *out = fad.ftLastWriteTime;
    return true;
}

std::string read_utf8_file_w(const std::wstring &path) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return {};
    LARGE_INTEGER sz = {};
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > 4 * 1024 * 1024) {
        CloseHandle(h);
        return {};
    }
    std::string out(static_cast<size_t>(sz.QuadPart), '\0');
    DWORD rd = 0;
    ReadFile(h, out.data(), static_cast<DWORD>(out.size()), &rd, nullptr);
    CloseHandle(h);
    out.resize(rd);
    return out;
}

bool write_utf8_atomic_w(const std::wstring &path, const std::string &content) {
    if (path.empty()) return false;
    DWORD attr = GetFileAttributesW(path.c_str());
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_READONLY)) {
        SetFileAttributesW(path.c_str(), attr & ~FILE_ATTRIBUTE_READONLY);
    }
    wchar_t pid_buf[64] = {};
    swprintf(pid_buf, 64, L".enh-%lu-%llu.tmp", GetCurrentProcessId(), GetTickCount64());
    std::wstring tmp = path + pid_buf;
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD wr = 0;
    BOOL ok = WriteFile(h, content.data(), static_cast<DWORD>(content.size()), &wr, nullptr);
    FlushFileBuffers(h);
    CloseHandle(h);
    if (!ok || wr != content.size()) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    if (!MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        CopyFileW(tmp.c_str(), path.c_str(), FALSE);
        DeleteFileW(tmp.c_str());
    }
    return true;
}

std::string trim_ascii(std::string_view sv) {
    size_t b = 0, e = sv.size();
    while (b < e && (sv[b] == ' ' || sv[b] == '\t' || sv[b] == '\r' || sv[b] == '\n')) ++b;
    while (e > b && (sv[e - 1] == ' ' || sv[e - 1] == '\t' || sv[e - 1] == '\r' || sv[e - 1] == '\n')) --e;
    return std::string(sv.substr(b, e - b));
}

bool iequals_ascii(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        char ca = (a[i] >= 'A' && a[i] <= 'Z') ? static_cast<char>(a[i] + 32) : a[i];
        char cb = (b[i] >= 'A' && b[i] <= 'Z') ? static_cast<char>(b[i] + 32) : b[i];
        if (ca != cb) return false;
    }
    return true;
}

std::string ini_get_str(const std::string &text, std::string_view section, std::string_view key) {
    std::string cur_sec;
    size_t pos = 0;
    while (pos < text.size()) {
        size_t end = text.find('\n', pos);
        if (end == std::string::npos) end = text.size();
        std::string line = trim_ascii(std::string_view(text).substr(pos, end - pos));
        pos = end + 1;
        if (line.empty() || line[0] == ';' || line[0] == '#') continue;
        if (line.front() == '[' && line.back() == ']') {
            cur_sec = trim_ascii(std::string_view(line).substr(1, line.size() - 2));
            continue;
        }
        if ((section.empty() && cur_sec.empty()) || iequals_ascii(cur_sec, section)) {
            size_t eq = line.find('=');
            if (eq != std::string::npos) {
                std::string k = trim_ascii(std::string_view(line).substr(0, eq));
                if (iequals_ascii(k, key)) {
                    return trim_ascii(std::string_view(line).substr(eq + 1));
                }
            }
        }
    }
    return {};
}

void ini_set_kv(std::string &text, const char *section, const char *key, const char *val) {
    std::vector<std::string> lines;
    size_t pos = 0;
    while (pos < text.size()) {
        size_t end = text.find('\n', pos);
        if (end == std::string::npos) {
            std::string l = text.substr(pos);
            if (!l.empty() && l.back() == '\r') l.pop_back();
            lines.push_back(std::move(l));
            break;
        }
        std::string l = text.substr(pos, end - pos);
        if (!l.empty() && l.back() == '\r') l.pop_back();
        lines.push_back(std::move(l));
        pos = end + 1;
    }

    const bool root_sec = (!section || !section[0]);
    bool in_sec = root_sec;
    bool sec_found = root_sec;
    bool key_written = false;
    size_t insert_at = lines.size();

    for (size_t i = 0; i < lines.size(); ++i) {
        std::string trimmed = trim_ascii(lines[i]);
        if (!trimmed.empty() && trimmed.front() == '[' && trimmed.back() == ']') {
            if (in_sec && !root_sec && !key_written) {
                insert_at = i;
            }
            std::string sec_name = trim_ascii(std::string_view(trimmed).substr(1, trimmed.size() - 2));
            in_sec = !root_sec && iequals_ascii(sec_name, section);
            if (in_sec) sec_found = true;
            continue;
        }
        if (in_sec && !trimmed.empty() && trimmed[0] != ';' && trimmed[0] != '#') {
            size_t eq = trimmed.find('=');
            if (eq != std::string::npos) {
                std::string k = trim_ascii(std::string_view(trimmed).substr(0, eq));
                if (iequals_ascii(k, key)) {
                    lines[i] = std::string(key) + "=" + val;
                    key_written = true;
                    break;
                }
            }
        }
    }

    if (!key_written) {
        if (!sec_found && !root_sec) {
            if (!lines.empty() && !lines.back().empty()) lines.push_back({});
            lines.push_back(std::string("[") + section + "]");
            lines.push_back(std::string(key) + "=" + val);
        } else {
            lines.insert(lines.begin() + static_cast<ptrdiff_t>(insert_at), std::string(key) + "=" + val);
        }
    }

    std::string out;
    out.reserve(text.size() + 64);
    for (const auto &l : lines) {
        out += l;
        out += "\r\n";
    }
    text = std::move(out);
}

bool parse_float_safe(const std::string &s, float *out) {
    if (s.empty() || !out) return false;
    char *endp = nullptr;
    float v = strtof(s.c_str(), &endp);
    if (endp == s.c_str() || !std::isfinite(v)) return false;
    *out = v;
    return true;
}

#ifdef _WIN64
struct RenodxLiveAtomics {
    HMODULE bound_mod = nullptr;
    bool checked = false;
    bool valid = false;
    volatile long *nr_passes = nullptr;
    volatile long *nr_style = nullptr;
    volatile long *nr_look_upsample = nullptr;
    volatile long *nr_detail_stability = nullptr;
    volatile long *nr_intensity_bits = nullptr;
    volatile long *nr_local_tone_bits = nullptr;
    volatile long *nr_local_structure_bits = nullptr;
    volatile long *nr_res_scale_bits = nullptr;
    volatile long *nr_look_strength_bits = nullptr;
    volatile long *nr_look_colour_bits = nullptr;
    volatile long *nr_look_tone_bits = nullptr;
    volatile long *nr_look_detail_bits = nullptr;
    uint8_t *nr_skin_independent = nullptr;
    uint8_t *nr_follow_input_res = nullptr;
    uint8_t *nr_look_mode = nullptr;
};

RenodxLiveAtomics g_rx_atomics = {};

inline void store_atomic_float(volatile long *dst, float val) {
    if (!dst) return;
    long bits = 0;
    memcpy(&bits, &val, sizeof(long));
    _InterlockedExchange(dst, bits);
}

inline float load_atomic_float(volatile long *src, float fallback) {
    if (!src) return fallback;
    long bits = _InterlockedCompareExchange(src, 0, 0);
    float val = fallback;
    memcpy(&val, &bits, sizeof(float));
    return std::isfinite(val) ? val : fallback;
}

inline void store_atomic_bool(uint8_t *dst, bool val) {
    if (!dst) return;
    __atomic_store_n(dst, static_cast<uint8_t>(val ? 1 : 0), __ATOMIC_SEQ_CST);
}

inline bool load_atomic_bool(const uint8_t *src, bool fallback) {
    if (!src) return fallback;
    return __atomic_load_n(src, __ATOMIC_SEQ_CST) != 0;
}

bool ensure_renodx_atomics_bound() {
    HMODULE mod = GetModuleHandleW(L"renodx-dlss5.addon64");
    if (!mod) {
        g_rx_atomics = {};
        return false; // 尚未加载完成，稍后重试
    }
    if (g_rx_atomics.bound_mod == mod && g_rx_atomics.checked) {
        return g_rx_atomics.valid;
    }

    g_rx_atomics = {};
    g_rx_atomics.bound_mod = mod;
    g_rx_atomics.checked = true;
    auto *base = reinterpret_cast<uint8_t *>(mod);
    auto *dos = reinterpret_cast<IMAGE_DOS_HEADER *>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    auto *nt = reinterpret_cast<IMAGE_NT_HEADERS64 *>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.SizeOfImage != 0x30C000) return false;

    struct DescCheck {
        uint32_t entry_rva;
        const char *key;
        int slot; // 1: float*, 2: int*, 3: bool*
        uint32_t ptr_rva;
    };
    static const DescCheck kChecks[] = {
        {0x2a8da0, "NRIntensity",       1, 0x2e55d0},
        {0x2a8e10, "NRStyle",           2, 0x2ea0f4},
        {0x2a8e40, "NRLocalTone",       1, 0x2e55d4},
        {0x2a8e78, "NRLocalStructure",  1, 0x2e55d8},
        {0x2a8ef0, "NRSkinIndependent", 3, 0x2e55e0},
        {0x2a9130, "NRFollowInputRes",  3, 0x2ea208},
        {0x2a9170, "NRResolutionScale", 1, 0x2e5678},
        {0x2a91b0, "NRPasses",          2, 0x2e55f0},
        {0x2a9c38, "NRLookMode",        3, 0x2ea11a},
        {0x2a9c70, "NRLookStrength",    1, 0x2e5640},
        {0x2a9d90, "NRLookColour",      1, 0x2e564c},
        {0x2a9ee8, "NRLookTone",        1, 0x2e5660},
        {0x2a9f20, "NRLookDetail",      1, 0x2e5664},
        {0x2aa0c8, "NRLookUpsample",    2, 0x2ea138},
        {0x2aa100, "NRDetailStability", 2, 0x2ea13c},
    };

    const uintptr_t rdata_min = reinterpret_cast<uintptr_t>(base + 0x15F000);
    const uintptr_t rdata_max = reinterpret_cast<uintptr_t>(base + 0x2E2000);
    for (const auto &c : kChecks) {
        const auto *qwords = reinterpret_cast<const uintptr_t *>(base + c.entry_rva);
        if (qwords[0] < rdata_min || qwords[0] >= rdata_max) return false;
        if (strcmp(reinterpret_cast<const char *>(qwords[0]), c.key) != 0) return false;
        if (qwords[c.slot] != reinterpret_cast<uintptr_t>(base + c.ptr_rva)) return false;
    }

    g_rx_atomics.nr_intensity_bits       = reinterpret_cast<volatile long *>(base + 0x2e55d0);
    g_rx_atomics.nr_local_tone_bits      = reinterpret_cast<volatile long *>(base + 0x2e55d4);
    g_rx_atomics.nr_local_structure_bits = reinterpret_cast<volatile long *>(base + 0x2e55d8);
    g_rx_atomics.nr_res_scale_bits       = reinterpret_cast<volatile long *>(base + 0x2e5678);
    g_rx_atomics.nr_look_strength_bits   = reinterpret_cast<volatile long *>(base + 0x2e5640);
    g_rx_atomics.nr_look_colour_bits     = reinterpret_cast<volatile long *>(base + 0x2e564c);
    g_rx_atomics.nr_look_tone_bits       = reinterpret_cast<volatile long *>(base + 0x2e5660);
    g_rx_atomics.nr_look_detail_bits     = reinterpret_cast<volatile long *>(base + 0x2e5664);

    g_rx_atomics.nr_style                = reinterpret_cast<volatile long *>(base + 0x2ea0f4);
    g_rx_atomics.nr_passes               = reinterpret_cast<volatile long *>(base + 0x2e55f0);
    g_rx_atomics.nr_look_upsample        = reinterpret_cast<volatile long *>(base + 0x2ea138);
    g_rx_atomics.nr_detail_stability     = reinterpret_cast<volatile long *>(base + 0x2ea13c);

    g_rx_atomics.nr_skin_independent     = base + 0x2e55e0;
    g_rx_atomics.nr_follow_input_res     = base + 0x2ea208;
    g_rx_atomics.nr_look_mode            = base + 0x2ea11a;
    g_rx_atomics.valid = true;
    return true;
}

void apply_tuner_to_renodx_memory() {
    if (!ensure_renodx_atomics_bound()) return;
    _InterlockedExchange(g_rx_atomics.nr_passes, 1);
    _InterlockedExchange(g_rx_atomics.nr_style, g_tuner.nr_style);
    _InterlockedExchange(g_rx_atomics.nr_look_upsample, 1);
    _InterlockedExchange(g_rx_atomics.nr_detail_stability, 0);

    store_atomic_float(g_rx_atomics.nr_intensity_bits, g_tuner.intensity);
    store_atomic_float(g_rx_atomics.nr_local_structure_bits, g_tuner.structure);
    store_atomic_float(g_rx_atomics.nr_local_tone_bits, g_tuner.local_tone);
    store_atomic_float(g_rx_atomics.nr_res_scale_bits, static_cast<float>(g_tuner.work_res) / 100.0f);
    store_atomic_float(g_rx_atomics.nr_look_strength_bits, 1.0f);
    store_atomic_float(g_rx_atomics.nr_look_detail_bits, g_tuner.detail_boost);
    store_atomic_float(g_rx_atomics.nr_look_tone_bits, g_tuner.tone_boost);
    store_atomic_float(g_rx_atomics.nr_look_colour_bits, g_tuner.color_boost);

    store_atomic_bool(g_rx_atomics.nr_skin_independent, g_tuner.structure <= 1.001f);
    store_atomic_bool(g_rx_atomics.nr_follow_input_res, false);
    store_atomic_bool(g_rx_atomics.nr_look_mode, g_tuner.look_enabled);
}

int detect_tuner_preset();

void sync_tuner_from_renodx_memory() {
    if (!ensure_renodx_atomics_bound()) return;
    float fv = load_atomic_float(g_rx_atomics.nr_intensity_bits, g_tuner.intensity);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.intensity = fv;
    fv = load_atomic_float(g_rx_atomics.nr_local_structure_bits, g_tuner.structure);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.structure = fv;
    fv = load_atomic_float(g_rx_atomics.nr_local_tone_bits, g_tuner.local_tone);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.local_tone = fv;
    fv = load_atomic_float(g_rx_atomics.nr_look_detail_bits, g_tuner.detail_boost);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.detail_boost = fv;
    fv = load_atomic_float(g_rx_atomics.nr_look_tone_bits, g_tuner.tone_boost);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.tone_boost = fv;
    fv = load_atomic_float(g_rx_atomics.nr_look_colour_bits, g_tuner.color_boost);
    if (fv >= 0.4f && fv <= 2.0f) g_tuner.color_boost = fv;
    fv = load_atomic_float(g_rx_atomics.nr_res_scale_bits, static_cast<float>(g_tuner.work_res) / 100.0f);
    if (fv >= 0.45f && fv <= 1.05f) {
        g_tuner.work_res = static_cast<int>(std::lround(fv * 100.0f));
    }
    const long st = _InterlockedCompareExchange(g_rx_atomics.nr_style, 0, 0);
    if (st >= 0 && st <= 2) g_tuner.nr_style = static_cast<int>(st);
    g_tuner.look_enabled = load_atomic_bool(g_rx_atomics.nr_look_mode, g_tuner.look_enabled);
    g_tuner.preset_idx = detect_tuner_preset();
}
#endif

int detect_tuner_preset() {
    auto nearf = [](float a, float b) { return std::fabs(a - b) <= 0.035f; };
    if (nearf(g_tuner.intensity, 1.35f) && nearf(g_tuner.structure, 1.30f) && g_tuner.look_enabled && nearf(g_tuner.detail_boost, 1.35f) && std::abs(g_tuner.work_res - 75) <= 2) return 0;
    if (nearf(g_tuner.intensity, 1.30f) && nearf(g_tuner.structure, 1.25f) && g_tuner.look_enabled && nearf(g_tuner.detail_boost, 1.40f) && std::abs(g_tuner.work_res - 67) <= 2) return 1;
    if (nearf(g_tuner.intensity, 1.55f) && nearf(g_tuner.structure, 1.45f) && g_tuner.look_enabled && nearf(g_tuner.detail_boost, 1.45f) && std::abs(g_tuner.work_res - 100) <= 2) return 2;
    if (nearf(g_tuner.intensity, 1.00f) && nearf(g_tuner.structure, 1.00f) && !g_tuner.look_enabled) return 3;
    return 4;
}

void reload_tuner_from_disk(bool sync_memory = false) {
    float fv = 0.0f;
    std::string ini = read_utf8_file_w(g_consumer_ini_w);
    if (!ini.empty()) {
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRIntensity"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.intensity = fv;
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRLocalStructure"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.structure = fv;
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRLocalTone"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.local_tone = fv;
        std::string lm = ini_get_str(ini, "RenoDX.DLSS5", "NRLookMode");
        if (!lm.empty()) g_tuner.look_enabled = (lm == "1" || iequals_ascii(lm, "true"));
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRLookDetail"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.detail_boost = fv;
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRLookTone"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.tone_boost = fv;
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRLookColour"), &fv) && fv >= 0.4f && fv <= 2.0f) g_tuner.color_boost = fv;
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRStyle"), &fv) && fv >= 0.0f && fv <= 2.0f) g_tuner.nr_style = static_cast<int>(fv);
        if (parse_float_safe(ini_get_str(ini, "RenoDX.DLSS5", "NRResolutionScale"), &fv) && fv >= 0.45f && fv <= 1.05f) {
            g_tuner.work_res = static_cast<int>(std::lround(fv * 100.0f));
        }
    }

    g_tuner.has_feeder_cfg = file_exists_w(g_feed_cfg_w);
    if (g_tuner.has_feeder_cfg) {
        std::string cfg = read_utf8_file_w(g_feed_cfg_w);
        if (!cfg.empty()) {
            if (ini.empty() && parse_float_safe(ini_get_str(cfg, "", "work_resolution"), &fv) && fv >= 50.0f && fv <= 100.0f) {
                g_tuner.work_res = static_cast<int>(std::lround(fv));
            }
            if (parse_float_safe(ini_get_str(cfg, "", "work_upscale"), &fv) && fv >= 0.0f && fv <= 2.0f) {
                g_tuner.work_upscale = static_cast<int>(std::lround(fv));
            }
            if (parse_float_safe(ini_get_str(cfg, "", "work_sharpness"), &fv) && fv >= 0.0f && fv <= 1.0f) {
                g_tuner.sharpness = fv;
            }
            if (parse_float_safe(ini_get_str(cfg, "", "hold_strength"), &fv) && fv >= 0.0f && fv <= 1.0f) {
                g_tuner.hold_strength = fv;
            }
        }
    }

    g_tuner.preset_idx = detect_tuner_preset();
    get_file_mtime_w(g_consumer_ini_w, &g_last_ini_mtime);
#ifdef _WIN64
    if (sync_memory && !ini.empty()) {
        apply_tuner_to_renodx_memory();
    }
#else
    (void)sync_memory;
#endif
}

void init_singlepass_tuner() {
    if (g_tuner.initialized) return;
    g_tuner.initialized = true;

    wchar_t buf[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, buf, MAX_PATH)) return;
    wchar_t lower[MAX_PATH] = {};
    wcscpy_s(lower, buf);
    _wcslwr_s(lower, MAX_PATH);
    g_tuner.is_host64 = (wcsstr(lower, L"dlss5-feed-host64") != nullptr);

    std::wstring full(buf);
    size_t slash = full.find_last_of(L"\\/");
    g_exe_dir_w = (slash != std::wstring::npos) ? full.substr(0, slash) : L".";

#ifdef _WIN64
    g_consumer_ini_w = g_exe_dir_w + L"\\ReShade.ini";
    if (g_tuner.is_host64) {
        size_t parent_slash = g_exe_dir_w.find_last_of(L"\\/");
        std::wstring parent_dir = (parent_slash != std::wstring::npos) ? g_exe_dir_w.substr(0, parent_slash) : g_exe_dir_w;
        g_feed_cfg_w = parent_dir + L"\\dlss5-feed.cfg";
    } else {
        g_feed_cfg_w = g_exe_dir_w + L"\\dlss5-feed.cfg";
    }
#else
    g_consumer_ini_w = g_exe_dir_w + L"\\host64\\ReShade.ini";
    g_feed_cfg_w = g_exe_dir_w + L"\\dlss5-feed.cfg";
#endif
    reload_tuner_from_disk(false);
}

void persist_tuner_to_disk() {
    char num[32] = {};
#ifdef _WIN64
    if (!g_tuner.is_host64) {
        // 64 位原生进程直接通过 ReShade 官方配置接口写入内存缓存并落盘，避免关闭 Home 菜单时被 ReShade 旧缓存回写覆盖
        reshade::set_config_value(nullptr, "RenoDX DLSS", "NRPasses", "1");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "ConfigVersion", "7");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NeuralUplift", "1");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRPasses", "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.intensity);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRIntensity", static_cast<const char *>(num));
        snprintf(num, sizeof(num), "%.2f", g_tuner.structure);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLocalStructure", static_cast<const char *>(num));
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRSkinIndependent", g_tuner.structure > 1.001f ? "0" : "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.local_tone);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLocalTone", static_cast<const char *>(num));
        snprintf(num, sizeof(num), "%d", g_tuner.nr_style);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRStyle", static_cast<const char *>(num));
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookMode", g_tuner.look_enabled ? "1" : "0");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookStrength", "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.detail_boost);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookDetail", static_cast<const char *>(num));
        snprintf(num, sizeof(num), "%.2f", g_tuner.tone_boost);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookTone", static_cast<const char *>(num));
        snprintf(num, sizeof(num), "%.2f", g_tuner.color_boost);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookColour", static_cast<const char *>(num));
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRDetailStability", "0");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRLookUpsample", "1");
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRFollowInputRes", "0");
        snprintf(num, sizeof(num), "%.2f", static_cast<float>(g_tuner.work_res) / 100.0f);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRResolutionScale", static_cast<const char *>(num));
        const int worksets = g_tuner.work_res <= 68 ? 2 : (g_tuner.work_res <= 80 ? 3 : 6);
        snprintf(num, sizeof(num), "%d", worksets);
        reshade::set_config_value(nullptr, "RenoDX.DLSS5", "NRMaxWorksets", static_cast<const char *>(num));
    } else
#endif
    if (!g_consumer_ini_w.empty()) {
        std::string ini = read_utf8_file_w(g_consumer_ini_w);
        ini_set_kv(ini, "RenoDX DLSS", "NRPasses", "1");
        ini_set_kv(ini, "RenoDX.DLSS5", "ConfigVersion", "7");
        ini_set_kv(ini, "RenoDX.DLSS5", "NeuralUplift", "1");
        ini_set_kv(ini, "RenoDX.DLSS5", "NRPasses", "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.intensity);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRIntensity", num);
        snprintf(num, sizeof(num), "%.2f", g_tuner.structure);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLocalStructure", num);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRSkinIndependent", g_tuner.structure > 1.001f ? "0" : "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.local_tone);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLocalTone", num);
        snprintf(num, sizeof(num), "%d", g_tuner.nr_style);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRStyle", num);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookMode", g_tuner.look_enabled ? "1" : "0");
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookStrength", "1");
        snprintf(num, sizeof(num), "%.2f", g_tuner.detail_boost);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookDetail", num);
        snprintf(num, sizeof(num), "%.2f", g_tuner.tone_boost);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookTone", num);
        snprintf(num, sizeof(num), "%.2f", g_tuner.color_boost);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookColour", num);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRDetailStability", "0");
        ini_set_kv(ini, "RenoDX.DLSS5", "NRLookUpsample", "1");
        ini_set_kv(ini, "RenoDX.DLSS5", "NRFollowInputRes", "0");
        snprintf(num, sizeof(num), "%.2f", static_cast<float>(g_tuner.work_res) / 100.0f);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRResolutionScale", num);
        const int worksets = g_tuner.work_res <= 68 ? 2 : (g_tuner.work_res <= 80 ? 3 : 6);
        snprintf(num, sizeof(num), "%d", worksets);
        ini_set_kv(ini, "RenoDX.DLSS5", "NRMaxWorksets", num);
        write_utf8_atomic_w(g_consumer_ini_w, ini);
        get_file_mtime_w(g_consumer_ini_w, &g_last_ini_mtime);
    }

    if (g_tuner.has_feeder_cfg || file_exists_w(g_feed_cfg_w)) {
        g_tuner.has_feeder_cfg = true;
        std::string cfg = read_utf8_file_w(g_feed_cfg_w);
        snprintf(num, sizeof(num), "%d", g_tuner.work_res);
        ini_set_kv(cfg, "", "work_resolution", num);
        snprintf(num, sizeof(num), "%d", g_tuner.work_upscale);
        ini_set_kv(cfg, "", "work_upscale", num);
        snprintf(num, sizeof(num), "%.2f", g_tuner.sharpness);
        ini_set_kv(cfg, "", "work_sharpness", num);
        snprintf(num, sizeof(num), "%.2f", g_tuner.hold_strength);
        ini_set_kv(cfg, "", "hold_strength", num);
        ini_set_kv(cfg, "", "hold_tolerance", "0.05");
        write_utf8_atomic_w(g_feed_cfg_w, cfg);
    }
}

void apply_tuner_preset(int idx) {
    g_tuner.preset_idx = idx;
    if (idx == 0) { // 单层强效·省卡推荐
        g_tuner.intensity = 1.35f;
        g_tuner.structure = 1.30f;
        g_tuner.local_tone = 1.22f;
        g_tuner.look_enabled = true;
        g_tuner.detail_boost = 1.35f;
        g_tuner.tone_boost = 1.15f;
        g_tuner.color_boost = 1.08f;
        g_tuner.nr_style = 1;
        g_tuner.work_res = 75;
        g_tuner.work_upscale = 1;
        g_tuner.sharpness = 0.35f;
        g_tuner.hold_strength = 0.30f;
    } else if (idx == 1) { // 极致省卡·高帧优先
        g_tuner.intensity = 1.30f;
        g_tuner.structure = 1.25f;
        g_tuner.local_tone = 1.18f;
        g_tuner.look_enabled = true;
        g_tuner.detail_boost = 1.40f;
        g_tuner.tone_boost = 1.12f;
        g_tuner.color_boost = 1.06f;
        g_tuner.nr_style = 1;
        g_tuner.work_res = 67;
        g_tuner.work_upscale = 1;
        g_tuner.sharpness = 0.45f;
        g_tuner.hold_strength = 0.40f;
    } else if (idx == 2) { // 单层满血·极限质感
        g_tuner.intensity = 1.55f;
        g_tuner.structure = 1.45f;
        g_tuner.local_tone = 1.35f;
        g_tuner.look_enabled = true;
        g_tuner.detail_boost = 1.45f;
        g_tuner.tone_boost = 1.22f;
        g_tuner.color_boost = 1.12f;
        g_tuner.nr_style = 1;
        g_tuner.work_res = 100;
        g_tuner.work_upscale = 2;
        g_tuner.sharpness = 0.28f;
        g_tuner.hold_strength = 0.25f;
    } else if (idx == 3) { // 原厂标准 1.0x
        g_tuner.intensity = 1.00f;
        g_tuner.structure = 1.00f;
        g_tuner.local_tone = 1.00f;
        g_tuner.look_enabled = false;
        g_tuner.detail_boost = 1.00f;
        g_tuner.tone_boost = 1.00f;
        g_tuner.color_boost = 1.00f;
        g_tuner.nr_style = 0;
        g_tuner.work_res = 75;
        g_tuner.work_upscale = 1;
        g_tuner.sharpness = 0.15f;
        g_tuner.hold_strength = 0.00f;
    }
#ifdef _WIN64
    apply_tuner_to_renodx_memory();
#endif
    persist_tuner_to_disk();
}

// === 游戏内帧率 (FPS) · 显存用量 (VRAM) · 整体延迟 (Overall Latency) 实时性能监控小插件 ===
// 兼容全系 64 位 / 32 位游戏、NVIDIA / AMD / Intel 显卡，零鼠标拦截、零逐帧堆分配、严格遵守 MinGW/MSVC ImGui ABI 安全规范。

struct NvGpuMemoryInfoV2 {
    uint32_t version;
    uint32_t dedicatedVideoMemory;
    uint32_t availableDedicatedVideoMemory;
    uint32_t systemVideoMemory;
    uint32_t sharedSystemMemory;
    uint32_t curAvailableDedicatedVideoMemory;
};

#pragma pack(push, 8)
struct NvLatencyResultParams {
    uint32_t version;
    struct FrameReport {
        uint64_t frameID;
        uint64_t inputSampleTime;
        uint64_t simStartTime;
        uint64_t simEndTime;
        uint64_t renderSubmitStartTime;
        uint64_t renderSubmitEndTime;
        uint64_t presentStartTime;
        uint64_t presentEndTime;
        uint64_t driverStartTime;
        uint64_t driverEndTime;
        uint64_t osRenderQueueStartTime;
        uint64_t osRenderQueueEndTime;
        uint64_t gpuRenderStartTime;
        uint64_t gpuRenderEndTime;
        uint32_t gpuActiveRenderTimeUs;
        uint32_t gpuFrameTimeUs;
        uint8_t rsvd[120];
    } frameReport[64];
    uint8_t rsvd[32];
};
#pragma pack(pop)

static_assert(sizeof(NvLatencyResultParams) == 15400, "NvLatencyResultParams must match NVAPI 15400-byte layout");

using nvapi_query_fn = void *(__cdecl *)(uint32_t);
using nvapi_init_fn = int(__cdecl *)();
using nvapi_enum_gpus_fn = int(__cdecl *)(void *[64], uint32_t *);
using nvapi_get_mem_fn = int(__cdecl *)(void *, NvGpuMemoryInfoV2 *);
using nvapi_get_lat_fn = int(__cdecl *)(IUnknown *, NvLatencyResultParams *);
using create_dxgi_factory1_fn = HRESULT(WINAPI *)(REFIID, void **);

struct PerfHudState {
    bool cfg_loaded = false;
    bool hw_probed = false;
    bool logged_active = false;
    int mode = 1;   // 0: 关闭隐藏, 1: 精简监控条 (默认开启), 2: 详细监控卡
    int corner = 1; // 0: 左上角, 1: 右上角 (默认不遮挡 Home 菜单), 2: 左下角, 3: 右下角

    reshade::api::effect_runtime *active_runtime = nullptr;
    ULONGLONG active_runtime_tick = 0;

    int64_t qpc_freq = 0;
    int64_t prev_qpc = 0;
    int64_t qpc_history[8] = {};
    uint32_t qpc_head = 0;

    float dt_ring[120] = {};
    int dt_count = 0;
    int dt_head = 0;

    ULONGLONG last_ui_tick = 0;
    ULONGLONG last_vram_tick = 0;
    ULONGLONG last_pipe_tick = 0;

    uint32_t prev_dxgi_present_count = 0;
    int64_t prev_dxgi_qpc = 0;
    uint64_t prev_reflex_frame_id = 0;

    void *nv_gpu = nullptr;
    nvapi_get_mem_fn nv_get_mem = nullptr;
    nvapi_get_lat_fn nv_get_lat = nullptr;
    IDXGIAdapter3 *dxgi_adapter3 = nullptr;
    float dxgi_dedicated_gb = 0.0f;

    bool f7_was_down = false;
    bool dlss5_active = false;
    bool anr_active = false;
    bool mfg_active = false;

    int disp_fps = 0;
    int disp_low1_fps = 0;
    float disp_frame_ms = 0.0f;
    float vram_used_gb = 0.0f;
    float vram_total_gb = 0.0f;
    float vram_game_gb = 0.0f;
    int vram_pct = 0;
    float latency_ms = 0.0f;
    int latency_src = 2; // 0: Reflex, 1: DXGI, 2: 管线

    char fps_text[96] = "FPS --";
    char vram_text[96] = "\xe6\x98\xbe\xe5\xad\x98 -- / -- GB";
    char lat_text[96] = "\xe6\x95\xb4\xe4\xbd\x93\xe5\xbb\xb6\xe8\xbf\x9f -- ms";
    char detail_text[224] = {};
};

PerfHudState g_hud = {};
NvLatencyResultParams g_nv_lat_buf = {};

void save_hud_config() {
    char buf[16] = {};
    snprintf(buf, sizeof(buf), "%d", g_hud.mode);
    reshade::set_config_value(nullptr, "DLSS5Swapper.HUD", "Mode", static_cast<const char *>(buf));
    snprintf(buf, sizeof(buf), "%d", g_hud.corner);
    reshade::set_config_value(nullptr, "DLSS5Swapper.HUD", "Corner", static_cast<const char *>(buf));
    if (g_hud.mode > 0) {
        reshade::set_config_value(nullptr, "OVERLAY", "ShowFPS", "0");
        reshade::set_config_value(nullptr, "OVERLAY", "ShowFrameTime", "0");
    }
}

void load_hud_config() {
    if (g_hud.cfg_loaded) return;
    g_hud.cfg_loaded = true;

    init_singlepass_tuner();
    int m = g_hud.mode;
    int c = g_hud.corner;
    bool got_m = reshade::get_config_value(nullptr, "DLSS5Swapper.HUD", "Mode", m);
    bool got_c = reshade::get_config_value(nullptr, "DLSS5Swapper.HUD", "Corner", c);
    if (!got_m || !got_c) {
        const std::wstring local_ini = g_exe_dir_w + L"\\ReShade.ini";
        std::string ini = read_utf8_file_w(local_ini);
        float fv = 0.0f;
        if (!got_m && parse_float_safe(ini_get_str(ini, "DLSS5Swapper.HUD", "Mode"), &fv)) {
            m = static_cast<int>(std::lround(fv));
        }
        if (!got_c && parse_float_safe(ini_get_str(ini, "DLSS5Swapper.HUD", "Corner"), &fv)) {
            c = static_cast<int>(std::lround(fv));
        }
    }
    if (m < 0 || m > 2) m = 1;
    if (c < 0 || c > 3) c = 1;
    g_hud.mode = m;
    g_hud.corner = c;
    if (g_hud.mode > 0) {
        reshade::set_config_value(nullptr, "OVERLAY", "ShowFPS", "0");
        reshade::set_config_value(nullptr, "OVERLAY", "ShowFrameTime", "0");
    }
}

void ensure_hud_hw_interfaces() {
    if (g_hud.hw_probed) return;
    g_hud.hw_probed = true;

    LARGE_INTEGER freq = {};
    if (QueryPerformanceFrequency(&freq) && freq.QuadPart > 0) {
        g_hud.qpc_freq = freq.QuadPart;
    }

    wchar_t sys_dir[MAX_PATH] = {};
    const UINT sys_len = GetSystemDirectoryW(sys_dir, MAX_PATH);
    if (sys_len == 0 || sys_len >= MAX_PATH - 32) return;

    // 1. 从系统目录加载正版 NVIDIA NVAPI（避免游戏目录中第三方伪装 nvapi 干扰 AMD/Intel 显存读数）
    std::wstring nv_path(sys_dir);
#ifdef _WIN64
    nv_path += L"\\nvapi64.dll";
#else
    nv_path += L"\\nvapi.dll";
#endif
    HMODULE nv_mod = GetModuleHandleW(nv_path.c_str());
    if (!nv_mod && file_exists_w(nv_path)) {
        nv_mod = LoadLibraryW(nv_path.c_str());
    }
    if (nv_mod) {
        auto query = reinterpret_cast<nvapi_query_fn>(GetProcAddress(nv_mod, "nvapi_QueryInterface"));
        if (query) {
            auto nv_init = reinterpret_cast<nvapi_init_fn>(query(0x0150E828u));
            auto nv_enum = reinterpret_cast<nvapi_enum_gpus_fn>(query(0xE5AC921Fu));
            auto nv_mem = reinterpret_cast<nvapi_get_mem_fn>(query(0x07F9B368u));
            auto nv_lat = reinterpret_cast<nvapi_get_lat_fn>(query(0x1A587F9Cu));
            if (nv_init && nv_init() == 0) {
                g_hud.nv_get_lat = nv_lat;
                if (nv_enum && nv_mem) {
                    void *handles[64] = {};
                    uint32_t count = 0;
                    if (nv_enum(handles, &count) == 0 && count > 0) {
                        uint32_t best_kib = 0;
                        void *best_gpu = handles[0];
                        for (uint32_t i = 0; i < count && i < 8; ++i) {
                            NvGpuMemoryInfoV2 mi = {};
                            mi.version = static_cast<uint32_t>(sizeof(mi) | (2u << 16));
                            if (nv_mem(handles[i], &mi) == 0 && mi.dedicatedVideoMemory > best_kib) {
                                best_kib = mi.dedicatedVideoMemory;
                                best_gpu = handles[i];
                            }
                        }
                        g_hud.nv_gpu = best_gpu;
                        g_hud.nv_get_mem = nv_mem;
                    }
                }
            }
        }
    }

    // 2. 从 System32 加载系统原生 dxgi.dll（严禁直接 LoadLibraryW("dxgi.dll") 以免重入游戏目录代理 DLL）
    std::wstring dxgi_path(sys_dir);
    dxgi_path += L"\\dxgi.dll";
    HMODULE dxgi_mod = GetModuleHandleW(dxgi_path.c_str());
    if (!dxgi_mod) {
        dxgi_mod = LoadLibraryW(dxgi_path.c_str());
    }
    if (dxgi_mod) {
        auto create_fac = reinterpret_cast<create_dxgi_factory1_fn>(GetProcAddress(dxgi_mod, "CreateDXGIFactory1"));
        if (create_fac) {
            IDXGIFactory1 *fac = nullptr;
            if (SUCCEEDED(create_fac(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(&fac))) && fac) {
                SIZE_T best_vram = 0;
                IDXGIAdapter1 *best_adp = nullptr;
                for (UINT i = 0; i < 8; ++i) {
                    IDXGIAdapter1 *adp = nullptr;
                    if (fac->EnumAdapters1(i, &adp) == DXGI_ERROR_NOT_FOUND || !adp) break;
                    DXGI_ADAPTER_DESC1 desc = {};
                    if (SUCCEEDED(adp->GetDesc1(&desc)) && (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) {
                        if (desc.DedicatedVideoMemory >= best_vram) {
                            if (best_adp) best_adp->Release();
                            best_vram = desc.DedicatedVideoMemory;
                            best_adp = adp;
                            adp = nullptr;
                        }
                    }
                    if (adp) adp->Release();
                }
                if (best_adp) {
                    g_hud.dxgi_dedicated_gb = static_cast<float>(best_vram) / (1024.0f * 1024.0f * 1024.0f);
                    best_adp->QueryInterface(__uuidof(IDXGIAdapter3), reinterpret_cast<void **>(&g_hud.dxgi_adapter3));
                    best_adp->Release();
                }
                fac->Release();
            }
        }
    }
}

void cleanup_perf_hud() {
    if (g_hud.dxgi_adapter3) {
        g_hud.dxgi_adapter3->Release();
        g_hud.dxgi_adapter3 = nullptr;
    }
    g_hud.hw_probed = false;
    g_hud.active_runtime = nullptr;
}

void on_destroy_effect_runtime(reshade::api::effect_runtime *runtime) {
    if (g_hud.active_runtime == runtime) {
        g_hud.active_runtime = nullptr;
        g_hud.prev_qpc = 0;
    }
}

void poll_hud_vram(ULONGLONG now_tick) {
    if (now_tick - g_hud.last_vram_tick < 500 && g_hud.vram_total_gb > 0.1f) return;
    g_hud.last_vram_tick = now_tick;

    float proc_gb = 0.0f;
    float budget_gb = 0.0f;
    if (g_hud.dxgi_adapter3) {
        DXGI_QUERY_VIDEO_MEMORY_INFO vmi = {};
        if (SUCCEEDED(g_hud.dxgi_adapter3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &vmi))) {
            proc_gb = static_cast<float>(vmi.CurrentUsage) / (1024.0f * 1024.0f * 1024.0f);
            budget_gb = static_cast<float>(vmi.Budget) / (1024.0f * 1024.0f * 1024.0f);
        }
    }
    g_hud.vram_game_gb = proc_gb;

    bool used_nvapi = false;
    if (g_hud.nv_gpu && g_hud.nv_get_mem) {
        NvGpuMemoryInfoV2 mi = {};
        mi.version = static_cast<uint32_t>(sizeof(mi) | (2u << 16));
        if (g_hud.nv_get_mem(g_hud.nv_gpu, &mi) == 0 && mi.dedicatedVideoMemory > 0 &&
            mi.curAvailableDedicatedVideoMemory <= mi.dedicatedVideoMemory) {
            g_hud.vram_total_gb = static_cast<float>(mi.dedicatedVideoMemory) / (1024.0f * 1024.0f);
            g_hud.vram_used_gb = static_cast<float>(mi.dedicatedVideoMemory - mi.curAvailableDedicatedVideoMemory) / (1024.0f * 1024.0f);
            used_nvapi = true;
        }
    }
    if (!used_nvapi) {
        g_hud.vram_total_gb = g_hud.dxgi_dedicated_gb > 0.25f ? g_hud.dxgi_dedicated_gb : (budget_gb > 0.25f ? budget_gb : 8.0f);
        g_hud.vram_used_gb = proc_gb;
    }
    if (g_hud.vram_total_gb > 0.1f) {
        int pct = static_cast<int>(std::lround((g_hud.vram_used_gb / g_hud.vram_total_gb) * 100.0f));
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        g_hud.vram_pct = pct;
    }
}

void poll_hud_pipeline_flags(ULONGLONG now_tick) {
    if (now_tick - g_hud.last_pipe_tick < 1500) return;
    g_hud.last_pipe_tick = now_tick;

#ifdef _WIN64
    g_hud.dlss5_active =
        GetModuleHandleW(L"renodx-dlss5.addon64") != nullptr ||
        GetModuleHandleW(L"renodx-dlss.addon64") != nullptr ||
        GetModuleHandleW(L"dlss5-feed.addon64") != nullptr;
    g_hud.mfg_active =
        GetModuleHandleW(L"renodx-mfgunlock.addon64") != nullptr ||
        GetModuleHandleW(L"MFGUnlocker.asi") != nullptr;
    g_hud.anr_active = false;
    if (HMODULE dlssg_mod = GetModuleHandleW(L"nvngx_dlssg.dll")) {
        wchar_t mod_path[MAX_PATH] = {};
        if (GetModuleFileNameW(dlssg_mod, mod_path, MAX_PATH)) {
            _wcslwr_s(mod_path, MAX_PATH);
            if (wcsstr(mod_path, L"apex neural rendering")) {
                g_hud.anr_active = true;
            }
        }
    }
    if (!g_hud.anr_active && !g_exe_dir_w.empty()) {
        if (file_exists_w(g_exe_dir_w + L"\\OptiScaler\\custom\\Apex Neural Rendering FG\\dlssg\\nvngx_dlssg.dll")) {
            g_hud.anr_active = true;
        }
    }
#else
    g_hud.dlss5_active = GetModuleHandleW(L"dlss5-feed.addon32") != nullptr;
    g_hud.mfg_active = false;
    g_hud.anr_active = false;
#endif
}

void update_and_draw_perf_hud(reshade::api::effect_runtime *runtime) {
    init_singlepass_tuner();
    if (g_tuner.is_host64 || !runtime) return;

    const imgui_function_table *tbl = g_table_hooked ? &g_orig : imgui_function_table_instance();
    if (!tbl) return;

    const ImGuiIO &io = tbl->GetIO();
    const float disp_x = io.DisplaySize.x;
    const float disp_y = io.DisplaySize.y;
    if (disp_x < 320.0f || disp_y < 200.0f) return;

    load_hud_config();

    const ULONGLONG now_tick = GetTickCount64();
    if (g_hud.active_runtime != runtime) {
        if (g_hud.active_runtime == nullptr || (now_tick - g_hud.active_runtime_tick) > 1000) {
            g_hud.active_runtime = runtime;
            g_hud.prev_qpc = 0;
        } else {
            return;
        }
    }
    g_hud.active_runtime_tick = now_tick;

    // F7 快捷键边缘触发（仅当前游戏进程拥有前台焦点时响应，循环：精简监控条 -> 详细监控卡 -> 关闭隐藏）
    const bool f7_down = (GetAsyncKeyState(VK_F7) & 0x8000) != 0;
        if (f7_down && !g_hud.f7_was_down) {
        HWND fg = GetForegroundWindow();
        DWORD fg_pid = 0;
        if (fg && GetWindowThreadProcessId(fg, &fg_pid) && fg_pid == GetCurrentProcessId()) {
            if (g_hud.mode == 1) g_hud.mode = 2;
            else if (g_hud.mode == 2) g_hud.mode = 0;
            else g_hud.mode = 1;
            g_hud.last_ui_tick = 0;
            save_hud_config();
            char f7_log[128] = {};
            snprintf(
                f7_log,
                sizeof(f7_log),
                "DLSS 5 Swapper Enhanced: HUD monitor mode switched via F7 (mode=%d, corner=%d).",
                g_hud.mode,
                g_hud.corner);
            reshade::log::message(reshade::log::level::info, f7_log);
        }
    }
    g_hud.f7_was_down = f7_down;

    if (g_hud.mode <= 0) return;

    ensure_hud_hw_interfaces();
    if (g_hud.qpc_freq <= 0) return;

    // 逐帧高精度 QPC 采样（零堆分配、零 COM 调用）
    LARGE_INTEGER now_li = {};
    QueryPerformanceCounter(&now_li);
    const int64_t now_qpc = now_li.QuadPart;
    g_hud.qpc_history[g_hud.qpc_head & 7u] = now_qpc;
    ++g_hud.qpc_head;

    if (g_hud.prev_qpc > 0 && now_qpc > g_hud.prev_qpc) {
        const float dt_ms = static_cast<float>(static_cast<double>(now_qpc - g_hud.prev_qpc) * 1000.0 / static_cast<double>(g_hud.qpc_freq));
        if (dt_ms >= 0.15f && dt_ms <= 500.0f) {
            g_hud.dt_ring[g_hud.dt_head] = dt_ms;
            g_hud.dt_head = (g_hud.dt_head + 1) % 120;
            if (g_hud.dt_count < 120) ++g_hud.dt_count;
        }
    }
    g_hud.prev_qpc = now_qpc;

    // 每 300ms 更新一次统计数值、延迟采样与字符串缓冲，确保数字清晰稳定不闪烁
    if (now_tick - g_hud.last_ui_tick >= 300 || g_hud.disp_fps == 0) {
        g_hud.last_ui_tick = now_tick;
        poll_hud_vram(now_tick);
        poll_hud_pipeline_flags(now_tick);

        // 1. 计算平均帧率与 1% Low 帧率
        float avg_dt_ms = 16.67f;
        float low1_dt_ms = 16.67f;
        if (g_hud.dt_count > 0) {
            float sorted_dt[120];
            float sum_dt = 0.0f;
            for (int i = 0; i < g_hud.dt_count; ++i) {
                sorted_dt[i] = g_hud.dt_ring[i];
                sum_dt += sorted_dt[i];
            }
            avg_dt_ms = sum_dt / static_cast<float>(g_hud.dt_count);
            std::sort(sorted_dt, sorted_dt + g_hud.dt_count);
            int tail_n = g_hud.dt_count / 20;
            if (tail_n < 1) tail_n = 1;
            float tail_sum = 0.0f;
            for (int i = g_hud.dt_count - tail_n; i < g_hud.dt_count; ++i) {
                tail_sum += sorted_dt[i];
            }
            low1_dt_ms = tail_sum / static_cast<float>(tail_n);
        }

        float overlay_fps = avg_dt_ms > 0.1f ? (1000.0f / avg_dt_ms) : 0.0f;
        float dxgi_fps = 0.0f;
        float dxgi_queue_ms = -1.0f;

        // 2. 瞬态查询 DXGI SwapChain 帧统计（不跨帧持有引用，100% 兼容全屏切换与分辨率变更）
        reshade::api::device *dev = runtime->get_device();
        const reshade::api::device_api api = dev ? dev->get_api() : reshade::api::device_api::d3d12;
        if (api == reshade::api::device_api::d3d10 ||
            api == reshade::api::device_api::d3d11 ||
            api == reshade::api::device_api::d3d12) {
            auto *sc_unk = reinterpret_cast<IUnknown *>(static_cast<uintptr_t>(runtime->get_native()));
            IDXGISwapChain *sc = nullptr;
            if (sc_unk && SUCCEEDED(sc_unk->QueryInterface(__uuidof(IDXGISwapChain), reinterpret_cast<void **>(&sc))) && sc) {
                UINT last_id = 0;
                DXGI_FRAME_STATISTICS stats = {};
                const bool ok_last = SUCCEEDED(sc->GetLastPresentCount(&last_id));
                const bool ok_stat = SUCCEEDED(sc->GetFrameStatistics(&stats));
                sc->Release();

                if (ok_stat && stats.PresentCount > 0) {
                    if (g_hud.prev_dxgi_present_count > 0 &&
                        stats.PresentCount > g_hud.prev_dxgi_present_count &&
                        now_qpc > g_hud.prev_dxgi_qpc) {
                        const double elapsed_s = static_cast<double>(now_qpc - g_hud.prev_dxgi_qpc) / static_cast<double>(g_hud.qpc_freq);
                        if (elapsed_s >= 0.10 && elapsed_s <= 3.0) {
                            dxgi_fps = static_cast<float>(static_cast<double>(stats.PresentCount - g_hud.prev_dxgi_present_count) / elapsed_s);
                        }
                    }
                    if (ok_last && last_id >= stats.PresentCount && (last_id - stats.PresentCount) <= 5 &&
                        stats.SyncQPCTime.QuadPart > 0 && g_hud.qpc_head >= 2) {
                        const uint32_t lag = last_id - stats.PresentCount;
                        if (lag + 1 <= g_hud.qpc_head) {
                            const int64_t sub_qpc = g_hud.qpc_history[(g_hud.qpc_head - 1u - lag) & 7u];
                            if (sub_qpc > 0 && stats.SyncQPCTime.QuadPart >= sub_qpc) {
                                const float q_ms = static_cast<float>(static_cast<double>(stats.SyncQPCTime.QuadPart - sub_qpc) * 1000.0 / static_cast<double>(g_hud.qpc_freq));
                                if (q_ms >= 0.05f && q_ms <= 180.0f && stats.PresentCount != g_hud.prev_dxgi_present_count) {
                                    dxgi_queue_ms = q_ms;
                                }
                            }
                        }
                    }
                    g_hud.prev_dxgi_present_count = stats.PresentCount;
                    g_hud.prev_dxgi_qpc = now_qpc;
                }
            }
        }

        float final_fps = overlay_fps;
        float fps_scale = 1.0f;
        if (dxgi_fps > overlay_fps * 1.35f && dxgi_fps < 1000.0f && overlay_fps > 1.0f) {
            final_fps = dxgi_fps;
            fps_scale = dxgi_fps / overlay_fps;
        }
        g_hud.disp_fps = static_cast<int>(std::lround(final_fps));
        g_hud.disp_frame_ms = final_fps > 0.1f ? (1000.0f / final_fps) : avg_dt_ms;
        const float scaled_low1 = (low1_dt_ms > 0.1f ? (1000.0f / low1_dt_ms) : final_fps) * fps_scale;
        g_hud.disp_low1_fps = static_cast<int>(std::lround(scaled_low1 > final_fps ? final_fps : scaled_low1));

        // 3. 三级精度整体延迟采样：Tier 1 (NVAPI Reflex 硬件级) -> Tier 2 (DXGI 扫描队列) -> Tier 3 (渲染管线模型)
        float raw_lat_ms = -1.0f;
        int lat_src = 2;

        if (g_hud.nv_get_lat && dev &&
            (api == reshade::api::device_api::d3d11 || api == reshade::api::device_api::d3d12)) {
            auto *dev_unk = reinterpret_cast<IUnknown *>(static_cast<uintptr_t>(dev->get_native()));
            if (dev_unk) {
                memset(&g_nv_lat_buf, 0, sizeof(g_nv_lat_buf));
                g_nv_lat_buf.version = static_cast<uint32_t>(sizeof(g_nv_lat_buf) | (1u << 16));
                if (g_hud.nv_get_lat(dev_unk, &g_nv_lat_buf) == 0) {
                    uint64_t max_fid = 0;
                    int best_idx = -1;
                    for (int i = 0; i < 64; ++i) {
                        if (g_nv_lat_buf.frameReport[i].frameID > max_fid &&
                            g_nv_lat_buf.frameReport[i].gpuRenderEndTime > 0) {
                            max_fid = g_nv_lat_buf.frameReport[i].frameID;
                            best_idx = i;
                        }
                    }
                    if (best_idx >= 0 && max_fid > g_hud.prev_reflex_frame_id) {
                        g_hud.prev_reflex_frame_id = max_fid;
                        const auto &rep = g_nv_lat_buf.frameReport[best_idx];
                        uint64_t start_t = rep.inputSampleTime > 0 ? rep.inputSampleTime : rep.simStartTime;
                        if (start_t > 0 && rep.gpuRenderEndTime > start_t) {
                            const uint64_t diff_us = rep.gpuRenderEndTime - start_t;
                            if (diff_us >= 500ULL && diff_us <= 300000ULL) {
                                raw_lat_ms = static_cast<float>(diff_us) / 1000.0f;
                                lat_src = 0;
                            }
                        }
                    }
                }
            }
        }

        if (raw_lat_ms < 0.0f && dxgi_queue_ms >= 0.0f) {
            raw_lat_ms = g_hud.disp_frame_ms + dxgi_queue_ms;
            lat_src = 1;
        }
        if (raw_lat_ms < 0.0f) {
            const float queue_factor = (g_hud.anr_active || g_hud.mfg_active) ? 2.15f : 1.65f;
            raw_lat_ms = g_hud.disp_frame_ms * queue_factor;
            lat_src = 2;
        }
        if (raw_lat_ms < 1.0f) raw_lat_ms = 1.0f;
        if (raw_lat_ms > 250.0f) raw_lat_ms = 250.0f;

        g_hud.latency_ms = (g_hud.latency_ms <= 0.01f)
            ? raw_lat_ms
            : (g_hud.latency_ms * 0.65f + raw_lat_ms * 0.35f);
        g_hud.latency_src = lat_src;

        // 4. 格式化输出文本缓冲
        if (g_hud.mode == 2) {
            snprintf(
                g_hud.fps_text,
                sizeof(g_hud.fps_text),
                "FPS %d (%.1f ms \xc2\xb7 1%%L %d)",
                g_hud.disp_fps,
                g_hud.disp_frame_ms,
                g_hud.disp_low1_fps);
        } else {
            snprintf(
                g_hud.fps_text,
                sizeof(g_hud.fps_text),
                "FPS %d (1%%L %d)",
                g_hud.disp_fps,
                g_hud.disp_low1_fps);
        }
        snprintf(
            g_hud.vram_text,
            sizeof(g_hud.vram_text),
            "\xe6\x98\xbe\xe5\xad\x98 %.2f / %.1f GB (%d%%)",
            g_hud.vram_used_gb,
            g_hud.vram_total_gb,
            g_hud.vram_pct);
        snprintf(
            g_hud.lat_text,
            sizeof(g_hud.lat_text),
            "\xe6\x95\xb4\xe4\xbd\x93\xe5\xbb\xb6\xe8\xbf\x9f %.1f ms",
            g_hud.latency_ms);

        if (g_hud.mode == 2) {
            const char *pipe_label = "\xe5\xae\x9e\xe6\x97\xb6\xe6\x80\xa7\xe8\x83\xbd\xe7\x9b\x91\xe6\x8e\xa7";
            if (g_hud.dlss5_active && g_hud.anr_active) pipe_label = "DLSS 5 + ANR\xe8\xa1\xa5\xe5\xb8\xa7";
            else if (g_hud.dlss5_active && g_hud.mfg_active) pipe_label = "DLSS 5 + \xe5\x8e\x9f\xe7\x94\x9fMFG";
            else if (g_hud.dlss5_active) pipe_label = "DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93";
            else if (g_hud.anr_active) pipe_label = "ANR \xe7\x9c\x81\xe6\x98\xbe\xe5\xad\x98\xe8\xa1\xa5\xe5\xb8\xa7";
            else if (g_hud.mfg_active) pipe_label = "NVIDIA MFG\xe8\xa1\xa5\xe5\xb8\xa7";

            const char *src_label = (g_hud.latency_src == 0)
                ? "Reflex\xe7\xa1\xac\xe4\xbb\xb6"
                : (g_hud.latency_src == 1 ? "DXGI\xe9\x98\x9f\xe5\x88\x97" : "\xe6\xb8\xb2\xe6\x9f\x93\xe7\xae\xa1\xe7\xba\xbf");

            snprintf(
                g_hud.detail_text,
                sizeof(g_hud.detail_text),
                "[%s]  \xe6\xb8\xb8\xe6\x88\x8f\xe6\x98\xbe\xe5\xad\x98 %.2f GB  |  \xe5\xbb\xb6\xe8\xbf\x9f\xe6\xba\x90: %s  |  F7 \xe5\x88\x87\xe6\x8d\xa2/\xe9\x9a\x90\xe8\x97\x8f",
                pipe_label,
                g_hud.vram_game_gb,
                src_label);
        }

        if (!g_hud.logged_active && g_hud.dt_count >= 12 && g_hud.disp_fps > 0) {
            g_hud.logged_active = true;
            char log_buf[256] = {};
            snprintf(
                log_buf,
                sizeof(log_buf),
                "DLSS 5 Swapper Enhanced: In-game HUD monitor active (FPS=%d, VRAM=%.2f/%.1f GB, Latency=%.1f ms [src=%d]).",
                g_hud.disp_fps,
                g_hud.vram_used_gb,
                g_hud.vram_total_gb,
                g_hud.latency_ms,
                g_hud.latency_src);
            reshade::log::message(reshade::log::level::info, log_buf);
        }
    }

    // 5. 纯标量/常引用 ABI 安全绘制半透明毛玻璃监控浮窗（NoInputs 绝不拦截游戏鼠标键盘）
    const float margin = 14.0f;
    float pos_x = disp_x - margin;
    float pos_y = margin;
    float piv_x = 1.0f;
    float piv_y = 0.0f;
    if (g_hud.corner == 0) {
        pos_x = margin; pos_y = margin; piv_x = 0.0f; piv_y = 0.0f;
    } else if (g_hud.corner == 2) {
        pos_x = margin; pos_y = disp_y - margin; piv_x = 0.0f; piv_y = 1.0f;
    } else if (g_hud.corner == 3) {
        pos_x = disp_x - margin; pos_y = disp_y - margin; piv_x = 1.0f; piv_y = 1.0f;
    }

    const ImVec2 win_pos(pos_x, pos_y);
    const ImVec2 win_pivot(piv_x, piv_y);
    const ImVec2 win_pad(11.0f, 6.0f);
    tbl->SetNextWindowPos(win_pos, ImGuiCond_Always, win_pivot);
    tbl->SetNextWindowBgAlpha(0.74f);
    tbl->PushStyleVar(ImGuiStyleVar_WindowRounding, 7.0f);
    tbl->PushStyleVar(ImGuiStyleVar_WindowBorderSize, 1.0f);
    tbl->PushStyleVar2(ImGuiStyleVar_WindowPadding, win_pad);
    tbl->PushStyleColor2(ImGuiCol_WindowBg, ImVec4(0.06f, 0.08f, 0.11f, 0.84f));
    tbl->PushStyleColor2(ImGuiCol_Border, ImVec4(0.35f, 0.82f, 0.30f, 0.45f));

    const ImGuiWindowFlags hud_flags =
        ImGuiWindowFlags_NoTitleBar |
        ImGuiWindowFlags_NoResize |
        ImGuiWindowFlags_AlwaysAutoResize |
        ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoFocusOnAppearing |
        ImGuiWindowFlags_NoNav |
        ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoInputs;

    if (tbl->Begin("##ENH_PerfMonitorHUD", nullptr, hud_flags)) {
        const ImVec4 fps_col = g_hud.disp_fps >= 60
            ? ImVec4(0.46f, 0.96f, 0.36f, 1.0f)
            : (g_hud.disp_fps >= 35 ? ImVec4(0.98f, 0.82f, 0.28f, 1.0f) : ImVec4(0.98f, 0.42f, 0.38f, 1.0f));
        const ImVec4 vram_col = g_hud.vram_pct <= 78
            ? ImVec4(0.38f, 0.88f, 0.98f, 1.0f)
            : (g_hud.vram_pct <= 90 ? ImVec4(0.98f, 0.80f, 0.28f, 1.0f) : ImVec4(0.98f, 0.40f, 0.36f, 1.0f));
        const ImVec4 lat_col = g_hud.latency_ms <= 26.0f
            ? ImVec4(0.52f, 0.95f, 0.56f, 1.0f)
            : (g_hud.latency_ms <= 48.0f ? ImVec4(0.98f, 0.82f, 0.30f, 1.0f) : ImVec4(0.98f, 0.44f, 0.38f, 1.0f));
        const ImVec4 sep_col(0.52f, 0.58f, 0.66f, 0.85f);

        call_text_colored_v(tbl->TextColoredV, fps_col, "%s", g_hud.fps_text);
        tbl->SameLine(0.0f, 7.0f);
        call_text_colored_v(tbl->TextColoredV, sep_col, "%s", "|");
        tbl->SameLine(0.0f, 7.0f);
        call_text_colored_v(tbl->TextColoredV, vram_col, "%s", g_hud.vram_text);
        tbl->SameLine(0.0f, 7.0f);
        call_text_colored_v(tbl->TextColoredV, sep_col, "%s", "|");
        tbl->SameLine(0.0f, 7.0f);
        call_text_colored_v(tbl->TextColoredV, lat_col, "%s", g_hud.lat_text);

        if (g_hud.mode == 2 && g_hud.detail_text[0] != '\0') {
            call_text_colored_v(tbl->TextColoredV, ImVec4(0.76f, 0.82f, 0.88f, 0.92f), "%s", g_hud.detail_text);
        }
    }
    tbl->End();

    tbl->PopStyleColor(2);
    tbl->PopStyleVar(3);
}

void draw_hud_control_section(const imgui_function_table *tbl) {
    load_hud_config();
    call_text_colored_v(
        tbl->TextColoredV,
        ImVec4(0.38f, 0.88f, 0.98f, 1.0f),
        "%s",
        "\xe2\x97\x8f \xe6\xb8\xb8\xe6\x88\x8f\xe5\x86\x85\xe5\xae\x9e\xe6\x97\xb6\xe7\x9b\x91\xe6\x8e\xa7\xe5\xb0\x8f\xe6\x8f\x92\xe4\xbb\xb6 (\xe5\xb8\xa7\xe7\x8e\x87 \xc2\xb7 \xe6\x98\xbe\xe5\xad\x98 \xc2\xb7 \xe6\x95\xb4\xe4\xbd\x93\xe5\xbb\xb6\xe8\xbf\x9f | \xe5\xbf\xab\xe6\x8d\xb7\xe9\x94\xae F7)");

    const ImGuiStyle &style = tbl->GetStyle();
    const float avail_w = tbl->GetWindowWidth() - tbl->GetCursorPosX() - style.WindowPadding.x;
    const float third_w = avail_w > 240.0f ? (avail_w - style.ItemSpacing.x * 2.0f) / 3.0f : 0.0f;

    auto draw_mode_btn = [&](int mode_val, const char *label) {
        const bool active = (g_hud.mode == mode_val);
        if (active) {
            tbl->PushStyleColor2(ImGuiCol_Button, ImVec4(0.16f, 0.50f, 0.68f, 0.95f));
            tbl->PushStyleColor2(ImGuiCol_ButtonHovered, ImVec4(0.22f, 0.60f, 0.80f, 0.98f));
        }
        if (tbl->Button(label, ImVec2(third_w, 0.0f))) {
            g_hud.mode = mode_val;
            save_hud_config();
        }
        if (active) {
            tbl->PopStyleColor(2);
        }
    };

    draw_mode_btn(0, "\xe5\x85\xb3\xe9\x97\xad\xe9\x9a\x90\xe8\x97\x8f###enh_hud_m0");
    if (third_w > 0.0f) tbl->SameLine(0.0f, -1.0f);
    draw_mode_btn(1, "\xe7\xb2\xbe\xe7\xae\x80\xe7\x9b\x91\xe6\x8e\xa7\xe6\x9d\xa1###enh_hud_m1");
    if (third_w > 0.0f) tbl->SameLine(0.0f, -1.0f);
    draw_mode_btn(2, "\xe8\xaf\xa6\xe7\xbb\x86\xe7\x9b\x91\xe6\x8e\xa7\xe5\x8d\xa1###enh_hud_m2");

    static const char *kHudCorners[] = {
        "\xe5\xb7\xa6\xe4\xb8\x8a\xe8\xa7\x92 (Top-Left)",
        "\xe5\x8f\xb3\xe4\xb8\x8a\xe8\xa7\x92 (Top-Right \xc2\xb7 \xe6\x8e\xa8\xe8\x8d\x90\xe4\xb8\x8d\xe6\x8c\xa1\xe8\x8f\x9c\xe5\x8d\x95)",
        "\xe5\xb7\xa6\xe4\xb8\x8b\xe8\xa7\x92 (Bottom-Left)",
        "\xe5\x8f\xb3\xe4\xb8\x8b\xe8\xa7\x92 (Bottom-Right)"
    };
    if (tbl->Combo("\xe7\x9b\x91\xe6\x8e\xa7\xe6\x98\xbe\xe7\xa4\xba\xe4\xbd\x8d\xe7\xbd\xae###enh_hud_pos", &g_hud.corner, kHudCorners, 4, -1)) {
        save_hud_config();
    }
}

// 注意：跨 MinGW(x86_64-windows-gnu) 与 MSVC(ReShade64.dll) 调用 ImGui 函数表时，
// 严禁调用任何按值返回 ImVec2 / ImVec4 (带构造函数非聚合体) 的函数（如 GetContentRegionAvail），
// 否则 MSVC 期望 RCX 传入隐藏 sret 缓冲区指针而 MinGW 不传，会导致按 Home 键瞬间触发 0xC0000005 闪退！
// 下方全部使用标量(float/bool/int)或引用(ImGuiStyle&)返回接口，并直接走 g_orig 原始函数表避免重复进入翻译钩子。
void draw_singlepass_tuner_panel() {
    const imgui_function_table *tbl = g_table_hooked ? &g_orig : imgui_function_table_instance();
    if (!tbl) return;

    init_singlepass_tuner();
    draw_hud_control_section(tbl);
    tbl->Separator();

#ifdef _WIN64
    const bool has_dlss5_runtime =
        GetModuleHandleW(L"renodx-dlss5.addon64") != nullptr ||
        GetModuleHandleW(L"dlss5-feed.addon64") != nullptr;
    if (!has_dlss5_runtime) {
        call_text_colored_v(
            tbl->TextColoredV,
            ImVec4(0.75f, 0.80f, 0.86f, 0.92f),
            "%s",
            "\xe5\xbd\x93\xe5\x89\x8d\xe6\x9c\xaa\xe5\x90\xaf\xe7\x94\xa8 DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xef\xbc\x9b\xe6\x82\xa8\xe5\x8f\xaf\xe9\x9a\x8f\xe6\x97\xb6\xe6\x8c\x89 F7 \xe9\x94\xae\xe5\x88\x87\xe6\x8d\xa2\xe6\xb8\xb8\xe6\x88\x8f\xe5\x86\x85\xe5\xb8\xa7\xe7\x8e\x87/\xe6\x98\xbe\xe5\xad\x98/\xe5\xbb\xb6\xe8\xbf\x9f\xe7\x9b\x91\xe6\x8e\xa7\xe3\x80\x82");
        return;
    }
    if (!g_tuner.is_host64 && !tbl->IsAnyItemActive()) {
        sync_tuner_from_renodx_memory();
    }
#endif

    const float ratio = static_cast<float>(g_tuner.work_res) / 100.0f;
    int saved_pct = static_cast<int>(std::lround((1.0f - ratio * ratio) * 100.0f));
    if (saved_pct < 0) saved_pct = 0;
    const float gain =
        (g_tuner.intensity - 1.0f) * 0.42f +
        (g_tuner.structure - 1.0f) * 0.28f +
        (g_tuner.local_tone - 1.0f) * 0.15f +
        (g_tuner.look_enabled ? (g_tuner.detail_boost - 1.0f) * 0.25f + (g_tuner.tone_boost - 1.0f) * 0.10f : 0.0f) +
        (g_tuner.sharpness > 0.15f ? (g_tuner.sharpness - 0.15f) * 0.20f : 0.0f);
    const int boost_pct = static_cast<int>(std::lround(gain * 100.0f));

    char status_buf[256] = {};
    snprintf(
        status_buf,
        sizeof(status_buf),
        "\xe2\x97\x8f \xe9\x94\x81\xe5\xae\x9a 1 \xe5\xb1\x82\xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93 (NRPasses=1) | \xe8\xb4\xa8\xe6\x84\x9f\xe5\xbc\xba\xe5\x8c\x96: %+d%% | \xe5\x83\x8f\xe7\xb4\xa0\xe7\xae\x97\xe5\x8a\x9b: -%d%% (%d%%)",
        boost_pct, saved_pct, g_tuner.work_res);
    call_text_colored_v(tbl->TextColoredV, ImVec4(0.52f, 0.94f, 0.32f, 1.0f), "%s", status_buf);

    const ImGuiStyle &style = tbl->GetStyle();
    const float avail_w = tbl->GetWindowWidth() - tbl->GetCursorPosX() - style.WindowPadding.x;
    const float half_w = avail_w > 220.0f ? (avail_w - style.ItemSpacing.x) * 0.5f : 0.0f;

    auto draw_preset_btn = [&](int idx, const char *label) {
        const bool active = (g_tuner.preset_idx == idx);
        if (active) {
            tbl->PushStyleColor2(ImGuiCol_Button, ImVec4(0.24f, 0.56f, 0.12f, 0.92f));
            tbl->PushStyleColor2(ImGuiCol_ButtonHovered, ImVec4(0.30f, 0.66f, 0.16f, 0.98f));
        }
        if (tbl->Button(label, ImVec2(half_w, 0.0f))) {
            apply_tuner_preset(idx);
        }
        if (active) {
            tbl->PopStyleColor(2);
        }
    };

    draw_preset_btn(0, "[\xe6\x8e\xa8\xe8\x8d\x90] \xe5\x8d\x95\xe5\xb1\x82\xe5\xbc\xba\xe6\x95\x88\xc2\xb7\xe7\x9c\x81\xe5\x8d\xa1 (-44%)###enh_p0");
    if (half_w > 0.0f) tbl->SameLine(0.0f, -1.0f);
    draw_preset_btn(1, "[\xe7\x9c\x81\xe5\x8d\xa1] \xe6\x9e\x81\xe8\x87\xb4\xe7\x9c\x81\xe5\x8d\xa1\xc2\xb7\xe9\xab\x98\xe5\xb8\xa7 (-55%)###enh_p1");

    draw_preset_btn(2, "[\xe6\xbb\xa1\xe8\xa1\x80] \xe5\x8d\x95\xe5\xb1\x82\xe6\xbb\xa1\xe8\xa1\x80\xc2\xb7\xe6\x9e\x81\xe9\x99\x90 (100%)###enh_p2");
    if (half_w > 0.0f) tbl->SameLine(0.0f, -1.0f);
    draw_preset_btn(3, "[\xe5\x9f\xba\xe5\x87\x86] \xe5\x8e\x9f\xe5\x8e\x82\xe6\xa0\x87\xe5\x87\x86 1.0x###enh_p3");

    tbl->Spacing();
    bool mem_changed = false;
    bool disk_commit = false;

    if (tbl->SliderFloat("\xe6\x80\xbb\xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe5\xbc\xba\xe5\xba\xa6###enh_s_int", &g_tuner.intensity, 0.50f, 1.80f, "%.2fx", 0)) {
        g_tuner.preset_idx = 4;
        mem_changed = true;
    }
    if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

    if (tbl->SliderFloat("\xe5\xbe\xae\xe8\xa1\xa8\xe9\x9d\xa2\xe7\xbb\x93\xe6\x9e\x84\xe9\x87\x8d\xe5\xa1\x91###enh_s_str", &g_tuner.structure, 0.50f, 1.70f, "%.2fx", 0)) {
        g_tuner.preset_idx = 4;
        mem_changed = true;
    }
    if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

    if (tbl->SliderFloat("\xe7\xb2\xbe\xe7\xbb\x86\xe7\xbb\x86\xe8\x8a\x82\xe5\xa1\x91\xe5\xbd\xa2 (\xe9\x9b\xb6\xe8\x80\x97\xe6\x97\xb6)###enh_s_det", &g_tuner.detail_boost, 0.50f, 1.80f, "%.2fx", 0)) {
        g_tuner.preset_idx = 4;
        g_tuner.look_enabled = (std::fabs(g_tuner.detail_boost - 1.0f) > 0.01f) || (std::fabs(g_tuner.tone_boost - 1.0f) > 0.01f);
        mem_changed = true;
    }
    if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

    if (tbl->SliderFloat("\xe5\xb1\x80\xe9\x83\xa8\xe5\x85\x89\xe5\xbd\xb1\xe7\xab\x8b\xe4\xbd\x93\xe6\x84\x9f###enh_s_ton", &g_tuner.local_tone, 0.50f, 1.60f, "%.2fx", 0)) {
        g_tuner.preset_idx = 4;
        mem_changed = true;
    }
    if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

    if (tbl->SliderInt("\xe5\x86\x85\xe9\x83\xa8\xe5\xb7\xa5\xe4\xbd\x9c\xe5\x88\x86\xe8\xbe\xa8\xe7\x8e\x87 (\xe7\x9c\x81\xe5\x8d\xa1)###enh_s_res", &g_tuner.work_res, 50, 100, "%d%%", 0)) {
        g_tuner.preset_idx = 4;
        mem_changed = true;
    }
    if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

    static const char *kStyleItems[] = {
        "\xe5\x8e\x9f\xe7\x94\xbb\xe7\x9b\xb4\xe5\x87\xba (\xe5\xbf\xa0\xe5\xae\x9e\xe5\x8e\x9f\xe8\xb2\x8c)",
        "\xe8\x87\xaa\xe7\x84\xb6\xe8\xb4\xa8\xe6\x84\x9f (\xe7\xab\x8b\xe4\xbd\x93\xe6\x8e\xa8\xe8\x8d\x90)",
        "\xe7\x94\xb5\xe5\xbd\xb1\xe8\x83\xb6\xe7\x89\x87 (\xe9\xab\x98\xe5\x8f\x8d\xe5\xb7\xae\xe8\xb4\xa8\xe6\x84\x9f)"
    };
    if (tbl->Combo("\xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe7\x94\xbb\xe9\xa3\x8e\xe6\xa1\xa3\xe4\xbd\x8d###enh_c_sty", &g_tuner.nr_style, kStyleItems, 3, -1)) {
        g_tuner.preset_idx = 4;
        mem_changed = true;
        disk_commit = true;
    }

    if (g_tuner.has_feeder_cfg) {
        if (tbl->SliderFloat("\xe8\xb6\x85\xe5\x88\x86\xe8\xbe\xb9\xe7\xbc\x98\xe9\x94\x90\xe5\x8c\x96\xe8\xa1\xa5\xe5\x81\xbf###enh_s_shp", &g_tuner.sharpness, 0.00f, 0.80f, "%.2f", 0)) {
            g_tuner.preset_idx = 4;
        }
        if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

        if (tbl->SliderFloat("\xe9\x9d\x99\xe6\xad\xa2\xe7\x94\xbb\xe9\x9d\xa2\xe9\x98\xb2\xe6\x8a\x96\xe7\xa8\xb3\xe5\xae\x9a###enh_s_hld", &g_tuner.hold_strength, 0.00f, 0.80f, "%.2f", 0)) {
            g_tuner.preset_idx = 4;
        }
        if (tbl->IsItemDeactivatedAfterEdit()) disk_commit = true;

        static const char *kUpscaleItems[] = {
            "\xe5\x8f\x8c\xe7\xba\xbf\xe6\x80\xa7\xe6\x9e\x81\xe9\x80\x9f\xe6\x8f\x92\xe5\x80\xbc",
            "FSR1 \xe6\x9e\x81\xe9\x80\x9f\xe7\xa9\xba\xe9\x97\xb4\xe8\xb6\x85\xe5\x88\x86 (\xe6\x8e\xa8\xe8\x8d\x90\xe7\x9c\x81\xe5\x8d\xa1)",
            "DLSS SR \xe8\xb6\x85\xe5\x88\x86\xe5\x9b\x9e\xe6\x8b\x89"
        };
        if (tbl->Combo("\xe8\xb6\x85\xe5\x88\x86\xe5\x9b\x9e\xe6\x8b\x89\xe5\xbc\x95\xe6\x93\x8e###enh_c_up", &g_tuner.work_upscale, kUpscaleItems, 3, -1)) {
            g_tuner.preset_idx = 4;
            disk_commit = true;
        }
    }

#ifdef _WIN64
    if (mem_changed) {
        apply_tuner_to_renodx_memory();
    }
#else
    (void)mem_changed;
#endif
    if (disk_commit) {
        persist_tuner_to_disk();
    }
    static bool s_logged_first_draw = false;
    if (!s_logged_first_draw) {
        s_logged_first_draw = true;
        reshade::log::message(reshade::log::level::info, "DLSS 5 Swapper Enhanced: single-pass tuner panel rendered successfully.");
    }
}

// === ReShade 6.8.0.2155 内置 Generic Depth 与插件列表说明原位汉化 (64位专属) ===
#ifdef _WIN64

struct LeaPatch {
    uint32_t lea_rva;
    uint8_t op[3];
    int32_t orig_disp;
    const char *zh;
};

// 严格固定在 ReShade 6.8.0.2155 的指令特征
LeaPatch g_gd_patches[] = {
    { 0x31179, {0x48, 0x8d, 0x05}, 0x3eb128, "\xe9\xbb\x98\xe8\xae\xa4 (Default)" },
    { 0x31190, {0x48, 0x8d, 0x05}, 0x3eb119, "\xe9\xa1\xb6\xe7\x82\xb9\xe6\x95\xb0\xe4\xbc\x98\xe5\x85\x88" },
    { 0x311a5, {0x48, 0x8d, 0x05}, 0x3eb114, "\xe7\xbb\x98\xe5\x88\xb6\xe8\xb0\x83\xe7\x94\xa8\xe6\x95\xb0\xe4\xbc\x98\xe5\x85\x88" },
    { 0x311b8, {0x48, 0x8d, 0x0d}, 0x3eb119, "\xe7\xbb\x98\xe5\x88\xb6\xe7\xbb\x9f\xe8\xae\xa1\xe5\x90\xaf\xe5\x8f\x91\xe5\xbc\x8f\xe8\xa7\x84\xe5\x88\x99###Draw stats heuristic" },
    { 0x311f5, {0x48, 0x8d, 0x05}, 0x3eb0f4, "\xe6\x97\xa0 (\xe4\xb8\x8d\xe8\xbf\x87\xe6\xbb\xa4)" },
    { 0x3120c, {0x48, 0x8d, 0x05}, 0x3eb0e5, "\xe7\x9b\xb8\xe8\xbf\x91\xe5\xae\xbd\xe9\xab\x98\xe6\xaf\x94" },
    { 0x31224, {0x48, 0x8d, 0x05}, 0x3eb0e5, "\xe5\x88\x86\xe8\xbe\xa8\xe7\x8e\x87\xe6\x95\xb4\xe6\x95\xb0\xe5\x80\x8d (\xe9\x80\x82\xe7\x94\xa8\xe4\xba\x8e DLSS \xe6\x88\x96\xe5\x88\x86\xe8\xbe\xa8\xe7\x8e\x87\xe7\xbc\xa9\xe6\x94\xbe)" },
    { 0x3122f, {0x48, 0x8d, 0x0d}, 0x3eb162, "\xe5\xae\xbd\xe9\xab\x98\xe6\xaf\x94\xe5\x90\xaf\xe5\x8f\x91\xe5\xbc\x8f\xe8\xbf\x87\xe6\xbb\xa4###Aspect ratio heuristic" },
    { 0x31236, {0x48, 0x8d, 0x05}, 0x3eb113, "\xe7\xb2\xbe\xe7\xa1\xae\xe5\x8c\xb9\xe9\x85\x8d\xe6\xb8\xb8\xe6\x88\x8f\xe5\x88\x86\xe8\xbe\xa8\xe7\x8e\x87" },
    { 0x31241, {0x48, 0x8d, 0x05}, 0x3eb128, "\xe7\xb2\xbe\xe7\xa1\xae\xe5\x8c\xb9\xe9\x85\x8d\xe8\x87\xaa\xe5\xae\x9a\xe4\xb9\x89\xe5\xae\xbd\xe9\xab\x98" },
    { 0x3128f, {0x48, 0x8d, 0x0d}, 0x3eb11a, "\xe6\x8c\x87\xe5\xae\x9a\xe8\xbf\x87\xe6\xbb\xa4\xe5\xae\xbd\xe9\xab\x98\xe5\x83\x8f\xe7\xb4\xa0###Filter by width and height" },
    { 0x312d4, {0x48, 0x8d, 0x05}, 0x3eb0f1, "\xe5\x85\xa8\xe9\x83\xa8\xe6\xa0\xbc\xe5\xbc\x8f" },
    { 0x3130e, {0x48, 0x8d, 0x0d}, 0x3eb0bb, "\xe6\x8c\x89\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2\xe6\xa0\xbc\xe5\xbc\x8f\xe8\xbf\x87\xe6\xbb\xa4###Filter by depth buffer format" },
    { 0x3137d, {0x48, 0x8d, 0x0d}, 0x3eb06c, "\xe5\x9c\xa8\xe6\xb8\x85\xe7\xa9\xba\xe6\x93\x8d\xe4\xbd\x9c\xe5\x89\x8d\xe5\xa4\x8d\xe5\x88\xb6\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2###Copy depth buffer before clear operations" },
    { 0x313c8, {0x48, 0x8d, 0x0d}, 0x3eb051, "\xe5\xbd\x93\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2\xe4\xb8\xba\xe7\xa9\xba\xe9\xbb\x91\xe7\x94\xbb\xe9\x9d\xa2\xe6\x97\xb6\xe8\xaf\xb7\xe5\x8b\xbe\xe9\x80\x89\xe6\xad\xa4\xe9\xa1\xb9" },
    { 0x3142b, {0x48, 0x8d, 0x0d}, 0x3eb056, "\xe5\x9c\xa8\xe5\x85\xa8\xe5\xb1\x8f\xe7\xbb\x98\xe5\x88\xb6\xe8\xb0\x83\xe7\x94\xa8\xe5\x89\x8d\xe5\xa4\x8d\xe5\x88\xb6\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2###Copy depth buffer before fullscreen draw calls" },
    { 0x31432, {0x48, 0x8d, 0x05}, 0x3eb017, "\xe5\x9c\xa8\xe5\xb8\xa7\xe6\xb8\xb2\xe6\x9f\x93\xe6\x9c\x9f\xe9\x97\xb4\xe5\xa4\x8d\xe5\x88\xb6\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2\xe4\xbb\xa5\xe9\x98\xb2\xe7\x94\xbb\xe9\x9d\xa2\xe4\xbc\xaa\xe5\xbd\xb1###Copy depth buffer during frame to prevent artifacts" },
    { 0x319e8, {0x48, 0x8d, 0x05}, 0x3eaaf1, " \xe5\x8f\x8d\xe5\x90\x91\xe6\xb7\xb1\xe5\xba\xa6" },
    { 0x31a17, {0x48, 0x8d, 0x05}, 0x3eaad2, " \xe5\xa4\x9a\xe9\x87\x8d\xe9\x87\x87\xe6\xa0\xb7" },
    { 0x31ab8, {0x48, 0x8d, 0x0d}, 0x3eaa41, "| %4ux%-4u | %s | %5u \xe6\xac\xa1\xe7\xbb\x98\xe5\x88\xb6 (%5u \xe9\x97\xb4\xe6\x8e\xa5) ==> %8u \xe9\xa1\xb6\xe7\x82\xb9 |%s%s" },
    { 0x31c42, {0x48, 0x8d, 0x0d}, 0x3ea90f, " \xe5\x85\xa8\xe5\xb1\x8f\xe7\xbb\x98\xe5\x88\xb6\xe8\xb0\x83\xe7\x94\xa8" },
    { 0x31c62, {0x48, 0x8d, 0x0d}, 0x3ea907, "        |           |       | %5u \xe6\xac\xa1\xe7\xbb\x98\xe5\x88\xb6 (%5u \xe9\x97\xb4\xe6\x8e\xa5) ==> %8u \xe9\xa1\xb6\xe7\x82\xb9 |%s" },
    { 0x31cb4, {0x48, 0x8d, 0x0d}, 0x3ea90d, "    \xe8\xaf\xb7\xe9\x80\x89\xe6\x8b\xa9\xe5\x85\xb7\xe6\x9c\x89\xe8\xbe\x83\xe9\xab\x98\xe7\xbb\x98\xe5\x88\xb6\xe8\xb0\x83\xe7\x94\xa8\xe6\x95\xb0\xe7\x9a\x84\xe6\x9c\x80\xe5\x90\x8e\xe4\xb8\x80\xe4\xb8\xaa CLEAR \xe6\x93\x8d\xe4\xbd\x9c###    Choose last clear operation with high number of draw calls" },
};
bool g_gd_patched = false;

// MSVC x64 Release std::string 内存布局（仅当新字符串长度 <= 现有容量 _Myres 时原位覆盖，零分配零释放）
struct MsvcString {
    union {
        char buf[16];
        char *ptr;
    };
    size_t size;
    size_t res;

    char *data() { return res > 15 ? ptr : buf; }
    const char *c_str() const { return res > 15 ? ptr : buf; }

    bool replace_in_place_if_fits(const char *zh) {
        const size_t zh_len = strlen(zh);
        if (zh_len > res) return false;
        char *dst = data();
        if (!dst) return false;
        memcpy(dst, zh, zh_len + 1);
        size = zh_len;
        return true;
    }
};

void patch_reshade_in_memory(bool patch_addon_list = true) {
    if (!g_reshade_module) return;

    auto *base = reinterpret_cast<uint8_t *>(g_reshade_module);
    auto *dos = reinterpret_cast<IMAGE_DOS_HEADER *>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    auto *nt = reinterpret_cast<IMAGE_NT_HEADERS64 *>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.SizeOfImage < 0x520000) return;

    // 1. 校验 Generic Depth 所有 23 处指令指纹是否 100% 匹配 ReShade 6.8.0.2155
    if (!g_gd_patched) {
        bool fingerprint_ok = true;
        for (const auto &p : g_gd_patches) {
            const uint8_t *inst = base + p.lea_rva;
            int32_t cur_disp = 0;
            memcpy(&cur_disp, inst + 3, sizeof(int32_t));
            if (memcmp(inst, p.op, 3) != 0 || cur_disp != p.orig_disp) {
                fingerprint_ok = false;
                break;
            }
        }

        if (fingerprint_ok) {
            // 使用 ReShade64.dll 自身 .fptable 节尾页面空白区 (RVA 0x516100..0x516FFF，共 3840 字节)
            constexpr uint32_t kSlackRva = 0x516100;
            uint8_t *slack = base + kSlackRva;
            DWORD old_slack_prot = 0;
            if (VirtualProtect(slack, 0xE00, PAGE_READWRITE, &old_slack_prot)) {
                DWORD old_text_prot = 0;
                if (VirtualProtect(base + 0x31000, 0x1000, PAGE_EXECUTE_READWRITE, &old_text_prot)) {
                    uint32_t cur_rva = kSlackRva;
                    for (const auto &p : g_gd_patches) {
                        const size_t len = strlen(p.zh) + 1;
                        if (cur_rva + len < 0x516FE0) {
                            memcpy(base + cur_rva, p.zh, len);
                            const int32_t new_disp = static_cast<int32_t>(cur_rva) - static_cast<int32_t>(p.lea_rva + 7);
                            memcpy(base + p.lea_rva + 3, &new_disp, sizeof(int32_t));
                            cur_rva += static_cast<uint32_t>((len + 7) & ~size_t(7));
                        }
                    }
                    g_gd_patched = true;
                    VirtualProtect(base + 0x31000, 0x1000, old_text_prot, &old_text_prot);
                    FlushInstructionCache(GetCurrentProcess(), base + 0x31000, 0x1000);
                }
                VirtualProtect(slack, 0xE00, old_slack_prot, &old_slack_prot);
            }
        }
    }

    // 2. 校验 s_addons 向量指纹（RVA 0x3d840 处 Generic Depth 注册代码），在首次打开 Home 面板时原位汉化所有已加载插件标题与简介
    if (patch_addon_list && !g_reshade_patched) {
        const uint8_t expected_gd_reg[] = {0x41, 0xb8, 0x0d, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x15, 0xeb, 0xf5, 0x3d, 0x00};
        if (memcmp(base + 0x3d840, expected_gd_reg, sizeof(expected_gd_reg)) == 0) {
            auto *first_ptr = *reinterpret_cast<uint8_t **>(base + 0x49bdb0);
            auto *last_ptr = *reinterpret_cast<uint8_t **>(base + 0x49bdb8);
            if (first_ptr && last_ptr && last_ptr > first_ptr && (last_ptr - first_ptr) <= 0x110 * 64 && ((last_ptr - first_ptr) % 0x110) == 0) {
                for (uint8_t *item = first_ptr; item < last_ptr; item += 0x110) {
                    auto *name_str = reinterpret_cast<MsvcString *>(item + 0x08);
                    auto *desc_str = reinterpret_cast<MsvcString *>(item + 0x28);
                    if (name_str->size > 0 && name_str->size < 128 && name_str->res >= name_str->size && name_str->res < 512) {
                        std::string_view nsv(name_str->c_str(), name_str->size);
                        if (nsv == "Generic Depth") {
                            name_str->replace_in_place_if_fits("\xe9\x80\x9a\xe7\x94\xa8\xe6\xb7\xb1\xe5\xba\xa6");
                            desc_str->replace_in_place_if_fits("\xe9\x80\x82\xe7\x94\xa8\xe4\xba\x8e\xe7\xbb\x9d\xe5\xa4\xa7\xe5\xa4\x9a\xe6\x95\xb0\xe6\xb8\xb8\xe6\x88\x8f\xe7\x9a\x84\xe8\x87\xaa\xe5\x8a\xa8\xe6\xb7\xb1\xe5\xba\xa6\xe7\xbc\x93\xe5\x86\xb2\xe6\xa3\x80\xe6\xb5\x8b\xe6\x8f\x92\xe4\xbb\xb6\xe3\x80\x82");
                        } else if (nsv == "MFG Unlock") {
                            name_str->replace_in_place_if_fits("MFG\xe5\xa4\x9a\xe5\xb8\xa7\xe7\x94\x9f\xe6\x88\x90");
                            desc_str->replace_in_place_if_fits("\xe7\x89\x88\xe6\x9c\xac 1.4.4 \xe2\x80\x94 DLSS-G 310.9.16 \xe4\xb8\x8e Streamline 2.14.16\xef\xbc\x9b\xe6\x9c\xac\xe5\x9c\xb0\xe4\xbd\x8e\xe5\xbc\x80\xe9\x94\x80\xe6\x9e\xb6\xe6\x9e\x84\xe4\xb8\x8e V2 \xe7\x94\xbb\xe9\x9d\xa2\xe4\xbf\xae\xe8\xa1\xa5");
                        } else if (nsv == "DLSS 5 Neural Rendering") {
                            name_str->replace_in_place_if_fits("DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93 (RenoDX)");
                            desc_str->replace_in_place_if_fits("\xe9\x80\x82\xe7\x94\xa8\xe4\xba\x8e NGX / Streamline \xe6\xb8\xb8\xe6\x88\x8f\xe7\x9a\x84 DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe5\x90\x8e\xe5\xa4\x84\xe7\x90\x86\xe7\xbb\x84\xe4\xbb\xb6");
                        } else if (nsv == "DLSS 5 Feed 1.17.0" || nsv == "DLSS 5 Feed 1.19.0") {
                            name_str->replace_in_place_if_fits("DLSS 5 \xe6\xb7\xb1\xe5\xba\xa6\xe4\xb8\x8e\xe8\xbf\x90\xe5\x8a\xa8\xe9\xa6\x88\xe9\x80\x81\xe5\x99\xa8");
                            desc_str->replace_in_place_if_fits("\xe4\xb8\xba\xe6\x97\xa0\xe5\x8e\x9f\xe7\x94\x9f DLSS \xe7\x9a\x84 D3D11/D3D12/Vulkan/OpenGL \xe6\xb8\xb8\xe6\x88\x8f\xe5\x90\x91 DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe9\xa6\x88\xe9\x80\x81\xe6\xb7\xb1\xe5\xba\xa6\xe4\xb8\x8e\xe8\xbf\x90\xe5\x8a\xa8\xe7\x9f\xa2\xe9\x87\x8f (\xe9\x85\x8d\xe7\xbd\xae\xe4\xbf\x9d\xe5\xad\x98\xe4\xba\x8e dlss5-feed.cfg)\xe3\x80\x82");
                        } else if (nsv == "RenoDX DLSS") {
                            name_str->replace_in_place_if_fits("RenoDX\xe8\xb6\x85\xe5\x88\x86");
                            desc_str->replace_in_place_if_fits("RenoDX DLSS \xe6\x8e\xa7\xe5\x88\xb6\xe5\x99\xa8");
                        }
                    }
                }
                g_reshade_patched = true;
            }
        } else {
            g_reshade_patched = true;
        }
    }
}

void unpatch_reshade_in_memory() {
    if (!g_gd_patched || !g_reshade_module) return;
    auto *base = reinterpret_cast<uint8_t *>(g_reshade_module);
    DWORD old_text_prot = 0;
    if (VirtualProtect(base + 0x31000, 0x1000, PAGE_EXECUTE_READWRITE, &old_text_prot)) {
        for (const auto &p : g_gd_patches) {
            memcpy(base + p.lea_rva + 3, &p.orig_disp, sizeof(int32_t));
        }
        VirtualProtect(base + 0x31000, 0x1000, old_text_prot, &old_text_prot);
        FlushInstructionCache(GetCurrentProcess(), base + 0x31000, 0x1000);
    }
    g_gd_patched = false;
}

constexpr const char *kTuner64OverlayTitle =
    "\xe2\x98\x85 \xe4\xb8\x80\xe5\xb1\x82" " DLSS5 \xe5\xbf\xab\xe8\xb0\x83###DLSS5_SinglePass_Tuner64";
constexpr const char *kTuner64SideWindowTitle =
    "\xe2\x98\x85 \xe4\xb8\x80\xe5\xb1\x82" " DLSS 5 \xe5\xa2\x9e\xe6\x95\x88\xe4\xb8\x8e\xe7\x9c\x81\xe5\x8d\xa1\xe5\xbf\xab\xe8\xb0\x83###DLSS5_64Bit_SidePanel";
bool g_tuner64_registered = false;
bool g_host64_present_registered = false;
bool g_overlay_open64 = false;
int g_last_tuner64_tab_frame = -100;

bool on_open_overlay64(reshade::api::effect_runtime *, bool open, reshade::api::input_source) {
    g_overlay_open64 = open;
    if (open) {
        static bool s_logged_open64 = false;
        if (!s_logged_open64) {
            s_logged_open64 = true;
            reshade::log::message(reshade::log::level::info, "DLSS 5 Swapper Enhanced: ReShade Home menu opened in Chinese.");
        }
    }
    return false;
}

void on_draw_64bit_tuner_overlay(reshade::api::effect_runtime *) {
    const imgui_function_table *tbl = g_table_hooked ? &g_orig : imgui_function_table_instance();
    if (!tbl) return;
    g_last_tuner64_tab_frame = tbl->GetFrameCount();
    tbl->PushID("ENH_Tuner64_Tab");
    draw_singlepass_tuner_panel();
    tbl->PopID();
}

void on_draw_64bit_addon_settings(reshade::api::effect_runtime *) {
    const imgui_function_table *tbl = g_table_hooked ? &g_orig : imgui_function_table_instance();
    if (!tbl) return;
    g_last_tuner64_tab_frame = tbl->GetFrameCount();
    tbl->PushID("ENH_Tuner64_Addon");
    draw_singlepass_tuner_panel();
    tbl->PopID();
}

// 仅在 32 位跨进程宿主 dlss5-feed-host64.exe 中每 500ms 轮询一次 host64\ReShade.ini 时间戳，使 32 位游戏内侧边栏调参 0.5 秒内同步生效
void on_reshade_present(reshade::api::effect_runtime *) {
    const ULONGLONG now = GetTickCount64();
    if (now - g_last_poll_tick < 500) return;
    g_last_poll_tick = now;

    init_singlepass_tuner();
    FILETIME cur_mtime = {0, 0};
    if (get_file_mtime_w(g_consumer_ini_w, &cur_mtime)) {
        if (cur_mtime.dwLowDateTime != g_last_ini_mtime.dwLowDateTime ||
            cur_mtime.dwHighDateTime != g_last_ini_mtime.dwHighDateTime) {
            reload_tuner_from_disk(true);
        }
    }
}

#else // !_WIN64 (32位游戏跨进程 DLSS 5 神经渲染控制面板与汉化支持)

bool g_gd_patched = true;
void patch_reshade_in_memory(bool = true) { g_reshade_patched = true; }
void unpatch_reshade_in_memory() {}

using feeder_overlay_cb_t = void(__cdecl *)(reshade::api::effect_runtime *);
feeder_overlay_cb_t g_feeder32_cb = nullptr;
bool g_feeder32_searched = false;
bool g_overlay_open = false;
int g_last_home_tab_frame = -100;
int g_last_dlss5_tab_frame = -100;

constexpr const char *kDlss5TabTitle =
    "DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93###DLSS 5 Neural Rendering";
constexpr const char *kDlss5SideWindowTitle =
    "DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93 (32\xe4\xbd\x8d\xe8\xb7\xa8\xe8\xbf\x9b\xe7\xa8\x8b\xe5\xbc\x95\xe6\x93\x8e)###DLSS5_32Bit_SidePanel";

feeder_overlay_cb_t find_feeder32_overlay_callback() {
    if (g_feeder32_cb) return g_feeder32_cb;
    if (g_feeder32_searched) return nullptr;

    HMODULE mod = GetModuleHandleW(L"dlss5-feed.addon32");
    if (!mod) return nullptr;

    g_feeder32_searched = true;
    auto *base = reinterpret_cast<uint8_t *>(mod);
    auto *dos = reinterpret_cast<IMAGE_DOS_HEADER *>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return nullptr;
    auto *nt = reinterpret_cast<IMAGE_NT_HEADERS32 *>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return nullptr;

    const uint32_t image_size = nt->OptionalHeader.SizeOfImage;
    if (image_size < 0x4000) return nullptr;

    // 匹配 dlss5-feed.addon32 中调用 ReShadeRegisterOverlay(nullptr, cb) 的指令序列：
    // 85 c0 74 0c 68 <cb_va> 6a 00 ff d0 83 c4 08 c3
    for (uint32_t rva = 0x1000; rva + 16 <= image_size; ++rva) {
        const uint8_t *p = base + rva;
        if (p[0] == 0x85 && p[1] == 0xC0 &&
            p[2] == 0x74 && p[3] == 0x0C &&
            p[4] == 0x68 &&
            p[9] == 0x6A && p[10] == 0x00 &&
            p[11] == 0xFF && p[12] == 0xD0 &&
            p[13] == 0x83 && p[14] == 0xC4 && p[15] == 0x08) {
            uint32_t cb_addr = 0;
            memcpy(&cb_addr, p + 5, sizeof(uint32_t));
            const uintptr_t mod_start = reinterpret_cast<uintptr_t>(base);
            const uintptr_t mod_end = mod_start + image_size;
            if (cb_addr >= mod_start + 0x1000 && cb_addr < mod_end) {
                g_feeder32_cb = reinterpret_cast<feeder_overlay_cb_t>(static_cast<uintptr_t>(cb_addr));
                return g_feeder32_cb;
            }
        }
    }
    return nullptr;
}

void draw_32bit_dlss5_panel_contents(reshade::api::effect_runtime *runtime) {
    ImGui::TextColored(
        ImVec4(0.45f, 0.92f, 0.35f, 1.0f),
        "\xe2\x97\x8f DLSS 5 \xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe5\xb7\xb2\xe6\xbf\x80\xe6\xb4\xbb (32\xe4\xbd\x8d\xe6\xb8\xb8\xe6\x88\x8f -> host64 64\xe4\xbd\x8d\xe7\xa5\x9e\xe7\xbb\x8f\xe6\xb8\xb2\xe6\x9f\x93\xe7\xae\xa1\xe7\xba\xbf)");
    ImGui::Separator();
    if (ImGui::CollapsingHeader(
            "\xe2\x98\x85 \xe4\xb8\x80\xe5\xb1\x82 DLSS 5 \xe5\xbc\xba\xe5\x8c\x96\xe4\xb8\x8e\xe7\x9c\x81\xe5\x8d\xa1\xe5\xbf\xab\xe8\xb0\x83 (\xe5\xae\x9e\xe6\x97\xb6\xe7\x94\x9f\xe6\x95\x88)###ENH_Tuner32_Hdr",
            ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::PushID("ENH_Tuner32");
        draw_singlepass_tuner_panel();
        ImGui::PopID();
    }
    ImGui::Separator();
    if (feeder_overlay_cb_t cb = find_feeder32_overlay_callback()) {
        cb(runtime);
    } else {
        ImGui::TextWrapped(
            "\xe6\xad\xa3\xe5\x9c\xa8\xe7\xad\x89\xe5\xbe\x85 32 \xe4\xbd\x8d DLSS 5 \xe9\xa6\x88\xe9\x80\x81\xe5\x99\xa8 (dlss5-feed.addon32) \xe5\x88\x9d\xe5\xa7\x8b\xe5\x8c\x96...");
    }
}

void on_draw_32bit_dlss5_tab(reshade::api::effect_runtime *runtime) {
    g_last_dlss5_tab_frame = ImGui::GetFrameCount();
    draw_32bit_dlss5_panel_contents(runtime);
}

bool on_open_overlay(reshade::api::effect_runtime *, bool open, reshade::api::input_source) {
    g_overlay_open = open;
    return false;
}

bool on_overlay_technique(reshade::api::effect_runtime *, reshade::api::effect_technique) {
    g_last_home_tab_frame = ImGui::GetFrameCount();
    return false;
}

void on_init_device(reshade::api::device *device) {
    if (!device || device->get_api() != reshade::api::device_api::d3d11) return;
    void *unk = reinterpret_cast<void *>(static_cast<uintptr_t>(device->get_native()));
    if (!unk) return;
    // 在 D3D11 设备创建瞬间立即开启 ID3D10Multithread 多线程保护，防止 ReShade 后台编译线程与 dgVoodoo2 / 游戏流式加载线程死锁
    static const GUID kIID_ID3D10Multithread = {
        0x9b7e4e00, 0x342c, 0x4106, {0xa1, 0x9f, 0x4f, 0x27, 0x04, 0xf6, 0x89, 0xf0}
    };
    auto **unk_vtable = *reinterpret_cast<void ***>(unk);
    using qi_fn = HRESULT(__stdcall *)(void *, const GUID &, void **);
    void *mt = nullptr;
    if (reinterpret_cast<qi_fn>(unk_vtable[0])(unk, kIID_ID3D10Multithread, &mt) >= 0 && mt) {
        auto **mt_vtable = *reinterpret_cast<void ***>(mt);
        using set_mt_fn = BOOL(__stdcall *)(void *, BOOL);
        using release_fn = ULONG(__stdcall *)(void *);
        reinterpret_cast<set_mt_fn>(mt_vtable[5])(mt, TRUE);
        reinterpret_cast<release_fn>(mt_vtable[2])(mt);
    }
}

#endif // _WIN64

void install_imgui_hooks() {
    if (g_table_hooked) return;
    const imgui_function_table *inst = imgui_function_table_instance();
    if (!inst) return;
    g_orig = *inst;
    auto *mut = const_cast<imgui_function_table *>(inst);
    DWORD old_prot = 0;
    VirtualProtect(mut, sizeof(imgui_function_table), PAGE_READWRITE, &old_prot);

    mut->TextUnformatted = hook_TextUnformatted;
    mut->TextV = hook_TextV;
    mut->TextColoredV = hook_TextColoredV;
    mut->TextDisabledV = hook_TextDisabledV;
    mut->TextWrappedV = hook_TextWrappedV;
    mut->LabelTextV = hook_LabelTextV;
    mut->BulletTextV = hook_BulletTextV;
    mut->SeparatorText = hook_SeparatorText;
    mut->Button = hook_Button;
    mut->SmallButton = hook_SmallButton;
    mut->Checkbox = hook_Checkbox;
    mut->CheckboxFlags = hook_CheckboxFlags;
    mut->CheckboxFlags2 = hook_CheckboxFlags2;
    mut->RadioButton = hook_RadioButton;
    mut->RadioButton2 = hook_RadioButton2;
    mut->BeginCombo = hook_BeginCombo;
    mut->Combo = hook_Combo;
    mut->Combo2 = hook_Combo2;
    mut->DragFloat = hook_DragFloat;
    mut->DragInt = hook_DragInt;
    mut->SliderFloat = hook_SliderFloat;
    mut->SliderInt = hook_SliderInt;
    mut->InputFloat = hook_InputFloat;
    mut->InputInt = hook_InputInt;
    mut->TreeNode = hook_TreeNode;
    mut->TreeNodeV = hook_TreeNodeV;
    mut->TreeNodeEx = hook_TreeNodeEx;
    mut->TreeNodeExV = hook_TreeNodeExV;
    mut->CollapsingHeader = hook_CollapsingHeader;
    mut->CollapsingHeader2 = hook_CollapsingHeader2;
    mut->Selectable = hook_Selectable;
    mut->Selectable2 = hook_Selectable2;
    mut->SetTooltipV = hook_SetTooltipV;
    mut->SetItemTooltipV = hook_SetItemTooltipV;
    mut->TableSetupColumn = hook_TableSetupColumn;
    mut->TableHeader = hook_TableHeader;
    mut->BeginTabItem = hook_BeginTabItem;
    mut->TabItemButton = hook_TabItemButton;

    if (old_prot) {
        VirtualProtect(mut, sizeof(imgui_function_table), old_prot, &old_prot);
    }
    g_table_hooked = true;
}

void remove_imgui_hooks() {
    if (!g_table_hooked) return;
    const imgui_function_table *inst = imgui_function_table_instance();
    if (inst) {
        auto *mut = const_cast<imgui_function_table *>(inst);
        DWORD old_prot = 0;
        VirtualProtect(mut, sizeof(imgui_function_table), PAGE_READWRITE, &old_prot);
        *mut = g_orig;
        if (old_prot) {
            VirtualProtect(mut, sizeof(imgui_function_table), old_prot, &old_prot);
        }
    }
    g_table_hooked = false;
}

void on_reshade_overlay(reshade::api::effect_runtime *runtime) {
    if (!g_gd_patched || !g_reshade_patched) {
        patch_reshade_in_memory();
    }
    update_and_draw_perf_hud(runtime);
#ifndef _WIN64
    const int cur_frame = ImGui::GetFrameCount();
    const bool home_visible = g_overlay_open || (cur_frame - g_last_home_tab_frame <= 1);
    const bool tab_active = (cur_frame - g_last_dlss5_tab_frame <= 1);
    if (home_visible && !tab_active) {
        const ImVec2 display = ImGui::GetIO().DisplaySize;
        if (display.x > 100.0f && display.y > 100.0f) {
            float left_edge = display.x * 0.36f + 16.0f;
            if (left_edge < 240.0f) left_edge = 240.0f;
            if (left_edge > 560.0f) left_edge = 560.0f;
            float avail_w = display.x - left_edge - 8.0f;
            if (avail_w < 260.0f) {
                left_edge = display.x > 400.0f ? (display.x - 392.0f) : 8.0f;
                avail_w = display.x - left_edge - 8.0f;
            }
            float win_w = avail_w > 540.0f ? 540.0f : avail_w;
            float win_h = display.y - 16.0f;
            if (win_h > 780.0f) win_h = 780.0f;
            ImGui::SetNextWindowPos(ImVec2(left_edge, 8.0f), ImGuiCond_Appearing);
            ImGui::SetNextWindowSize(ImVec2(win_w, win_h), ImGuiCond_Appearing);
        }
        if (ImGui::Begin(kDlss5SideWindowTitle, nullptr, ImGuiWindowFlags_NoCollapse)) {
            ImGui::PushID("DLSS5_SidePanel");
            draw_32bit_dlss5_panel_contents(runtime);
            ImGui::PopID();
        }
        ImGui::End();
    }
#else
    (void)runtime;
    if (g_tuner64_registered && g_overlay_open64) {
        const imgui_function_table *tbl = g_table_hooked ? &g_orig : imgui_function_table_instance();
        const bool has_dlss5_rt =
            GetModuleHandleW(L"renodx-dlss5.addon64") != nullptr ||
            GetModuleHandleW(L"dlss5-feed.addon64") != nullptr;
        if (tbl) {
            const int cur_frame = tbl->GetFrameCount();
            if (cur_frame - g_last_tuner64_tab_frame > 1) {
                const ImGuiIO &io = tbl->GetIO();
                const float disp_x = io.DisplaySize.x;
                const float disp_y = io.DisplaySize.y;
                if (disp_x > 100.0f && disp_y > 100.0f) {
                    float left_edge = 692.0f;
                    if (disp_x < 1200.0f) {
                        left_edge = disp_x > 500.0f ? (disp_x - 488.0f) : 8.0f;
                    }
                    float win_w = 488.0f;
                    if (disp_x - left_edge - 12.0f < win_w) {
                        win_w = disp_x - left_edge - 12.0f;
                    }
                    if (win_w < 320.0f) win_w = 320.0f;
                    const float max_h = has_dlss5_rt ? 560.0f : 210.0f;
                    float win_h = disp_y - 24.0f;
                    if (win_h > max_h) win_h = max_h;
                    const ImVec2 pos(left_edge, 8.0f);
                    const ImVec2 pivot(0.0f, 0.0f);
                    const ImVec2 sz(win_w, win_h);
                    tbl->SetNextWindowPos(pos, ImGuiCond_Once, pivot);
                    tbl->SetNextWindowSize(sz, ImGuiCond_Once);
                }
                if (tbl->Begin(kTuner64SideWindowTitle, nullptr, ImGuiWindowFlags_NoSavedSettings)) {
                    tbl->PushID("ENH_Tuner64_Side");
                    draw_singlepass_tuner_panel();
                    tbl->PopID();
                }
                tbl->End();
            }
        }
    }
#endif
}

} // namespace

extern "C" __declspec(dllexport) bool AddonInit(HMODULE addon, HMODULE reshade_module) {
    if (!reshade::register_addon(addon, reshade_module)) return false;
    g_reshade_module = reshade_module;
    // 在 Vulkan 隐式层模式（如《无人深空》NMS.exe）下，游戏启动阶段会多次创建并销毁临时 VkInstance；
    // vulkan-1.dll 会在最后一个临时 VkInstance 销毁时对 ReShade64.dll 调用 FreeLibrary，
    // 导致通过 LoadFromDllMain 注册的外部插件（如 renodx-mfgunlock.addon64）丢失注册表。
    // 将 ReShade 宿主模块固定在进程内存中，确保跨临时 VkInstance 销毁周期保持所有插件与钩子存活。
    HMODULE pinned_reshade = nullptr;
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        reinterpret_cast<LPCWSTR>(reshade_module),
        &pinned_reshade);
    exact_map(); // 预热哈希表
    install_imgui_hooks();
    patch_reshade_in_memory(false);
    reshade::register_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);
    reshade::register_event<reshade::addon_event::destroy_effect_runtime>(on_destroy_effect_runtime);
#ifndef _WIN64
    // 1. 预加载 dinput8.dll / hid.dll / setupapi.dll / winmm.dll，使 ReShade 在主线程同步完成延迟钩子安装，
    //    彻底消除多线程游戏（如《虐杀原形》prototypef.exe）工作线程并发加载 dinput8 与 HID.DLL 触发的钩子死锁警告与卡顿。
    LoadLibraryW(L"dinput8.dll");
    LoadLibraryW(L"hid.dll");
    LoadLibraryW(L"setupapi.dll");
    LoadLibraryW(L"winmm.dll");

    // 2. 将当前已加载的 dgVoodoo2 包装层 (D3D8.dll / D3D9.dll / DDraw.dll) 锁定在进程内存中，
    //    防止《马克思佩恩 2 (Max Payne 2)》等自带启动器设置对话框的老游戏在点击 Play 关闭设置框时调用 FreeLibrary(hD3D8) 卸载 dgVoodoo2。
    for (const wchar_t *wrap_dll : {L"d3d8.dll", L"d3d9.dll", L"ddraw.dll", L"d3dimm.dll"}) {
        if (GetModuleHandleW(wrap_dll)) {
            HMODULE pinned_wrap = nullptr;
            GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN, wrap_dll, &pinned_wrap);
        }
    }

    // 3. 针对《虐杀原形 (Prototype)》《马克思佩恩 1/2 (Max Payne)》等在超过 8 逻辑核心 CPU 上存在引擎线程池死锁/掉帧缺陷的 32 位老游戏，
    //    自动将 32 位游戏进程绑定至前 8 个逻辑核心 (0xFF)。
    wchar_t exe_path[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, exe_path, MAX_PATH)) {
        _wcslwr_s(exe_path, MAX_PATH);
        if (wcsstr(exe_path, L"prototype") || wcsstr(exe_path, L"scarface") || wcsstr(exe_path, L"maxpayne")) {
            DWORD_PTR proc_mask = 0, sys_mask = 0;
            if (GetProcessAffinityMask(GetCurrentProcess(), &proc_mask, &sys_mask)) {
                const DWORD_PTR capped = sys_mask & 0xFF;
                if (capped != 0) SetProcessAffinityMask(GetCurrentProcess(), capped);
            }
        }
    }

    reshade::register_event<reshade::addon_event::init_device>(on_init_device);
    reshade::register_event<reshade::addon_event::reshade_open_overlay>(on_open_overlay);
    reshade::register_event<reshade::addon_event::reshade_overlay_technique>(on_overlay_technique);
    reshade::register_overlay(kDlss5TabTitle, on_draw_32bit_dlss5_tab);
#else
    // 若当前 64 位宿主进程 (dlss5-feed-host64.exe) 继承了 32 位父进程的受限 CPU 亲和性掩码，自动恢复全核心亲和性以保证神经渲染满速运行
    bool is_host64_proc = false;
    wchar_t host_path[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, host_path, MAX_PATH)) {
        _wcslwr_s(host_path, MAX_PATH);
        if (wcsstr(host_path, L"dlss5-feed-host64")) {
            is_host64_proc = true;
            DWORD_PTR proc_mask = 0, sys_mask = 0;
            if (GetProcessAffinityMask(GetCurrentProcess(), &proc_mask, &sys_mask) && sys_mask != 0 && proc_mask != sys_mask) {
                SetProcessAffinityMask(GetCurrentProcess(), sys_mask);
            }
        }
    }
    if (is_host64_proc) {
        reshade::register_event<reshade::addon_event::reshade_present>(on_reshade_present);
        g_host64_present_registered = true;
    } else {
        reshade::register_event<reshade::addon_event::reshade_open_overlay>(on_open_overlay64);
        reshade::register_overlay(kTuner64OverlayTitle, on_draw_64bit_tuner_overlay);
        reshade::register_overlay(nullptr, on_draw_64bit_addon_settings);
        g_tuner64_registered = true;
    }
#endif
    reshade::log::message(reshade::log::level::info, "DLSS 5 Swapper Enhanced: Simplified Chinese UI localization & single-pass tuner active.");
    return true;
}

extern "C" __declspec(dllexport) void AddonUninit(HMODULE addon, HMODULE reshade_module) {
#ifndef _WIN64
    reshade::unregister_overlay(kDlss5TabTitle, on_draw_32bit_dlss5_tab);
    reshade::unregister_event<reshade::addon_event::reshade_overlay_technique>(on_overlay_technique);
    reshade::unregister_event<reshade::addon_event::reshade_open_overlay>(on_open_overlay);
    reshade::unregister_event<reshade::addon_event::init_device>(on_init_device);
#else
    if (g_tuner64_registered) {
        reshade::unregister_overlay(nullptr, on_draw_64bit_addon_settings);
        reshade::unregister_overlay(kTuner64OverlayTitle, on_draw_64bit_tuner_overlay);
        reshade::unregister_event<reshade::addon_event::reshade_open_overlay>(on_open_overlay64);
        g_tuner64_registered = false;
    }
    if (g_host64_present_registered) {
        reshade::unregister_event<reshade::addon_event::reshade_present>(on_reshade_present);
        g_host64_present_registered = false;
    }
#endif
    reshade::unregister_event<reshade::addon_event::destroy_effect_runtime>(on_destroy_effect_runtime);
    reshade::unregister_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);
    cleanup_perf_hud();
    unpatch_reshade_in_memory();
    remove_imgui_hooks();
    reshade::unregister_addon(addon, reshade_module);
}
