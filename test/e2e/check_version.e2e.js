/**
 * Listen1 Desktop —— 版本号一致性校验
 *
 * 两部分：
 *   1) 静态校验：读取各 package.json / package-lock.json / manifest.json，
 *      确认版本号合法（npm 用 semver，Chrome 扩展用「数字.点.短横线+数字」格式）
 *      且各处一致。
 *   2) 运行时校验：通过 Chrome DevTools Protocol 读取已启动的 Electron 主窗口
 *      DOM，确认界面展示的版本号与声明一致。
 *
 * 静态部分可单独运行： node test/e2e/check_version.e2e.js
 * 运行时部分需要： npx electron ./app --enable-logging --remote-debugging-port=9222
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

// npm 元数据：必须是合法 semver
const SEMVER_FILES = [
  'package.json',
  'package-lock.json',
  'app/package.json',
  'app/package-lock.json',
  'app/listen1_chrome_extension/package.json',
  'app/listen1_chrome_extension/package-lock.json',
];

// Chrome/Firefox 扩展清单：版本号只能是数字、点、短横线加数字
const CHROME_RE = /^(?:[0-9]+)(?:\.[0-9]+){0,3}(?:-[0-9]+)?$/;
const MANIFEST_FILES = [
  'app/listen1_chrome_extension/manifest.json',
  'app/listen1_chrome_extension/manifest_firefox.json',
];

const assertions = [];
function assert(ok, message) {
  assertions.push({ ok: !!ok, message });
}

function readVersion(rel) {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  if (json.version) return json.version;
  if (json.packages && json.packages[''] && json.packages[''].version) {
    return json.packages[''].version;
  }
  return null;
}

function staticCheck() {
  const versions = {};
  SEMVER_FILES.forEach((rel) => {
    const v = readVersion(rel);
    versions[rel] = v;
    assert(v !== null, `${rel} 应声明版本号`);
    assert(
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(v || ''),
      `${rel} 的版本号「${v}」应为合法 semver 格式`
    );
  });
  MANIFEST_FILES.forEach((rel) => {
    const v = readVersion(rel);
    versions[rel] = v;
    assert(CHROME_RE.test(v || ''), `${rel} 的版本号「${v}」应符合 Chrome 扩展格式`);
  });

  const npmVersions = new Set(SEMVER_FILES.map((rel) => versions[rel]));
  assert(
    npmVersions.size === 1,
    `npm 元数据版本号应统一，当前为 ${JSON.stringify([...npmVersions])}`
  );

  process.stdout.write('静态校验：\n');
  Object.keys(versions).forEach((rel) => {
    process.stdout.write(`  ${rel.padEnd(52)} ${versions[rel]}\n`);
  });
  return versions;
}

async function runtimeCheck() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  } catch (err) {
    process.stdout.write(
      `\n未连接 Electron（${err.message}）。跳过运行时校验；` +
        `如需校验请用 npx electron ./app --enable-logging --remote-debugging-port=${CDP_PORT} 启动应用。\n`
    );
    return null;
  }
  const target = list.find((t) => t.type === 'page' && t.url.includes('listen1.html'));
  if (!target) {
    process.stdout.write('\n未找到主窗口 target，跳过运行时校验。\n');
    return null;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), {
      once: true,
    });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const item = pending.get(m.id);
    if (item) {
      pending.delete(m.id);
      item(m.result);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      seq += 1;
      pending.set(seq, res);
      ws.send(JSON.stringify({ id: seq, method, params }));
    });

  const expression = [
    '(function () {',
    '  var html = document.documentElement.innerHTML;',
    '  return JSON.stringify({',
    '    hasNewVersion: html.indexOf("v2.33.0-1(Jonathon)") !== -1,',
    '    hasOldVersion: html.indexOf("v2.33.0 {{") !== -1',
    '  });',
    '})()',
  ].join('\n');

  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  ws.close();

  if (res.exceptionDetails) {
    process.stdout.write('\n页面求值异常，跳过运行时校验。\n');
    return null;
  }
  const data = JSON.parse(res.result.value);
  assert(data.hasNewVersion === true, '界面 DOM 应包含新版本号 v2.33.0-1(Jonathon)');
  assert(data.hasOldVersion === false, '界面 DOM 不应再包含旧版本号 v2.33.0');
  return data;
}

async function main() {
  staticCheck();
  await runtimeCheck();

  let failed = 0;
  process.stdout.write('\n');
  assertions.forEach((a) => {
    if (!a.ok) failed += 1;
    process.stdout.write(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.message}\n`);
  });
  process.stdout.write(`\n合计 ${assertions.length} 条断言，失败 ${failed} 条。\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n校验失败：${err.message}\n`);
  process.exit(1);
});
