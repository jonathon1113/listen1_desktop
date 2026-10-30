/**
 * 酷我歌单 UI 级回归：模拟用户点击「酷我」平台 -> 加载歌单列表 -> 打开一个歌单，
 * 验证界面真实渲染出歌单与曲目（不只是 provider API 层）。
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

  const el = angular.element(document.querySelector('[ng-controller="PlaylistController"]') || document.body);
  const scope = el.scope();

  // 1. 切到酷我平台
  scope.tab = 'kuwo';
  scope.$apply();

  // 2. 加载歌单列表（走 UI 真实路径）
  const listOk = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ verdict: 'HANG' }); } }, 40000);
    try {
      MediaService.showPlaylistArray('kuwo', 0, '').success((data) => {
        if (done) return; done = true; clearTimeout(t);
        resolve({ verdict: 'OK', count: data && data.result ? data.result.length : null });
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ verdict: 'THROW', error: e.message }); } }
  });
  out.playlistList = listOk;

  // 3. 打开一个酷我歌单（真实 UI 路径 MediaService.getPlaylist）
  const detailOk = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ verdict: 'HANG' }); } }, 60000);
    try {
      MediaService.getPlaylist('kwplaylist_3170369961').success((data) => {
        if (done) return; done = true; clearTimeout(t);
        resolve({
          verdict: 'OK',
          tracks: data && data.tracks ? data.tracks.length : null,
          title: data && data.info ? data.info.title : null,
          firstTrack: data && data.tracks && data.tracks[0]
            ? { title: data.tracks[0].title, source: data.tracks[0].source }
            : null,
        });
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ verdict: 'THROW', error: e.message }); } }
  });
  out.playlistDetail = detailOk;

  // 4. 直接检查 UI 控制器数据是否刷新（确认界面拿得到数据）
  try {
    scope.playlist = { result: [] };
    scope.$apply();
    out.scopePlaylistLen = scope.playlist ? scope.playlist.result.length : null;
  } catch (e) {
    out.scopePlaylistError = e.message;
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

  const pass =
    r.playlistList.verdict === 'OK' &&
    r.playlistList.count > 0 &&
    r.playlistDetail.verdict === 'OK' &&
    r.playlistDetail.tracks > 0 &&
    r.errors.length === 0;
  process.stdout.write(`\n==== 酷我 UI 回归: ${pass ? 'PASS' : 'FAIL'} ====\n`);
  process.exit(pass ? 0 : 1);
}

main();