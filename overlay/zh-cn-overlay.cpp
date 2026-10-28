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
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
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
    return g_orig.BeginTabItem(translate_widget_label(label), p_open, flags);
}

bool hook_TabItemButton(const char *label, ImGuiTabItemFlags flags) {
    return g_orig.TabItemButton(translate_widget_label(label), flags);
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

void patch_reshade_in_memory() {
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

    // 2. 校验 s_addons 向量指纹（RVA 0x3d840 处 Generic Depth 注册代码），原位汉化插件列表标题与简介
    if (!g_reshade_patched) {
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
                            name_str->replace_in_place_if_fits("DLSS 5 \xe6\xb7\xb1\xe5\xba\xa8\xe4\xb8\x8e\xe8\xbf\x90\xe5\x8a\xa8\xe9\xa6\x88\xe9\x80\x81\xe5\x99\xa8");
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

#else // !_WIN64 (32位游戏跨进程 DLSS 5 神经渲染控制面板与汉化支持)

bool g_gd_patched = true;
void patch_reshade_in_memory() { g_reshade_patched = true; }
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
    patch_reshade_in_memory();
    reshade::register_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);
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
    wchar_t host_path[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, host_path, MAX_PATH)) {
        _wcslwr_s(host_path, MAX_PATH);
        if (wcsstr(host_path, L"dlss5-feed-host64")) {
            DWORD_PTR proc_mask = 0, sys_mask = 0;
            if (GetProcessAffinityMask(GetCurrentProcess(), &proc_mask, &sys_mask) && sys_mask != 0 && proc_mask != sys_mask) {
                SetProcessAffinityMask(GetCurrentProcess(), sys_mask);
            }
        }
    }
#endif
    reshade::log::message(reshade::log::level::info, "DLSS 5 Swapper Enhanced: Simplified Chinese UI localization layer active.");
    return true;
}

extern "C" __declspec(dllexport) void AddonUninit(HMODULE addon, HMODULE reshade_module) {
#ifndef _WIN64
    reshade::unregister_overlay(kDlss5TabTitle, on_draw_32bit_dlss5_tab);
    reshade::unregister_event<reshade::addon_event::reshade_overlay_technique>(on_overlay_technique);
    reshade::unregister_event<reshade::addon_event::reshade_open_overlay>(on_open_overlay);
    reshade::unregister_event<reshade::addon_event::init_device>(on_init_device);
#endif
    reshade::unregister_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);
    unpatch_reshade_in_memory();
    remove_imgui_hooks();
    reshade::unregister_addon(addon, reshade_module);
}
