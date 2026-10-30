/**
 * 单元测试：不依赖网络与 Electron，验证 provider 层异步回调必定触发。
 *
 * 背景：酷我/网易云歌单加载永久挂起的根因，是失败分支没有回调，
 * 导致 async.concat 的迭代器永不 resolve。这里对每条失败路径做超时断言。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.join(__dirname, '..', 'app', 'listen1_chrome_extension');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}${detail ? ` (${detail})` : ''}\n`);
  }
}

function group(title) {
  process.stdout.write(`\n用例${title}\n`);
}

const ASYNC_SRC = fs.readFileSync(
  path.join(EXT_DIR, 'js', 'vendor', 'async.min.js'),
  'utf8'
);

/** 浏览器里 provider 是顶层 class 声明，这里用 vm 加载后追加导出 */
function loadProvider(fileName, globals) {
  const code = fs.readFileSync(path.join(EXT_DIR, 'js', 'provider', fileName), 'utf8');
  const sandbox = Object.assign(
    {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Date,
      Math,
      JSON,
      RegExp,
      Error,
      TypeError,
      parseInt,
      parseFloat,
      isNaN,
      String,
      Number,
      Boolean,
      Array,
      Object,
      URLSearchParams,
      encodeURIComponent,
      decodeURIComponent,
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      location: { href: 'https://music.163.com/', protocol: 'https:' },
      navigator: { userAgent: 'node-test' },
      document: { cookie: '', title: '' },
      getParameterByName: (name, url) => {
        const m = new RegExp(`[?&]${name}=([^&#]*)`).exec(url || '');
        return m ? decodeURIComponent(m[1]) : '';
      },
    },
    globals
  );
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ASYNC_SRC, sandbox, { filename: 'async.min.js' });
  const exportName = fileName === 'kuwo.js' ? 'kuwo' : 'netease';
  vm.runInContext(
    `${code}\n;globalThis.__exports = ${exportName};`,
    sandbox,
    { filename: fileName }
  );
  return sandbox.__exports;
}

/** 断言回调在 timeout 毫秒内被触发（防止永久挂起）；args 保留全部回调参数 */
function settlesWithin(fn, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ settled: false, args: [] });
      }
    }, timeout);
    const finish = (...args) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value: args[0], args });
      }
    };
    try {
      fn(finish);
    } catch (e) {
      finish({ threw: e.message });
    }
  });
}

const failingAxios = {
  get: () => Promise.reject(new Error('network down')),
  post: () => Promise.reject(new Error('network down')),
};

function cookieMocks(value) {
  return {
    cookieGet: (opts, cb) => cb(value === undefined ? null : { value }),
    cookieSet: (opts, cb) => cb(),
    cookieRemove: (opts, cb) => cb(),
  };
}

