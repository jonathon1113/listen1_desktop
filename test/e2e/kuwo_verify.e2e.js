/**
 * 酷我（kuwo）歌单加载回归验证
 *
 * 覆盖：
 *   1. show_playlist（歌单列表）
 *   2. get_playlist（歌单详情，含曲目）—— 本次修复目标
 *   3. kw_render_tracks 分页取曲目
 *   4. token 缓存与失效重取
 *   5. 失败不挂起（网络异常时也必须回调）
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

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
      }, 600000);
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
  const hit = list.find((t) => t.type === 'page' && t.url.includes('listen1.html'));
  if (!hit) throw new Error('未找到主窗口 target');
  return hit;
}

const SCRIPT = `(async () => {
  const out = {};
  const errors = [];
  window.addEventListener('error', (e) => errors.push('ERROR: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', (e) =>
    errors.push('REJECTION: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)))
  );

  const withTimeout = (fn, ms, label) =>
    new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ verdict: 'HANG', label }); } }, ms);
      try {
        fn((v) => { if (done) return; done = true; clearTimeout(t); resolve(v); });
      } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ verdict: 'THROW', error: e.message }); } }
    });

  // 1. 歌单列表
  const list = await withTimeout((cb) => {
    kuwo.show_playlist('/show_playlist?offset=0&filter_id=').success((v) => {
      cb({
        verdict: 'OK',
        count: v && v.result ? v.result.length : null,
        firstId: v && v.result && v.result[0] ? v.result[0].id : null,
      });
    });
  }, 40000, 'show_playlist');
  out.showPlaylist = list;

  // 2. 歌单详情（修复目标）
  const pid = '3134372426';
  const detail = await withTimeout((cb) => {
    kuwo.get_playlist('/playlist?list_id=kwplaylist_' + pid).success((v) => {
      cb({
        verdict: 'OK',
        tracks: v && v.tracks ? v.tracks.length : null,
        title: v && v.info ? v.info.title : null,
        firstTrack: v && v.tracks && v.tracks[0]
          ? { title: v.tracks[0].title, source: v.tracks[0].source, id: v.tracks[0].id }
          : null,
      });
    });
  }, 60000, 'get_playlist');
  out.getPlaylist = detail;

  // 3. kw_render_tracks 直接调用
  const render = await withTimeout((cb) => {
    kuwo.kw_render_tracks('/playlist?list_id=kwplaylist_' + pid, 1, (err, tracks) => {
      cb({ verdict: 'OK', err: err ? String(err) : null, tracks: tracks ? tracks.length : null });
    });
  }, 40000, 'kw_render_tracks');
  out.kwRenderTracks = render;

  // 4. token 状态
  out.tokenCached = !!kuwo.kw_token_value;
  out.tokenLen = kuwo.kw_token_value ? kuwo.kw_token_value.length : 0;

  // 5. token 失效后重取（模拟服务端换 token）
  const before = kuwo.kw_token_value;
  kuwo.kw_token_value = null;
  const refetch = await withTimeout((cb) => {
    kuwo.kw_get_token((t) => {
      cb({ verdict: 'OK', got: !!t, len: t ? String(t).length : 0, changed: t !== before });
    });
  }, 40000, 'kw_get_token');
  out.tokenRefetch = refetch;

  // 6. 失效 token 的重试分支（服务端返回 success:false）
  const retry = await withTimeout((cb) => {
    kuwo.kw_cookie_get('https://www.kuwo.cn/api/www/playlist/playListInfo?pid=' + pid + '&pn=1&rn=100&httpsStatus=1', (r) => {
      cb({
        verdict: 'OK',
        hasResponse: !!r,
        musicListLen: r && r.data && r.data.data && r.data.data.musicList ? r.data.data.musicList.length : null,
      });
    });
  }, 40000, 'kw_cookie_get');
  out.kwCookieGet = retry;

  // 7. 失败不挂起：用一个必定失败的 URL
  const failure = await withTimeout((cb) => {
    kuwo.kw_cookie_get('https://www.kuwo.cn/api/www/playlist/playListInfo?pid=notexist999&pn=1&rn=100&httpsStatus=1', (r) => {
      cb({ verdict: 'OK', hasResponse: !!r, success: r && r.data ? r.data.success : undefined });
    });
  }, 40000, 'kw_cookie_get-fail');
  out.kwCookieGetFail = failure;

  // 8. 搜索仍然正常
  const search = await withTimeout((cb) => {
    kuwo.search('/search?keywords=%E5%91%A8%E6%9D%B0%E4%BC%A6&curpage=1&type=0').success((v) => {
      cb({ verdict: 'OK', count: v && v.result ? v.result.length : null });
    });
  }, 40000, 'search');
  out.search = search;

  out.errors = errors;
  return out;
})()`;

async function main() {
  const target = await findMainTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  let r;
  try {
    r = await cdp.evaluate(SCRIPT);
  } finally {
    cdp.close();
  }
  process.stdout.write(`\n${JSON.stringify(r, null, 2)}\n`);

  const pass =
    r.showPlaylist.verdict === 'OK' &&
    r.showPlaylist.count > 0 &&
    r.getPlaylist.verdict === 'OK' &&
    r.getPlaylist.tracks > 0 &&
    r.kwRenderTracks.verdict === 'OK' &&
    r.kwRenderTracks.tracks > 0 &&
    r.tokenRefetch.verdict === 'OK' &&
    r.tokenRefetch.got === true &&
    r.kwCookieGet.verdict === 'OK' &&
    r.kwCookieGet.musicListLen > 0 &&
    r.kwCookieGetFail.verdict === 'OK' &&
    r.search.verdict === 'OK' &&
    r.search.count > 0 &&
    r.errors.length === 0;
  process.stdout.write(`\n==== 酷我回归结果: ${pass ? 'PASS' : 'FAIL'} ====\n`);
  process.exit(pass ? 0 : 1);
}

main();