/**
 * 打包版综合回归：一次连接 CDP，覆盖酷我 / 网易云 / 搜索 / UI DOM 渲染。
 * 用于验证「取消 submodule 改造」后桌面端功能未受影响。
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const http = require("http");
const https = require("https");

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
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
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error("WebSocket 连接失败")),
        {
          once: true,
        }
      );
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
    const res = await this.send("Runtime.evaluate", {
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
  const hit = list.find(
    (t) => t.type === "page" && t.url.includes("listen1.html")
  );
  if (!hit) throw new Error("未找到主窗口 target");
  return hit;
}

/**
 * 轮询等待应用真正就绪（angular 已加载且主控制器已实例化），
 * 避免用固定 sleep 猜加载时间。
 * @param {CDP} cdp
 * @param {number} timeoutMs
 */
async function waitForApp(cdp, timeoutMs = 30000) {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) {
    try {
      const ok = await cdp.evaluate(
        "!!(window.angular && document.querySelector('[ng-controller=\"InstantSearchController\"]'))"
      );
      if (ok) return Date.now() - s;
    } catch (e) {
      /* 页面还没加载完，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("应用未在超时内就绪");
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
      resolve({
        verdict: 'OK',
        count: data && data.result ? data.result.length : null,
        track: data && data.result && data.result[0] ? data.result[0] : null,
      }));
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
        firstTrack: data && data.tracks && data.tracks[0] ? data.tracks[0] : null,
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

  // ---- 酷狗 ----
  out.kugouPlaylistList = await playlistList('kugou');
  out.kugouPlaylistDetail = await playlistDetail(
    out.kugouPlaylistList.firstId || 'kgplaylist_8304355');
  out.kugouSearch = await searchOn('kugou');
  out.kugouSearchPlaylist = await withTimeout((resolve) => {
    MediaService.search('kugou', { keywords: 'zhoujielun', curpage: 1, type: 1 }).success((data) =>
      resolve({ verdict: 'OK', count: data && data.result ? data.result.length : null }));
  }, 40000);

  // 酷狗播放地址：必须走真实网关接口拿到可播放地址
  const kgTrack = (out.kugouSearch && out.kugouSearch.track) || null;
  out.kugouPlay = await withTimeout((resolve) => {
    if (!kgTrack) { resolve({ verdict: 'NO_TRACK' }); return; }
    kugou.bootstrap_track(kgTrack,
      (resp) => resolve({ verdict: 'OK', url: (resp && resp.url) || null, bitrate: resp && resp.bitrate }),
      (err) => resolve({ verdict: 'FAIL', error: JSON.stringify(err || {}) }));
  }, 120000);

  // 页面内真实加载音频，确认 Electron 播放器能拉到数据
  out.kugouAudioLoad = await withTimeout((resolve) => {
    if (!out.kugouPlay || !out.kugouPlay.url) { resolve({ verdict: 'NO_URL' }); return; }
    const audio = new Audio();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    audio.addEventListener('canplay', () =>
      done({ verdict: 'OK', duration: audio.duration, readyState: audio.readyState }));
    audio.addEventListener('error', () =>
      done({ verdict: 'ERROR', code: audio.error ? audio.error.code : null }));
    audio.src = out.kugouPlay.url;
    audio.load();
  }, 60000);

  // 酷狗歌词：优先用歌单第一首（确定有歌词），搜索首曲可能是无歌词的翻唱
  const kgLyricTrack = (out.kugouPlaylistDetail && out.kugouPlaylistDetail.firstTrack) || kgTrack;
  out.kugouLyric = await withTimeout((resolve) => {
    if (!kgLyricTrack) { resolve({ verdict: 'NO_TRACK' }); return; }
    MediaService.getLyric(kgLyricTrack.id, kgLyricTrack.album_id, kgLyricTrack.lyric_url, '').success((data) => {
      const l = (data && data.lyric) || '';
      resolve({ verdict: 'OK', length: l.length, head: l.slice(0, 80) });
    });
  }, 60000);

  // 酷狗失败分支：拿不到地址时必须回调 failure，不得挂起
  out.kugouFailBranch = await withTimeout((resolve) => {
    kugou.bootstrap_track({ id: 'kgtrack_NOT_EXIST_HASH_123456' },
      () => resolve({ verdict: 'OK', settled: true, unexpected: true }),
      () => resolve({ verdict: 'OK', settled: true }));
  }, 120000);

  // ---- 网易云 ----
  out.neteasePlaylistList = await playlistList('netease');
  out.neteasePlaylistDetail = await playlistDetail(
    out.neteasePlaylistList.firstId || '3778678');
  out.neteaseSearch = await searchOn('netease');

  // ---- UI 层：走 InstantSearchController 的真实搜索路径 ----
  // DOM 渲染依赖 angular digest，固定等待会误判，这里轮询等待结果出现。
  const waitForDom = async (maxTicks) => {
    for (let i = 0; i < maxTicks; i += 1) {
      const n = document.querySelectorAll('ul.detail-songlist li:not(.head)').length;
      if (n > 0) return n;
      await sleep(500);
    }
    return document.querySelectorAll('ul.detail-songlist li:not(.head)').length;
  };
  try {
    const host = document.querySelector('[ng-controller="InstantSearchController"]');
    const scope = angular.element(host).scope();
    scope.tab = 'kuwo';
    scope.searchType = 0;
    scope.keywords = 'zhoujielun';
    scope.$apply();
    // 先等结果渲染出来，再读取 scope 上的数据，否则读到的还是上一次的旧值
    out.uiDomSongLiCount = await waitForDom(40);
    out.uiScopeKeywords = scope.keywords;
    out.uiScopeTab = scope.tab;
    out.uiScopeResultCount = scope.result ? scope.result.length : null;
    out.uiScopeLoading = scope.loading;
  } catch (e) {
    out.uiError = e.message;
  }

  // ---- 真实 UI 播放链路：搜索 → 加入播放列表 → 播放 → 确认播放器真的在放 ----
  out.kugouUiPlay = await withTimeout((resolve) => {
    const host = document.querySelector('[ng-controller="InstantSearchController"]');
    const scope = angular.element(host).scope();
    scope.searchType = 0;
    scope.keywords = 'zhoujielun';
    scope.$apply();
    // 必须走 changeSourceTab 才会真正发起酷狗搜索：
    // 直接改 scope.tab 不会触发 $watch('keywords')（关键字没变），result 里
    // 留的还是上一个平台的结果，测的就不是酷狗了。
    scope.changeSourceTab('kugou');
    const t0 = Date.now();
    const waitResult = () => {
      const song = scope.result && scope.result[0];
      const domCount = document.querySelectorAll('ul.detail-songlist li:not(.head)').length;
      const isKugou = song && song.source === 'kugou';
      if (!song || !isKugou || domCount === 0) {
        if (Date.now() - t0 > 40000) {
          resolve({ verdict: 'NO_RESULT', domCount, source: song ? song.source : null });
          return;
        }
        setTimeout(waitResult, 500);
        return;
      }
      try {
        l1Player.addTrack(song);
      } catch (e) {
        resolve({ verdict: 'THROW', error: e.message });
        return;
      }
      // 等曲目进入播放列表后再触发播放（与界面上的 add-and-play 指令一致）
      const waitTrack = () => {
        const tp = window.threadPlayer;
        if (tp && tp.playlist.some((a) => a.id === song.id)) {
          l1Player.playById(song.id);
          watchPlay();
          return;
        }
        if (Date.now() - t0 > 30000) {
          resolve({ verdict: 'TRACK_NOT_ADDED', playlistLen: tp ? tp.playlist.length : null });
          return;
        }
        setTimeout(waitTrack, 300);
      };
      const watchPlay = () => {
        const tp = window.threadPlayer;
        const cur = tp && tp.currentAudio;
        const howl = tp && tp.currentHowl;
        let playing = false;
        let state = null;
        try {
          playing = !!(howl && howl.playing && howl.playing());
          state = howl && howl.state ? howl.state() : null;
        } catch (e) {
          /* ignore */
        }
        if (playing) {
          resolve({
            verdict: 'OK',
            src: JSON.stringify(howl._src || null),
            title: cur && cur.title,
            platform: cur && cur.platform,
            bitrate: cur && cur.bitrate,
            state,
          });
          return;
        }
        if (Date.now() - t0 > 90000) {
          resolve({
            verdict: 'TIMEOUT',
            playlistLen: tp ? tp.playlist.length : null,
            index: tp ? tp.index : null,
            state,
            source: cur ? cur.source : null,
            title: cur ? cur.title : null,
            mediaUriList: tp ? Object.keys(tp._media_uri_list || {}) : null,
          });
          return;
        }
        setTimeout(watchPlay, 500);
      };
      waitTrack();
    };
    waitResult();
  }, 120000);

  // ---- 歌单页网格渲染：provider 回调必须补 digest，否则数据到了界面也不刷新 ----
  out.playlistGrid = await withTimeout((resolve) => {
    const phost = document.querySelector('[ng-controller="PlayListController"]');
    const pscope = angular.element(phost).scope();
    pscope.changeTab("kugou");
    const t = Date.now();
    const watch = () => {
      const li = document.querySelectorAll(".playlist-covers li").length;
      const sr = pscope.result.length;
      if (sr > 0 && li === sr) {
        resolve({
          verdict: "OK",
          ms: Date.now() - t,
          coverLi: li,
          scopeResult: sr,
          tab: pscope.tab,
        });
        return;
      }
      if (Date.now() - t > 30000) {
        resolve({
          verdict: "TIMEOUT",
          coverLi: li,
          scopeResult: sr,
          tab: pscope.tab,
        });
        return;
      }
      setTimeout(watch, 200);
    };
    watch();
  }, 40000);

  out.errors = errors;
  return out;
})()`;

/**
 * 下载播放地址的前 1KB，确认返回的是真实音频数据而不是错误页。
 * @param {string} url
 */
function probeAudio(url) {
  return new Promise((resolve) => {
    const agent = url.startsWith("http://") ? http : https;
    const req = agent.get(
      url,
      { headers: { Range: "bytes=0-1023" }, timeout: 20000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"],
            length: buf.length,
            magic: buf.slice(0, 3).toString("hex"),
            isID3: buf.slice(0, 3).toString("latin1") === "ID3",
          });
        });
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
  });
}

async function main() {
  const target = await findMainTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  let r;
  try {
    const readyMs = await waitForApp(cdp);
    process.stdout.write(`应用就绪耗时 ${readyMs}ms\n`);
    r = await cdp.evaluate(SCRIPT);
  } finally {
    cdp.close();
  }
  // 真实下载校验：确认拿到的播放地址确实能取到音频数据
  if (r && r.kugouPlay && r.kugouPlay.url) {
    r.kugouPlayDownload = await probeAudio(r.kugouPlay.url);
  }
  process.stdout.write(`\n${JSON.stringify(r, null, 2)}\n`);

  const checks = [
    [
      "酷我歌单列表",
      r.kuwoPlaylistList.verdict === "OK" && r.kuwoPlaylistList.count > 0,
    ],
    [
      "酷我歌单详情",
      r.kuwoPlaylistDetail.verdict === "OK" && r.kuwoPlaylistDetail.tracks > 0,
    ],
    ["酷我搜索", r.kuwoSearch.verdict === "OK" && r.kuwoSearch.count > 0],
    ["酷我失败分支不挂起", r.kuwoFailBranch.verdict === "OK"],
    [
      "酷狗歌单列表",
      r.kugouPlaylistList.verdict === "OK" && r.kugouPlaylistList.count > 0,
    ],
    [
      "酷狗歌单详情",
      r.kugouPlaylistDetail.verdict === "OK" &&
        r.kugouPlaylistDetail.tracks > 0,
    ],
    ["酷狗搜索", r.kugouSearch.verdict === "OK" && r.kugouSearch.count > 0],
    [
      "酷狗歌单搜索",
      r.kugouSearchPlaylist.verdict === "OK" && r.kugouSearchPlaylist.count > 0,
    ],
    ["酷狗播放地址", r.kugouPlay.verdict === "OK" && !!r.kugouPlay.url],
    [
      "酷狗播放地址可下载",
      !!(r.kugouPlayDownload && r.kugouPlayDownload.isID3),
    ],
    [
      "酷狗音频可加载",
      !!(r.kugouAudioLoad && r.kugouAudioLoad.verdict === "OK"),
    ],
    ["酷狗歌词", r.kugouLyric.verdict === "OK" && r.kugouLyric.length > 0],
    ["酷狗失败分支不挂起", r.kugouFailBranch.verdict === "OK"],
    [
      "酷狗界面播放真的在放",
      !!(r.kugouUiPlay && r.kugouUiPlay.verdict === "OK"),
    ],
    [
      "网易云歌单列表",
      r.neteasePlaylistList.verdict === "OK" && r.neteasePlaylistList.count > 0,
    ],
    [
      "网易云歌单详情",
      r.neteasePlaylistDetail.verdict === "OK" &&
        r.neteasePlaylistDetail.tracks > 0,
    ],
    [
      "网易云搜索",
      r.neteaseSearch.verdict === "OK" && r.neteaseSearch.count > 0,
    ],
    ["UI scope 拿到结果", (r.uiScopeResultCount || 0) > 0],
    ["UI DOM 渲染出结果", (r.uiDomSongLiCount || 0) > 0],
    [
      "歌单网格渲染出歌单",
      !!(r.playlistGrid && r.playlistGrid.verdict === "OK"),
    ],
    ["无页面错误", Array.isArray(r.errors) && r.errors.length === 0],
  ];
  let pass = true;
  for (const [name, ok] of checks) {
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n`);
    if (!ok) pass = false;
  }
  process.stdout.write(`\n==== 综合回归: ${pass ? "PASS" : "FAIL"} ====\n`);
  process.exit(pass ? 0 : 1);
}

main();
