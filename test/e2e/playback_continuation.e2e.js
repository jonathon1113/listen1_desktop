/**
 * Listen1 Desktop —— 真实 Electron 运行时下的「播放失败后继续下一首」端到端验证
 *
 * 本脚本不 mock 播放器：它通过 Chrome DevTools Protocol 连到**已启动的 Electron
 * 主窗口渲染进程**，在真实 Howler / 真实渲染上下文中制造一次「播放地址可获取、
 * 但音频加载失败」的真实故障，观察播放器是否按项目原有规则继续下一首。
 *
 * 唯一的注入点是把「播放地址来源」替换为固定地址：
 *   - 第 1 首 -> 指向一个必定连接失败的地址（模拟平台返回坏地址 / 403 / 空音频）
 *   - 第 2 首 -> 指向本地生成的 1 秒 WAV（保证离线可复现，且能真正播起来）
 * 其余全部是产品真实代码路径：Howler 的 onloaderror -> handleFailure -> skip('next')
 * -> retrieveMediaUrl -> finishLoad -> Howl.play()。
 *
 * 前置条件（另开一个终端）：
 *   npx electron ./app --enable-logging --remote-debugging-port=9222
 *
 * 运行： node test/e2e/playback_continuation.e2e.js
 * 退出码： 0 = 全部通过，1 = 存在失败断言
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const TARGET_HINT = 'listen1.html';

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端（仅用 Node 内置 fetch / WebSocket）
 * ------------------------------------------------------------------ */
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
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
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
  const hit = list.find((t) => t.type === 'page' && t.url.includes(TARGET_HINT));
  if (!hit) {
    throw new Error(
      `未找到主窗口 target（url 含 ${TARGET_HINT}）。` +
        `请用 npx electron ./app --enable-logging --remote-debugging-port=${CDP_PORT} 启动应用。`
    );
  }
  return hit;
}

/* ------------------------------------------------------------------ *
 * 注入到渲染进程执行的测试体
 * ------------------------------------------------------------------ */
const INJECTED_SCRIPT = `(async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const url = require('url');

  // ---------- 1. 生成 1 秒 440Hz WAV，保证离线可复现 ----------
  const sampleRate = 8000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000),
      44 + i * 2
    );
  }
  const wavPath = path.join(os.tmpdir(), 'l1_e2e_tone.wav');
  fs.writeFileSync(wavPath, buf);
  const goodUrl = url.pathToFileURL(wavPath).href;

  // ---------- 2. 捕获 playerSendMessage（验证 PLAY_FAILED 是否送达） ----------
  const received = [];
  const origSend = window.playerSendMessage;
  window.playerSendMessage = function (mode, message) {
    try {
      received.push({ mode: mode, type: message && message.type });
    } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  // ---------- 3. 替换地址来源：模拟平台对不同曲目返回不同可用性 ----------
  // 127.0.0.1:9 (discard) 必定连接失败 —— 真实触发 Howler 的 onloaderror
  const BAD_URL = 'http://127.0.0.1:9/e2e-missing.mp3';
  const origBootstrap = MediaService.bootstrapTrack;
  MediaService.bootstrapTrack = function (track, onSuccess, onFail) {
    const u = track.id === 'e2e_bad' ? BAD_URL : goodUrl;
    setTimeout(function () {
      onSuccess({ url: u, bitrate: '128kbps', platform: 'e2e' });
    }, 0);
  };

  const result = { ok: false, error: null };
  try {
    // ---------- 4. 构造播放列表并从第 1 首开始播放 ----------
    const mk = function (id, title) {
      return { id: id, title: title, artist: 'e2e', album: 'e2e', source: 'netease', img_url: '' };
    };
    window.threadPlayer.setNewPlaylist([
      mk('e2e_bad', 'e2e-bad-url'),
      mk('e2e_good', 'e2e-good-url'),
    ]);
    window.threadPlayer.play(0);

    // ---------- 5. 等待故障发生并让续播流程走完 ----------
    await new Promise(function (r) { setTimeout(r, 9000); });

    const tp = window.threadPlayer;
    const failed = received.filter(function (m) { return m.type === 'BG_PLAYER:PLAY_FAILED'; });
    const goodHowl = tp.playlist[1] && tp.playlist[1].howl;

    result.index = tp.index;
    result.playing = tp.playing;
    result.badDisabled = !!(tp.playlist[0] && tp.playlist[0].disabled);
    result.goodDisabled = !!(tp.playlist[1] && tp.playlist[1].disabled);
    result.playFailedCount = failed.length;
    result.playFailedModes = failed.map(function (m) { return m.mode; });
    result.retrieveUrlFailCount = received.filter(function (m) {
      return m.type === 'BG_PLAYER:RETRIEVE_URL_FAIL';
    }).length;
    result.failAllCount = received.filter(function (m) {
      return m.type === 'BG_PLAYER:RETRIEVE_URL_FAIL_ALL';
    }).length;
    result.goodHowlExists = !!goodHowl;
    try { result.goodHowlState = goodHowl ? goodHowl.state() : null; } catch (e) { result.goodHowlState = 'n/a'; }
    result.goodUrl = goodUrl;
    result.badUrl = BAD_URL;
  } catch (err) {
    result.error = (err && err.message) || String(err);
  } finally {
    // ---------- 6. 还原注入点 ----------
    try { window.playerSendMessage = origSend; } catch (e) { /* ignore */ }
    try { MediaService.bootstrapTrack = origBootstrap; } catch (e) { /* ignore */ }
  }
  return result;
})()`;

/* ------------------------------------------------------------------ *
 * 断言与输出
 * ------------------------------------------------------------------ */
const assertions = [];
function assert(ok, message) {
  assertions.push({ ok: !!ok, message });
}

async function main() {
  let target;
  try {
    target = await findMainTarget();
  } catch (err) {
    process.stdout.write(`\n无法连接到 Electron 渲染进程：${err.message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`\n已连接 Electron 主窗口：${target.url}\n`);
  process.stdout.write('注入真实失败场景中（坏地址 -> 本地 WAV 正常地址）...\n\n');

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  let r;
  try {
    r = await cdp.evaluate(INJECTED_SCRIPT);
  } finally {
    cdp.close();
  }

  if (!r || r.error) {
    process.stdout.write(`  FAIL  注入脚本执行失败：${(r && r.error) || '无返回'}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write('运行时采集结果：\n');
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n\n`);

  // 用户要求的验证点
  assert(r.index === 1, '失败后应继续到下一首（index=1）');
  assert(r.playing === true, '下一首应处于播放状态');
  assert(r.badDisabled === true, '失败曲目应被标记为不可用');
  assert(r.goodDisabled !== true, '下一首不应被标记为不可用');
  assert(r.playFailedCount === 1, `应发出且仅发出一次 PLAY_FAILED（实际 ${r.playFailedCount}）`);
  assert(
    r.playFailedModes.every((m) => m === 'front' || m === 'background'),
    `PLAY_FAILED 必须带有效 mode 送达（实际 ${JSON.stringify(r.playFailedModes)}）`
  );
  assert(r.goodHowlExists === true, '下一首应创建了 Howl');
  assert(
    r.failAllCount === 0,
    `不应触发全部失败（RETRIEVE_URL_FAIL_ALL 实际 ${r.failAllCount}）`
  );

  let failed = 0;
  assertions.forEach((a) => {
    if (!a.ok) failed += 1;
    process.stdout.write(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.message}\n`);
  });
  process.stdout.write(`\n合计 ${assertions.length} 条断言，失败 ${failed} 条。\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
