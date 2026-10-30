/**
 * 决定性复现：netease.ne_ensure_cookie 的「无 else 分支」缺陷
 *
 * 复现步骤：
 *   1. 清空 music.163.com 全部 Cookie
 *   2. 第 1 次 provider.search  -> 预期成功（Cookie 缺失 -> 走设置分支 -> callback 触发）
 *   3. 第 2 次 provider.search  -> 预期永久挂起（Cookie 已存在 -> if 不成立 -> callback 不触发）
 *   4. provider.get_playlist   -> 预期永久挂起（同样依赖 ne_ensure_cookie）
 *   5. 验证 failover 路径：bootstrap_track 失败 -> loweb.js 走 provider.search -> 挂起
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const TARGET_HINT = 'listen1.html';

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      const item = this.pending.get(msg.id);
      if (item) {
        this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(msg.error.message));
        else item.resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    this.seq += 1;
    const id = this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 180000);
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面脚本异常: ${(d.exception && d.exception.description) || d.text}`);
    }
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

async function findMainTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const list = await res.json();
  const hit = list.find((t) => t.type === 'page' && t.url.includes(TARGET_HINT));
  if (!hit) throw new Error(`未找到主窗口 target（url 含 ${TARGET_HINT}）`);
  return hit;
}

const INJECTED_SCRIPT = `(async () => {
  const out = { steps: [] };

  const step = async (name, fn) => {
    const rec = { name };
    try {
      rec.data = await fn();
      rec.ok = true;
    } catch (e) {
      rec.ok = false;
      rec.error = (e && e.message) || String(e);
    }
    out.steps.push(rec);
    return rec;
  };

  const remote = require('@electron/remote');
  const session = remote.session.defaultSession;

  const listCookies = async () => {
    const jar = await session.cookies.get({ domain: '.music.163.com' });
    return jar.map((c) => c.name);
  };

  const clearCookies = async () => {
    const jar = await session.cookies.get({ domain: '.music.163.com' });
    for (const c of jar) {
      await session.cookies.remove(c.url, c.name);
    }
    return (await listCookies()).length;
  };

  // 调用 provider.search 并观察是否在 20s 内返回
  const callSearch = (timeoutMs) =>
    new Promise((resolve) => {
      let fired = false;
      const t = setTimeout(() => {
        if (!fired) { fired = true; resolve({ returned: false, verdict: 'HANG(挂起)' }); }
      }, timeoutMs);
      try {
        netease.search('/search?keywords=%E5%91%A8%E6%9D%B0%E4%BC%A6&curpage=1&type=0').success((r) => {
          if (fired) return;
          fired = true;
          clearTimeout(t);
          resolve({
            returned: true,
            verdict: 'OK',
            count: r && r.result ? r.result.length : null,
          });
        });
      } catch (e) {
        if (fired) return;
        fired = true;
        clearTimeout(t);
        resolve({ returned: true, verdict: 'THROW', error: e.message });
      }
    });

  const callGetPlaylist = (timeoutMs) =>
    new Promise((resolve) => {
      let fired = false;
      const t = setTimeout(() => {
        if (!fired) { fired = true; resolve({ returned: false, verdict: 'HANG(挂起)' }); }
      }, timeoutMs);
      try {
        netease.get_playlist('/playlist?list_id=neplaylist_3778678').success((r) => {
          if (fired) return;
          fired = true;
          clearTimeout(t);
          resolve({
            returned: true,
            verdict: 'OK',
            trackCount: r && r.tracks ? r.tracks.length : null,
          });
        });
      } catch (e) {
        if (fired) return;
        fired = true;
        clearTimeout(t);
        resolve({ returned: true, verdict: 'THROW', error: e.message });
      }
    });

  // ---------- 步骤 0：清空所有 Cookie，模拟「全新用户」----------
  await step('0-clear-cookies', async () => {
    const remaining = await clearCookies();
    return { cookiesLeft: remaining, cookies: await listCookies() };
  });

  // ---------- 步骤 1：第一次 search ----------
  await step('1-search-1st-after-clear', async () => {
    const r = await callSearch(20000);
    return { ...r, cookiesNow: await listCookies() };
  });

  // ---------- 步骤 2：第二次 search（Cookie 已存在）----------
  await step('2-search-2nd-cookie-exists', async () => {
    const r = await callSearch(20000);
    return r;
  });

  // ---------- 步骤 3：get_playlist（同样依赖 ne_ensure_cookie）----------
  await step('3-get_playlist', async () => {
    return await callGetPlaylist(20000);
  });

  // ---------- 步骤 4：验证 failover 路径会挂起 ----------
  // loweb.js: provider.bootstrap_track 失败 -> failover -> provider.search -> 挂起
  await step('4-failover-path-hangs', async () => {
    const track = {
      id: 'netrack_33894312', title: 'test', artist: 'test',
      album: 'test', source: 'netease', img_url: '',
    };
    return await new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ settled: false, verdict: 'HANG(failover 未 settle，播放卡死)' });
        }
      }, 25000);
      try {
        MediaService.bootstrapTrack(
          track,
          (ok) => { if (settled) return; settled = true; clearTimeout(t); resolve({ settled: true, success: true, url: ok && ok.url }); },
          (fail) => { if (settled) return; settled = true; clearTimeout(t); resolve({ settled: true, success: false, fail }); }
        );
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ settled: true, threw: e.message });
      }
    });
  });

  // ---------- 步骤 5：确认 axios 直接调用（绕过 ne_ensure_cookie）始终正常 ----------
  await step('5-direct-axios-bypasses-bug', async () => {
    try {
      const resp = await axios.post(
        'https://music.163.com/api/search/pc',
        's=test&offset=0&limit=2&type=1000'
      );
      return {
        httpStatus: resp.status,
        bizCode: resp.data ? resp.data.code : null,
        verdict: 'axios 本身没问题，瓶颈在 ne_ensure_cookie',
      };
    } catch (e) {
      return { threw: true, error: e.message };
    }
  });

  return out;
})()`;

async function main() {
  let target;
  try {
    target = await findMainTarget();
  } catch (err) {
    process.stdout.write(`\n无法连接：${err.message}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write('\n已连接，开始复现...\n');

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  let r;
  try {
    r = await cdp.evaluate(INJECTED_SCRIPT);
  } finally {
    cdp.close();
  }

  (r.steps || []).forEach((s) => {
    process.stdout.write(`\n--- ${s.name} ---\n`);
    process.stdout.write(`${JSON.stringify(s.ok ? s.data : { error: s.error }, null, 2)}\n`);
  });
  process.exit(0);
}

main();
