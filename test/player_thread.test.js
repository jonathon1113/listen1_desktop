/**
 * Listen1 Desktop —— 播放失败续播回归测试
 *
 * 零依赖（仅 Node 内置模块），用 vm 在受控沙箱中加载真实源码
 * app/listen1_chrome_extension/js/player_thread.js，并以桩件替换
 * Howl / Howler / MediaService / playerSendMessage，从而精确模拟
 * "播放地址获取失败 / 地址获取悬挂 / 音频加载失败 / 播放启动失败 /
 * 用户切歌或暂停后旧回调到达 / 连续多首失败" 等场景。
 *
 * 运行： node test/player_thread.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(
  __dirname,
  '..',
  'app',
  'listen1_chrome_extension',
  'js',
  'player_thread.js'
);

/* ------------------------------------------------------------------ *
 * 极简断言与用例注册
 * ------------------------------------------------------------------ */
const cases = [];
let current = null;

function test(name, fn) {
  cases.push({ name, fn });
}

function assert(cond, message) {
  current.assertions.push({ ok: !!cond, message });
}

function assertEqual(actual, expected, message) {
  assert(
    actual === expected,
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(
      actual
    )}）`
  );
}

/* ------------------------------------------------------------------ *
 * 受控运行环境
 * ------------------------------------------------------------------ */
function createEnv() {
  const sent = []; // playerSendMessage 记录
  const howls = []; // 所有创建过的 Howl 实例
  const bootstrapCalls = []; // MediaService.bootstrapTrack 记录
  let behavior = {}; // trackId -> 'success' | 'fail' | 'hang' | 'manual'
  const pending = {}; // trackId -> { success, fail } 供 manual 模式使用

  // ---- 假时钟：只推进 timeout，interval 不触发 ----
  let now = 0;
  let seq = 0;
  const timers = new Map();

  function setTimeoutStub(fn, delay = 0) {
    seq += 1;
    timers.set(seq, { fn, at: now + delay, interval: false });
    return seq;
  }
  function clearTimeoutStub(id) {
    timers.delete(id);
  }
  function setIntervalStub(fn, delay = 0) {
    seq += 1;
    timers.set(seq, { fn, at: now + delay, interval: true });
    return seq;
  }
  function clearIntervalStub(id) {
    timers.delete(id);
  }
  function tick(ms = 0) {
    const target = now + ms;
    for (;;) {
      let pick = null;
      timers.forEach((t, id) => {
        if (t.interval || t.at > target) return;
        if (pick === null || t.at < pick.t.at) pick = { id, t };
      });
      if (!pick) break;
      now = pick.t.at;
      timers.delete(pick.id);
      pick.t.fn();
    }
    now = target;
  }

  // ---- Howl 桩件：行为对齐 howler 2.x ----
  class FakeHowl {
    constructor(opts) {
      this.opts = opts || {};
      this._state = 'loading';
      this._sounds = [{}];
      this._paused = false;
      this._ended = false;
      this._duration = 100;
      this._pos = 0;
      howls.push(this);
      FakeHowler._howls.push(this);
    }

    play() {
      // 与 howler 一致：已 unload 的实例无法再播放
      if (this._state === 'unloaded' || this._sounds.length === 0) return null;
      this._state = 'loaded';
      this._paused = false;
      this._ended = false;
      setTimeoutStub(() => {
        if (this.opts.onplay) this.opts.onplay.call(this);
      }, 0);
      return 1;
    }

    pause() {
      this._paused = true;
      setTimeoutStub(() => {
        if (this.opts.onpause) this.opts.onpause.call(this);
      }, 0);
      return this;
    }

    stop() {
      this._paused = false;
      this._ended = true;
      setTimeoutStub(() => {
        if (this.opts.onstop) this.opts.onstop.call(this);
      }, 0);
      return this;
    }

    unload() {
      this._state = 'unloaded';
      this._sounds = [];
      const idx = FakeHowler._howls.indexOf(this);
      if (idx >= 0) FakeHowler._howls.splice(idx, 1);
      return null;
    }

    playing() {
      return this._state === 'loaded' && !this._paused && !this._ended;
    }

    duration() {
      return this._duration;
    }

    seek() {
      return this._pos;
    }

    rate() {
      return 1;
    }

    /* --- 测试辅助：主动触发 howler 事件（this 绑定为 Howl 实例，与真实 howler 一致） --- */
    fireLoadError(err) {
      setTimeoutStub(() => {
        if (this.opts.onloaderror) this.opts.onloaderror.call(this, 0, err);
      }, 0);
    }

    firePlayError(err) {
      setTimeoutStub(() => {
        if (this.opts.onplayerror) this.opts.onplayerror.call(this, 0, err);
      }, 0);
    }

    fireEnd() {
      setTimeoutStub(() => {
        if (this.opts.onend) this.opts.onend.call(this);
      }, 0);
    }
  }

  const FakeHowler = {
    _howls: [],
    _muted: false,
    _volume: 1,
    unload() {
      this._howls.slice().forEach((h) => h.unload());
    },
    volume(v) {
      if (typeof v === 'number') this._volume = v;
      return this._volume;
    },
    mute(m) {
      this._muted = m;
    },
    unmute() {
      this._muted = false;
    },
  };

  // ---- MediaService 桩件 ----
  const MediaService = {
    bootstrapTrack(track, onSuccess, onFail) {
      bootstrapCalls.push({ track, onSuccess, onFail });
      const mode = behavior[track.id] || 'success';
      if (mode === 'success') {
        onSuccess({
          url: `http://audio.test/${track.id}.mp3`,
          bitrate: '320kbps',
          platform: track.source,
        });
      } else if (mode === 'fail') {
        onFail();
      } else if (mode === 'emptyurl') {
        // 平台返回了空地址：success 回调被调用，但地址不可用
        onSuccess({ url: '', bitrate: '', platform: track.source });
      } else if (mode === 'manual') {
        pending[track.id] = { onSuccess, onFail };
      }
      // 'hang'：故意既不 success 也不 fail
    },
  };

  function playerSendMessage(mode, message) {
    sent.push({ mode, message });
  }

  const mediaSession = {
    playbackState: 'none',
    metadata: null,
    setActionHandler() {},
    setPositionState() {},
  };

  const sandbox = {
    Howl: FakeHowl,
    Howler: FakeHowler,
    MediaService,
    playerSendMessage,
    MediaMetadata: class MediaMetadata {
      constructor(meta) {
        Object.assign(this, meta);
      }
    },
    navigator: { mediaSession },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      getObject: () => null,
      setObject: () => {},
    },
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

  const player = sandbox.threadPlayer;
  // 桌面端（Electron）固定使用 front 模式
  player.setMode('front');

  return {
    player,
    sent,
    howls,
    bootstrapCalls,
    tick,
    setBehavior(map) {
      behavior = map;
    },
    manualResolve(trackId, kind) {
      const p = pending[trackId];
      if (!p) throw new Error(`no pending bootstrap for ${trackId}`);
      if (kind === 'success') {
        p.onSuccess({
          url: `http://audio.test/${trackId}.mp3`,
          bitrate: '320kbps',
          platform: 'test',
        });
      } else {
        p.onFail();
      }
    },
    messagesOfType(type) {
      return sent.filter((m) => m.message && m.message.type === type);
    },
  };
}

