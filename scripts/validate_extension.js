/* eslint-disable no-console */
/**
 * 校验 Chrome 扩展的静态配置，避免出现「语法看着对、实际不生效」的问题：
 *   1. manifest.json 里的 match pattern（host_permissions / content_scripts.matches /
 *      web_accessible_resources.matches）必须符合 Chrome 的匹配语法；
 *   2. manifest.json 引用的 DNR 规则文件必须存在；
 *   3. rules_*.json 的 declarativeNetRequest 规则结构必须合法。
 *
 * 用法：node scripts/validate_extension.js [扩展目录]
 * 不传目录时校验 app\listen1_chrome_extension。
 */
const fs = require("fs");
const path = require("path");

const EXT_DIR = path.resolve(
  process.argv[2] ||
    path.join(__dirname, "..", "app", "listen1_chrome_extension")
);
const errors = [];
const warns = [];

function fail(msg) {
  errors.push(msg);
}

function warn(msg) {
  warns.push(msg);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${path.basename(file)} JSON 解析失败: ${e.message}`);
    return null;
  }
}

// Chrome match pattern: <scheme>://<host><path>
// scheme: * | http | https | file | ftp | urn
// host:   * | *.example.com | example.com
// path:   必须以 / 开头，且以 /* 结尾才能覆盖子路径
const SCHEMES = ["*", "http", "https", "file", "ftp", "urn"];
const HOST_RE = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/i;

function checkMatchPattern(pattern, where) {
  if (typeof pattern !== "string") {
    fail(`${where}: 匹配模式必须是字符串`);
    return;
  }
  const m = /^([a-z*]+):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!m) {
    fail(
      `${where}: "${pattern}" 不是合法的 match pattern（应为 scheme://host/path）`
    );
    return;
  }
  const [, scheme, host, p] = m;
  if (!SCHEMES.includes(scheme)) {
    fail(`${where}: "${pattern}" 的 scheme "${scheme}" 非法`);
  }
  if (host !== "*" && !HOST_RE.test(host)) {
    fail(`${where}: "${pattern}" 的 host "${host}" 非法`);
  }
  if (!p.startsWith("/")) {
    fail(`${where}: "${pattern}" 的 path 必须以 / 开头`);
  } else if (!p.endsWith("/*")) {
    // 只写了 / 的模式只匹配根路径，子路径请求拿不到授权
    warn(
      `${where}: "${pattern}" 只匹配根路径，` +
        '如需覆盖子路径应写成 "/*"（否则接口请求会被 CORS 拦截）'
    );
  }
}

const manifest = readJson(path.join(EXT_DIR, "manifest.json"));
const rules = [];

if (manifest) {
  (manifest.host_permissions || []).forEach((p) =>
    checkMatchPattern(p, "host_permissions")
  );
  (manifest.permissions || []).forEach((p) => {
    if (p.includes("://")) {
      checkMatchPattern(p, "permissions");
    }
  });
  (manifest.content_scripts || []).forEach((cs, i) => {
    (cs.matches || []).forEach((p) =>
      checkMatchPattern(p, `content_scripts[${i}].matches`)
    );
  });
  (manifest.web_accessible_resources || []).forEach((r, i) => {
    (r.matches || []).forEach((p) =>
      checkMatchPattern(p, `web_accessible_resources[${i}].matches`)
    );
  });

  const dnr = manifest.declarative_net_request;
  if (dnr && dnr.rule_resources) {
    dnr.rule_resources.forEach((r) => {
      const file = path.join(EXT_DIR, r.path);
      if (!fs.existsSync(file)) {
        fail(`manifest 声明的规则文件不存在: ${r.path}`);
        return;
      }
      const list = readJson(file);
      if (Array.isArray(list)) {
        rules.push(...list.map((x) => ({ ...x, __file: r.path })));
      } else {
        fail(`${r.path} 必须是规则数组`);
      }
    });
  }
}

const ALLOWED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-language",
  "cookie",
  "forwarded",
  "if-match",
  "if-none-match",
  "keep-alive",
  "origin",
  "referer",
  "user-agent",
  "x-forwarded-for",
]);
const RESOURCE_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
]);

const seenIds = new Set();
rules.forEach((r) => {
  const at = `${r.__file}#${r.id}`;
  if (typeof r.id !== "number" || r.id < 1) {
    fail(`${at}: id 必须是正整数`);
  } else if (seenIds.has(r.id)) {
    fail(`${at}: id 重复`);
  } else {
    seenIds.add(r.id);
  }
  if (!r.action || r.action.type !== "modifyHeaders") {
    fail(`${at}: 只支持 modifyHeaders 类型`);
  } else {
    const headers = r.action.requestHeaders || [];
    if (headers.length === 0) {
      fail(`${at}: requestHeaders 不能为空`);
    }
    headers.forEach((h) => {
      const name = String(h.header || "").toLowerCase();
      if (!ALLOWED_HEADERS.has(name)) {
        fail(`${at}: 不可修改的请求头 "${h.header}"`);
      }
      if (!["set", "append", "remove"].includes(h.operation)) {
        fail(`${at}: operation "${h.operation}" 非法`);
      }
      if (h.operation !== "remove" && !h.value) {
        fail(`${at}: operation "${h.operation}" 必须提供 value`);
      }
    });
  }
  if (!r.condition || !r.condition.urlFilter) {
    fail(`${at}: 缺少 condition.urlFilter`);
  } else {
    (r.condition.resourceTypes || []).forEach((t) => {
      if (!RESOURCE_TYPES.has(t)) {
        fail(`${at}: 非法 resourceType "${t}"`);
      }
    });
  }
});

warns.forEach((w) => console.log(`WARN  ${w}`));
errors.forEach((e) => console.log(`FAIL  ${e}`));
if (errors.length === 0) {
  console.log(
    `OK    扩展配置校验通过（manifest + ${rules.length} 条 DNR 规则）`
  );
  process.exit(0);
} else {
  console.log(`\n共 ${errors.length} 处错误`);
  process.exit(1);
}
