/**
 * 真实 UI 驱动的搜索 / 歌单加载诊断
 *
 * 目的：模拟用户在界面里输入关键词按回车，观察：
 *   - 输入框的 ng-model 是否更新
 *   - $watch 是否触发 renderSearchPage
 *   - MediaService.search 的 .success 回调是否被调用
 *   - $scope.result 是否填充、$scope.loading 是否复位
 *   - 全程捕获 window.onerror / unhandledrejection
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
  const errors = [];
  window.addEventListener('error', (e) => {
    errors.push('ERROR: ' + (e.message || '') + ' @' + (e.filename||'') + ':' + (e.lineno||''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    errors.push('REJECTION: ' + (e.reason && (e.reason.stack || e.reason.message) || String(e.reason)));
  });
  const origErr = console.error;
  console.error = function (...a) {
    errors.push('CONSOLE.ERROR: ' + a.map(x => (x && x.stack) || String(x)).join(' '));
    origErr.apply(console, a);
  };

  const out = { steps: [], errors };

  const input = document.querySelector('#search-input');
  out.steps.push({ step: 'find-input', ok: !!input, value: input ? input.value : null });
  if (!input) return out;

  const el = input.closest('[ng-controller="InstantSearchController"]');
  const scope = window.angular.element(el).scope();
  out.steps.push({ step: 'get-scope', ok: !!scope, tab: scope.tab, keywords: scope.keywords });

  // 直接调用 MediaService.search，验证数据通路（绕过 DOM）
  const direct = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ verdict: 'HANG' }); } }, 30000);
    try {
      MediaService.search(scope.tab || 'netease', {
        keywords: '周杰伦', curpage: 1, type: 0,
      }).success((d) => {
        if (done) return; done = true; clearTimeout(t);
        resolve({ verdict: 'OK', count: d && d.result ? d.result.length : null, total: d ? d.total : null });
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ verdict: 'THROW', error: e.message }); } }
  });
  out.steps.push({ step: 'direct-search', ...direct });

  // 模拟真实输入：设置 value 并派发 input 事件（ng-model 会监听）
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '周杰伦');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  out.steps.push({ step: 'after-input-event', scopeKeywords: scope.keywords, inputValue: input.value });

  // ng-model-options debounce: 500
  await new Promise((r) => setTimeout(r, 2500));
  out.steps.push({
    step: 'after-debounce',
    scopeKeywords: scope.keywords,
    loading: scope.loading,
    resultCount: scope.result ? scope.result.length : null,
  });

  // 若仍未触发，模拟回车
  if (!scope.result || scope.result.length === 0) {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 3000));
    out.steps.push({
      step: 'after-enter-key',
      scopeKeywords: scope.keywords,
      loading: scope.loading,
      resultCount: scope.result ? scope.result.length : null,
    });
  }

  // 渲染出来的 DOM 条数
  const lis = document.querySelectorAll('[ng-controller="InstantSearchController"] li[ng-repeat="song in result"]');
  out.steps.push({ step: 'dom-render', liCount: lis.length });

  out.errors = errors;
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
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  let r;
  try {
    r = await cdp.evaluate(SCRIPT);
  } finally {
    cdp.close();
  }
  process.stdout.write(`\n${JSON.stringify(r, null, 2)}\n`);
  process.exit(0);
}

main();