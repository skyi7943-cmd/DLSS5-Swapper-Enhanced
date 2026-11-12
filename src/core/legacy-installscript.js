'use strict';
// 解析 Steam 老游戏自带的 installscript.vdf / *_install.vdf 及关联 .reg 脚本，
// 将原本需要管理员权限首次启动才会写入 HKLM\SOFTWARE\... 的安装路径与校验键值
// 无感预置到当前用户可读写的 HKCU\Software\DLSS5Swapper\VirtualHKLM\... 虚拟注册表下，
// 配合 32 位兼容桥 winmm.dll 的注册表回退钩子，彻底消除“This program was not installed using the provided installer”等报错。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function defaultRegRunner(args) {
  return execFileSync('reg', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

function tokenizeVdf(text) {
  const tokens = [];
  const src = String(text || '').replace(/^\uFEFF/, '');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '{' || ch === '}') {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      let val = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1];
          if (next === '"' || next === '\\') { val += next; i += 2; continue; }
          if (next === 'n') { val += '\n'; i += 2; continue; }
          if (next === 't') { val += '\t'; i += 2; continue; }
        }
        val += src[i++];
      }
      if (src[i] === '"') i++;
      tokens.push(val);
      continue;
    }
    let bare = '';
    while (i < src.length && !/[\s{}"]/.test(src[i])) bare += src[i++];
    if (bare) tokens.push(bare);
  }
  return tokens;
}

function parseVdfTree(text) {
  const tokens = tokenizeVdf(text);
  let pos = 0;
  function readObject() {
    const obj = {};
    while (pos < tokens.length) {
      const tok = tokens[pos++];
      if (tok === '}') break;
      if (tok === '{') continue;
      const key = tok;
      if (tokens[pos] === '{') {
        pos++;
        const child = readObject();
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          Object.assign(obj[key], child);
        } else {
          obj[key] = child;
        }
      } else if (pos < tokens.length && tokens[pos] !== '}') {
        obj[key] = tokens[pos++];
      }
    }
    return obj;
  }
  return readObject();
}

function expandInstallVars(value, gameDir) {
  const cleanDir = String(gameDir || '').replace(/[\\/]+$/, '');
  return String(value ?? '')
    .replace(/%INSTALLDIR%/gi, cleanDir)
    .replace(/%ROOTDRIVE%/gi, cleanDir.slice(0, 2));
}

