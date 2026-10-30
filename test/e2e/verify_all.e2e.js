/**
 * 打包版综合回归：一次连接 CDP，覆盖酷我 / 网易云 / 搜索 / UI DOM 渲染。
 * 用于验证「取消 submodule 改造」后桌面端功能未受影响。
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
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), {
        once: true,
      });
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
      throw new Error(
        `页面脚本异常: ${(d.exception && d.exception.description) || d.text}`
      );
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 带超时保护的回调等待：任何异步环节未回调都必须判定为 HANG，而不是无限等待
  const withTimeout = (fn, ms) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ verdict: 'HANG' }); } }, ms);
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    try { fn(finish); } catch (e) { finish({ verdict: 'THROW', error: e.message }); }
  });

  const searchOn = (source) => withTimeout((resolve) => {
    MediaService.search(source, { keywords: 'zhoujielun', curpage: 1, type: 0 }).success((data) =>
      resolve({ verdict: 'OK', count: data && data.result ? data.result.length : null }));
  }, 40000);

  const playlistList = (source) => withTimeout((resolve) => {
    MediaService.showPlaylistArray(source, 0, '').success((data) => {
      const list = data && data.result ? data.result : [];
      resolve({ verdict: 'OK', count: list.length, firstId: list[0] ? list[0].id : null });
    });
  }, 40000);

  const playlistDetail = (listId) => withTimeout((resolve) => {
    MediaService.getPlaylist(listId).success((data) =>
      resolve({
        verdict: 'OK',
        tracks: data && data.tracks ? data.tracks.length : null,
        title: data && data.info ? data.info.title : null,
        firstSource: data && data.tracks && data.tracks[0] ? data.tracks[0].source : null,
      }));
  }, 60000);

  // ---- 酷我 ----
  out.kuwoPlaylistList = await playlistList('kuwo');
  out.kuwoPlaylistDetail = await playlistDetail(
    out.kuwoPlaylistList.firstId || 'kwplaylist_3170369961');
  out.kuwoSearch = await searchOn('kuwo');

  // 酷我失败分支：歌单不存在时也必须回调，不得挂起
  out.kuwoFailBranch = await withTimeout((resolve) => {
    const p = MediaService.getPlaylist('kwplaylist_NOT_EXIST_123456');
    if (p && p.success) {
      p.success(() => resolve({ verdict: 'OK', settled: true }));
    } else {
      resolve({ verdict: 'NO_CALLBACK' });
    }
  }, 30000);

  // ---- 网易云 ----
  out.neteasePlaylistList = await playlistList('netease');
  out.neteasePlaylistDetail = await playlistDetail(
    out.neteasePlaylistList.firstId || '3778678');
  out.neteaseSearch = await searchOn('netease');

  // ---- UI 层：走 InstantSearchController 的真实搜索路径 ----
  try {
    const host = document.querySelector('[ng-controller="InstantSearchController"]');
    const scope = angular.element(host).scope();
    scope.tab = 'kuwo';
    scope.searchType = 0;
    scope.keywords = 'zhoujielun';
    scope.$apply();
    await sleep(6000);
    out.uiScopeKeywords = scope.keywords;
    out.uiScopeTab = scope.tab;
    out.uiScopeResultCount = scope.result ? scope.result.length : null;
    out.uiScopeLoading = scope.loading;
    out.uiDomSongLiCount = document.querySelectorAll(
      'ul.detail-songlist li:not(.head)').length;
  } catch (e) {
    out.uiError = e.message;
  }

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

  const checks = [
    ['酷我歌单列表', r.kuwoPlaylistList.verdict === 'OK' && r.kuwoPlaylistList.count > 0],
    ['酷我歌单详情', r.kuwoPlaylistDetail.verdict === 'OK' && r.kuwoPlaylistDetail.tracks > 0],
    ['酷我搜索', r.kuwoSearch.verdict === 'OK' && r.kuwoSearch.count > 0],
    ['酷我失败分支不挂起', r.kuwoFailBranch.verdict === 'OK'],
    ['网易云歌单列表', r.neteasePlaylistList.verdict === 'OK' && r.neteasePlaylistList.count > 0],
    ['网易云歌单详情', r.neteasePlaylistDetail.verdict === 'OK' && r.neteasePlaylistDetail.tracks > 0],
    ['网易云搜索', r.neteaseSearch.verdict === 'OK' && r.neteaseSearch.count > 0],
    ['UI scope 拿到结果', (r.uiScopeResultCount || 0) > 0],
    ['UI DOM 渲染出结果', (r.uiDomSongLiCount || 0) > 0],
    ['无页面错误', Array.isArray(r.errors) && r.errors.length === 0],
  ];
  let pass = true;
  for (const [name, ok] of checks) {
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
    if (!ok) pass = false;
  }
  process.stdout.write(`\n==== 综合回归: ${pass ? 'PASS' : 'FAIL'} ====\n`);
  process.exit(pass ? 0 : 1);
}

main();