async function testKuwo() {
  group('酷我 provider：异步回调必定触发');

  // 1. Secret 头与 Cookie 头必须同时下发
  let observed = null;
  const spyAxios = {
    get: (url, opts) => {
      observed = { url, headers: (opts && opts.headers) || {} };
      return Promise.reject(new Error('network down'));
    },
  };
  const kuwoSpy = loadProvider(
    'kuwo.js',
    Object.assign(cookieMocks('TOKENVALUE'), { axios: spyAxios })
  );
  await settlesWithin((cb) =>
    kuwoSpy.kw_cookie_get('https://example.com/x', cb)
  );
  check(
    'kw_cookie_get 发送了 Secret 头',
    typeof observed.headers.Secret === 'string' && observed.headers.Secret.length > 0,
    `Secret=${observed.headers.Secret}`
  );
  check(
    'kw_cookie_get 同时发送了 Cookie 头',
    typeof observed.headers.Cookie === 'string' &&
      observed.headers.Cookie.includes('TOKENVALUE'),
    `Cookie=${observed.headers.Cookie}`
  );

  // 2. axios 失败时 kw_cookie_get 必须回调
  const kuwo = loadProvider(
    'kuwo.js',
    Object.assign(cookieMocks('TOKENVALUE'), { axios: failingAxios })
  );
  const r2 = await settlesWithin((cb) =>
    kuwo.kw_cookie_get('https://example.com/x', cb)
  );
  check('kw_cookie_get 网络失败时仍回调', r2.settled);

  // 3. 服务端返回 success:false 时必须回调（重试分支）
  const illegalAxios = {
    get: () =>
      Promise.resolve({ data: { success: false, message: 'illegal' } }),
  };
  const kuwoIllegal = loadProvider(
    'kuwo.js',
    Object.assign(cookieMocks('TOKENVALUE'), { axios: illegalAxios })
  );
  const r3 = await settlesWithin((cb) =>
    kuwoIllegal.kw_cookie_get('https://example.com/x', cb)
  );
  check('kw_cookie_get 返回 success:false 时仍回调', r3.settled);

  // 4. 取不到 token 时 kw_get_token 必须回调空串
  const kuwoNoCookie = loadProvider(
    'kuwo.js',
    Object.assign(cookieMocks(undefined), { axios: failingAxios })
  );
  const r4 = await settlesWithin((cb) => kuwoNoCookie.kw_get_token(cb));
  check('kw_get_token 取不到 token 时仍回调', r4.settled);
  check(
    'kw_get_token 回调值为空串',
    r4.value === '',
    `实际=${JSON.stringify(r4.value)}`
  );

  // 5. 响应结构异常时 kw_render_tracks 必须回调空数组
  const weirdAxios = {
    get: () => Promise.resolve({ data: { success: true, data: {} } }),
  };
  const kuwoWeird = loadProvider(
    'kuwo.js',
    Object.assign(cookieMocks('TOKENVALUE'), { axios: weirdAxios })
  );
  const r5 = await settlesWithin((cb) =>
    kuwoWeird.kw_render_tracks('/playlist?list_id=kwplaylist_1', 1, cb)
  );
  check('kw_render_tracks 响应缺 musicList 时仍回调', r5.settled);
  check(
    'kw_render_tracks 缺 musicList 时回调空数组',
    r5.args[0] === null && Array.isArray(r5.args[1]) && r5.args[1].length === 0,
    `实际=${JSON.stringify(r5.args)}`
  );

  // 6. kw_get_playlist 网络失败时必须回调空结果
  const r6 = await settlesWithin((cb) =>
    kuwo.kw_get_playlist('/playlist?list_id=kwplaylist_1').success(cb)
  );
  check('kw_get_playlist 网络失败时仍回调', r6.settled);
  check(
    'kw_get_playlist 失败回调含空 tracks',
    r6.value && Array.isArray(r6.value.tracks) && r6.value.tracks.length === 0,
    `实际=${JSON.stringify(r6.value)}`
  );
}

async function testNetease() {
  group('网易云 provider：异步回调必定触发');

  // 1. cookie 缺失 -> 走 cookieSet 分支，必须回调
  const netease = loadProvider(
    'netease.js',
    Object.assign(cookieMocks(undefined), { axios: failingAxios })
  );
  const r1 = await settlesWithin((cb) => netease.ne_ensure_cookie(cb));
  check('ne_ensure_cookie cookie 缺失时仍回调', r1.settled);

  // 2. cookie 齐全 -> 走 else 分支（此前缺失导致永久挂起的分支）
  const neteaseHasCookie = loadProvider(
    'netease.js',
    Object.assign(cookieMocks('EXISTING'), { axios: failingAxios })
  );
  const r2 = await settlesWithin((cb) => neteaseHasCookie.ne_ensure_cookie(cb));
  check('ne_ensure_cookie cookie 齐全时仍回调', r2.settled);
}

async function main() {
  process.stdout.write('Listen1 provider 单元测试\n');
  await testKuwo();
  await testNetease();
  process.stdout.write(`\n合计 ${passed + failed} 条断言，失败 ${failed} 条\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