function track(id, source = 'netease') {
  return {
    id,
    title: `title-${id}`,
    artist: `artist-${id}`,
    album: `album-${id}`,
    source,
    img_url: '',
  };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('用例1 正常歌曲播放不受影响', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  assert(env.player.playing === true, '正常歌曲应处于播放状态');
  assertEqual(env.player.index, 0, '正常播放不应切换曲目');
  assert(
    env.messagesOfType('BG_PLAYER:PLAY_STATE').length > 0,
    '应发出 PLAY_STATE 事件'
  );
  assertEqual(
    env.messagesOfType('BG_PLAYER:PLAY_FAILED').length,
    0,
    '正常播放不应发出 PLAY_FAILED'
  );
});

test('用例2 播放地址获取失败后继续下一首', () => {
  const env = createEnv();
  env.setBehavior({ A: 'fail', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  assertEqual(env.player.index, 1, '地址获取失败后应切到下一首');
  assert(env.player.playing === true, '下一首应正常播放');
  assertEqual(
    env.messagesOfType('BG_PLAYER:RETRIEVE_URL_FAIL').length,
    1,
    '应发出一次 RETRIEVE_URL_FAIL'
  );
});

test('用例3 播放地址获取永久悬挂时超时兜底续播', () => {
  const env = createEnv();
  env.setBehavior({ A: 'hang', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  assertEqual(env.player.index, 0, '悬挂期间不应切换曲目');
  env.tick(20000); // 推进假时钟越过兜底超时
  env.tick();

  assertEqual(env.player.index, 1, '悬挂超时后应切到下一首');
  assert(env.player.playing === true, '下一首应正常播放');
});

test('用例4 音频加载失败后继续下一首', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  assertEqual(env.howls.length, 1, '应为 A 创建一个 Howl');
  env.howls[0].fireLoadError('load error');
  env.tick();

  assertEqual(env.player.index, 1, '音频加载失败后应切到下一首');
  assert(env.player.playing === true, '下一首应正常播放');
  assertEqual(
    env.messagesOfType('BG_PLAYER:PLAY_FAILED').length,
    1,
    '应发出 PLAY_FAILED 事件'
  );
  assertEqual(
    env.messagesOfType('BG_PLAYER:PLAY_FAILED')[0].mode,
    'front',
    'PLAY_FAILED 必须以有效 mode 送达（this 绑定错误会导致消息被丢弃）'
  );
});

test('用例5 播放启动失败后继续下一首', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  env.howls[0].firePlayError('play error');
  env.tick();

  assertEqual(env.player.index, 1, '播放启动失败后应切到下一首');
  assert(env.player.playing === true, '下一首应正常播放');
  assertEqual(
    env.messagesOfType('BG_PLAYER:PLAY_FAILED').length,
    1,
    '应发出 PLAY_FAILED 事件'
  );
});

test('用例6 用户切歌后旧歌曲的延迟错误不影响新歌', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B'), track('C')]);
  env.player.play(0);
  env.tick();
  env.player.play(1); // 用户主动切到 B
  env.tick();

  assertEqual(env.player.index, 1, '应已切到 B');
  const howlB = env.howls[env.howls.length - 1];

  env.howls[0].fireLoadError('late error of A'); // A 的延迟错误
  env.tick();

  assertEqual(env.player.index, 1, '旧歌曲的错误回调不得切走当前曲目');
  assert(env.player.playing === true, '当前曲目应仍在播放');
  assert(
    env.player.playlist[1].disabled !== true,
    '旧歌曲的错误回调不得把新曲目标记为不可用'
  );
  assert(
    env.player.currentHowl === howlB,
    '旧歌曲的错误回调不得卸载当前曲目的 Howl'
  );
});

test('用例7 用户暂停后旧的异步回调不擅自续播', () => {
  const env = createEnv();
  env.setBehavior({ A: 'hang', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();
  env.player.pause(); // 用户主动暂停
  env.tick();

  env.tick(20000); // 超时/迟到结果
  env.tick();

  assertEqual(env.player.index, 0, '用户暂停后不得自动续播');
  assertEqual(env.player.playing, false, '用户暂停后不应自行恢复播放');
});

test('用例8 同一曲目的重复错误回调不重复续播', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success', C: 'success' });
  env.player.setNewPlaylist([track('A'), track('B'), track('C')]);
  env.player.play(0);
  env.tick();

  const howlA = env.howls[0];
  howlA.fireLoadError('first');
  howlA.firePlayError('second'); // 同一 Howl 的第二个错误
  env.tick();

  assertEqual(env.player.index, 1, '同一曲目的重复错误只应续播一次');
  assertEqual(
    env.messagesOfType('BG_PLAYER:PLAY_FAILED').length,
    1,
    '同一曲目的重复错误只应发出一次 PLAY_FAILED'
  );
});

test('用例9 连续多首失败有界收敛不无限重试', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success', C: 'success' });
  env.player.setNewPlaylist([track('A'), track('B'), track('C')]);
  env.player.play(0);
  env.tick();

  for (let i = 0; i < 3; i += 1) {
    const h = env.howls[env.howls.length - 1];
    h.fireLoadError(`error ${i}`);
    env.tick();
  }
  env.tick(1000);

  assertEqual(
    env.messagesOfType('BG_PLAYER:RETRIEVE_URL_FAIL_ALL').length,
    1,
    '全部曲目失败时应发出一次 RETRIEVE_URL_FAIL_ALL'
  );
  assert(
    env.bootstrapCalls.length <= 3,
    `连续失败不应无限重试取地址（实际 ${env.bootstrapCalls.length} 次）`
  );
  assert(
    env.howls.length <= 3,
    `连续失败不应无限创建 Howl（实际 ${env.howls.length} 个）`
  );
});

test('用例10 用户切歌后旧曲目的迟到成功结果不生效', () => {
  const env = createEnv();
  env.setBehavior({ A: 'manual', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  env.player.play(1); // 用户切到 B
  env.tick();
  assertEqual(env.player.index, 1, '应已切到 B');

  env.manualResolve('A', 'success'); // A 的地址此时才返回
  env.tick();

  assertEqual(env.player.index, 1, '旧曲目的迟到结果不得改变当前曲目');
  assert(env.player.playing === true, '当前曲目应仍在播放');
});

test('用例11 正常播放时切回已播放过的曲目仍可播放', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();
  env.player.play(1);
  env.tick();
  env.player.play(0); // 切回 A
  env.tick();

  assert(env.player.playing === true, '切回已播放过的曲目应能正常播放');
  assertEqual(env.player.index, 0, '当前曲目索引应为 A');
});

test('用例12 用户暂停后当前曲目的音频加载失败不擅自续播', () => {
  const env = createEnv();
  env.setBehavior({ A: 'success', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  env.player.pause(); // 用户主动暂停
  env.tick();

  env.howls[0].fireLoadError('load error after pause'); // 暂停后到达的加载错误
  env.tick();

  assertEqual(env.player.index, 0, '用户暂停后不得自动续播');
  assertEqual(env.player.playing, false, '用户暂停后不应自行恢复播放');
  assertEqual(
    env.messagesOfType('BG_PLAYER:RETRIEVE_URL_FAIL').length,
    0,
    '过期回调不应触发换源失败通知'
  );
});

test('用例13 用户切歌后旧曲目的地址失败回调不擅自续播', () => {
  const env = createEnv();
  env.setBehavior({ A: 'manual', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  env.player.play(1); // 用户切到 B
  env.tick();
  assertEqual(env.player.index, 1, '应已切到 B');

  env.manualResolve('A', 'fail'); // A 的地址此时才返回失败
  env.tick();

  assertEqual(env.player.index, 1, '旧曲目的失败回调不得改变当前曲目');
  assert(env.player.playing === true, '当前曲目应仍在播放');
  assertEqual(
    env.messagesOfType('BG_PLAYER:RETRIEVE_URL_FAIL').length,
    0,
    '过期失败回调不应发出 RETRIEVE_URL_FAIL'
  );
});

test('用例14 播放地址为空字符串时按加载失败处理并继续下一首', () => {
  const env = createEnv();
  env.setBehavior({ A: 'emptyurl', B: 'success' });
  env.player.setNewPlaylist([track('A'), track('B')]);
  env.player.play(0);
  env.tick();

  // 空地址会在 Howl 加载阶段报错
  env.howls[0].fireLoadError('empty url');
  env.tick();

  assertEqual(env.player.index, 1, '空地址应触发失败处理并切到下一首');
  assert(env.player.playing === true, '下一首应正常播放');
});

/* ------------------------------------------------------------------ *
 * 执行与输出
 * ------------------------------------------------------------------ */
let failed = 0;
let total = 0;

cases.forEach((c) => {
  current = { name: c.name, assertions: [] };
  process.stdout.write(`\n${c.name}\n`);
  try {
    c.fn();
  } catch (err) {
    current.assertions.push({
      ok: false,
      message: `用例执行抛出异常：${err && err.message}`,
    });
  }
  current.assertions.forEach((a) => {
    total += 1;
    if (!a.ok) failed += 1;
    process.stdout.write(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.message}\n`);
  });
});

process.stdout.write(`\n合计 ${total} 条断言，失败 ${failed} 条。\n`);
process.exit(failed === 0 ? 0 : 1);