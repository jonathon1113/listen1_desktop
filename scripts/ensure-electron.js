/**
 * 自愈脚本：确保 node_modules/electron 的二进制可用。
 *
 * 背景：
 * electron 的 Windows 二进制并不包含在 npm 包内，而是由它自身的 postinstall
 * （install.js）下载并解压到 node_modules/electron/dist，再写入 path.txt。
 * 一旦该 postinstall 被 npm 跳过、或下载中途中断，node_modules/electron 就会停在
 * 「包已存在、二进制缺失」的半成品状态；此时 npm 认为依赖已满足，
 * 后续 npm install 只会提示 up to date 而不再重跑安装脚本，
 * 于是 npm run start 必然报：
 *   Error: Electron failed to install correctly, please delete node_modules/electron...
 *
 * 本脚本在 postinstall 与 start 之前各执行一次：
 * 已就绪则立即返回；缺失则调用 electron 官方 install.js 重新下载并解压。
 * 用法：
 *   node scripts/ensure-electron.js           宽松模式：修复失败只告警，不阻断安装
 *   node scripts/ensure-electron.js --strict  严格模式：修复失败返回非 0（用于启动前）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const strict = process.argv.includes('--strict');
const rootDir = path.join(__dirname, '..');
const electronDir = path.join(rootDir, 'node_modules', 'electron');
const packageJsonPath = path.join(electronDir, 'package.json');
const installScriptPath = path.join(electronDir, 'install.js');
const pathFilePath = path.join(electronDir, 'path.txt');
const versionFilePath = path.join(electronDir, 'dist', 'version');

const platform = process.env.npm_config_platform || os.platform();
const executableName =
  platform === 'win32'
    ? 'electron.exe'
    : platform === 'darwin' || platform === 'mas'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron';

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

/** 判定逻辑与 electron/install.js 的 isInstalled() 保持一致 */
function isReady() {
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }
  const version = require(packageJsonPath).version;
  const distVersion = readFileSafe(versionFilePath).replace(/^v/, '').trim();
  const pathFile = readFileSafe(pathFilePath).trim();
  if (distVersion !== version || pathFile !== executableName) {
    return false;
  }
  return fs.existsSync(path.join(electronDir, 'dist', pathFile));
}

/**
 * 读取项目根 .npmrc 并转成 npm_config_* 环境变量。
 *
 * npm 只会在「npm 生命周期脚本」里注入这些变量；直接用 node 执行本脚本时
 * 必须自行注入，否则 electron 会回落到 GitHub 默认源，下载动辄几十分钟甚至失败。
 */
function loadNpmrcEnv(baseEnv) {
  const env = Object.assign({}, baseEnv);
  const npmrcPath = path.join(rootDir, '.npmrc');
  if (!fs.existsSync(npmrcPath)) {
    return env;
  }
  const lines = fs.readFileSync(npmrcPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    const envKey = `npm_config_${key.replace(/-/g, '_')}`;
    if (!env[envKey]) {
      env[envKey] = value;
    }
  }
  return env;
}

/** 调用 electron 官方安装脚本完成下载与解压 */
function runInstall(force) {
  if (!fs.existsSync(installScriptPath)) {
    console.warn(
      '[ensure-electron] 未找到 node_modules/electron/install.js，请先执行: npm install electron'
    );
    return false;
  }
  const env = loadNpmrcEnv(process.env);
  if (force) {
    env.force_no_cache = 'true';
  }
  console.log(
    `[ensure-electron] 正在下载 electron 二进制（${force ? '忽略缓存' : '优先复用缓存'}，镜像: ${
      env.npm_config_electron_mirror || '默认源'
    }）...`
  );
  const result = spawnSync(process.execPath, [installScriptPath], { stdio: 'inherit', env });
  return result.status === 0;
}

if (isReady()) {
  console.log('[ensure-electron] electron 二进制已就绪，无需修复');
  process.exit(0);
}

console.log('[ensure-electron] 检测到 electron 二进制缺失，开始自动修复...');

let ok = runInstall(false);
if (!ok && isReady()) {
  ok = true;
}
if (!ok) {
  // 缓存可能损坏，忽略缓存重试一次
  console.warn('[ensure-electron] 首次修复失败，尝试忽略缓存重新下载...');
  ok = runInstall(true) && isReady();
}

if (ok && isReady()) {
  console.log('[ensure-electron] 修复完成，electron 可正常使用');
  process.exit(0);
}

console.warn('[ensure-electron] 自动修复失败，可手动执行以下命令重试：');
console.warn('  npm rebuild electron');
console.warn('  或删除 node_modules\\electron 目录后重新执行 npm install');
process.exit(strict ? 1 : 0);