function normalizeSoftwareSubkey(fullKeyPath) {
  const clean = String(fullKeyPath || '').trim().replace(/^\[|\]$/g, '').replace(/\//g, '\\');
  const m = clean.match(/^(HKEY_LOCAL_MACHINE|HKLM|HKEY_CURRENT_USER|HKCU)\\SOFTWARE\\(?:WOW6432Node\\)?(.+)$/i);
  if (!m) return null;
  const hive = /^(HKEY_LOCAL_MACHINE|HKLM)$/i.test(m[1]) ? 'HKLM' : 'HKCU';
  const rest = m[2].replace(/\\+$/, '');
  if (!rest || /^(Microsoft|Classes|Policies|RegisteredApplications)(?:\\|$)/i.test(rest)) return null;
  return { hive, subkey: rest };
}

function findCaseInsensitiveKey(obj, name) {
  if (!obj || typeof obj !== 'object') return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return null;
}

function collectValuesFromTypedBlock(block, type, gameDir, outValues) {
  if (!block || typeof block !== 'object') return;
  // 先读取默认语言分支（如 english）作为兜底，再由顶层显式键值覆盖
  const preferredLang = findCaseInsensitiveKey(block, 'english') || findCaseInsensitiveKey(block, 'schinese');
  if (preferredLang && typeof preferredLang === 'object') {
    for (const [k, v] of Object.entries(preferredLang)) {
      if (typeof v === 'string') {
        outValues.push({ name: k, type, data: expandInstallVars(v, gameDir) });
      }
    }
  }
  for (const [k, v] of Object.entries(block)) {
    if (typeof v === 'string') {
      const expanded = expandInstallVars(v, gameDir);
      const existing = outValues.findIndex((item) => item.name.toLowerCase() === k.toLowerCase());
      if (existing >= 0) outValues[existing] = { name: k, type, data: expanded };
      else outValues.push({ name: k, type, data: expanded });
    }
  }
}

function collectRegFilesFromTree(node, gameDir, found = []) {
  if (!node || typeof node !== 'object') return found;
  for (const v of Object.values(node)) {
    if (typeof v === 'string') {
      const expanded = expandInstallVars(v, gameDir);
      const matches = expanded.match(/[A-Za-z]:\\[^"<>|*?\r\n]+\.reg/gi) || [];
      for (const m of matches) found.push(m);
    } else if (v && typeof v === 'object') {
      collectRegFilesFromTree(v, gameDir, found);
    }
  }
  return found;
}

function parseVdfRegistry(vdfText, gameDir) {
  const tree = parseVdfTree(vdfText);
  const root = findCaseInsensitiveKey(tree, 'InstallScript') || tree;
  const regNode = findCaseInsensitiveKey(root, 'Registry');
  const entries = [];

  if (regNode && typeof regNode === 'object') {
    for (const [rawKeyPath, keyBody] of Object.entries(regNode)) {
      const norm = normalizeSoftwareSubkey(rawKeyPath);
      if (!norm || !keyBody || typeof keyBody !== 'object') continue;
      const values = [];
      collectValuesFromTypedBlock(findCaseInsensitiveKey(keyBody, 'string'), 'REG_SZ', gameDir, values);
      collectValuesFromTypedBlock(findCaseInsensitiveKey(keyBody, 'dword'), 'REG_DWORD', gameDir, values);
      entries.push({ hive: norm.hive, subkey: norm.subkey, values });
    }
  }

  const regFiles = [...new Set(collectRegFilesFromTree(findCaseInsensitiveKey(root, 'Run Process'), gameDir))];
  return { entries, regFiles };
}

function readRegText(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function unescapeRegString(str) {
  return String(str || '').replace(/\\(["\\])/g, '$1');
}

function parseRegFile(regText, gameDir) {
  const lines = String(regText || '').split(/\r?\n/);
  const entries = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith(';')) continue;
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].trim();
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const rawKey = line.slice(1, -1).trim();
      if (rawKey.startsWith('-')) { current = null; continue; }
      const norm = normalizeSoftwareSubkey(rawKey);
      if (norm) {
        current = { hive: norm.hive, subkey: norm.subkey, values: [] };
        entries.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;

    let name = null;
    let rest = null;
    if (line.startsWith('@=')) {
      name = '(Default)';
      rest = line.slice(2).trim();
    } else {
      const m = line.match(/^"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/);
      if (m) {
        name = unescapeRegString(m[1]);
        rest = m[2].trim();
      }
    }
    if (name === null || rest === null) continue;

    if (rest.startsWith('"') && rest.endsWith('"')) {
      const val = expandInstallVars(unescapeRegString(rest.slice(1, -1)), gameDir);
      current.values.push({ name, type: 'REG_SZ', data: val });
    } else if (/^dword:[0-9a-fA-F]+$/i.test(rest)) {
      const num = String(parseInt(rest.slice(6), 16) >>> 0);
      current.values.push({ name, type: 'REG_DWORD', data: num });
    }
  }
  return entries;
}

function findInstallScriptFiles(gameDir, exeDir) {
  const dirs = [...new Set([gameDir, exeDir].filter(Boolean).map((d) => path.resolve(d)))];
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (/^(?:installscript|\d+_install)\.vdf$/i.test(name)) {
        files.push(path.join(d, name));
      }
    }
  }
  return files;
}

function seedInstallScriptRegistry(gameDir, exeDir, runner = defaultRegRunner) {
  const vdfFiles = findInstallScriptFiles(gameDir, exeDir);
  if (!vdfFiles.length) return { seededKeys: 0, seededValues: 0 };

  const allEntries = [];
  for (const vdfFile of vdfFiles) {
    let text = '';
    try { text = readRegText(vdfFile); } catch { continue; }
    const { entries, regFiles } = parseVdfRegistry(text, gameDir);
    allEntries.push(...entries);
    for (const regFile of regFiles) {
      if (!fs.existsSync(regFile)) continue;
      try {
        allEntries.push(...parseRegFile(readRegText(regFile), gameDir));
      } catch {}
    }
  }

  let seededKeys = 0;
  let seededValues = 0;
  for (const entry of allEntries) {
    const targetKey = entry.hive === 'HKLM'
      ? `HKCU\\Software\\DLSS5Swapper\\VirtualHKLM\\${entry.subkey}`
      : `HKCU\\Software\\${entry.subkey}`;
    try {
      runner(['add', targetKey, '/f']);
      seededKeys++;
    } catch { continue; }
    for (const val of entry.values) {
      const isDefault = val.name === '(Default)' || val.name === '';
      const args = isDefault
        ? ['add', targetKey, '/ve', '/t', val.type, '/d', String(val.data ?? ''), '/f']
        : ['add', targetKey, '/v', val.name, '/t', val.type, '/d', String(val.data ?? ''), '/f'];
      try {
        runner(args);
        seededValues++;
      } catch {}
    }
  }
  return { seededKeys, seededValues };
}

module.exports = {
  parseVdfRegistry,
  parseRegFile,
  findInstallScriptFiles,
  seedInstallScriptRegistry
};
