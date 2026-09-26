/**
 * 火影忍者「福利站」登录态抓取 + 日志上报（Loon · http-request）
 *
 * 触发：只要你带着 Loon 打开微信小程序「火影忍者福利站」，
 *      该小程序发往 x8m8.ams.game.qq.com / ulinkact.game.qq.com 的请求会经过这里。
 *      脚本做三件事：
 *        1) 抓登录态（Cookie / g_tk / openid / 角色信息）存进 Loon 本地存储
 *        2) 记一行运行日志（本地最多留 200 行）
 *        3) 顺手把日志推到你自己的私密频道（ntfy），频道名只存在本机 / 插件参数里
 *
 * 本地存储：
 *   hyrz_auth       登录态 {cookie, gtk, openid, roleId, area, platId, partition, expire, updated, flows}
 *   hyrz_log        运行日志（文本，每行一条）
 *   hyrz_log_dirty  是否有还没上报的日志
 *   hyrz_log_ts     上次上报时间（秒）
 *   hyrz_log_topic  上报频道名（只在本机，绝不进仓库）
 *
 * 日志会推到你自己的频道（频道名从插件参数 logTopic 读，仓库里不写），
 * 所以 token / g_tk / openid / 角色 都做了脱敏（见 redact）。
 * 注意：http-request 脚本必须调用 $done({})，否则请求会被丢弃。
 */

var AUTH_KEY = "hyrz_auth";
var LOG_KEY = "hyrz_log";
var DIRTY_KEY = "hyrz_log_dirty";
var PUSH_TS_KEY = "hyrz_log_ts";
var VERSION = "v9"; // 版本号，会显示在调试通知里（用来确认装的是哪一版）
var VER_KEY = "hyrz_ver"; // 记录「哪个阶段」跑过哪个版本：用来确认 http-response 到底有没有生效
var LOG_MAX = 200; // 本地日志最多留多少行
// v6：ntfy 的 4KB 上限按**字节**算，中文 1 字 3 字节 —— 按字节分片，否则中文长日志会被 413 拒掉
var PUSH_BYTES = 3500; // 单条上报最大 UTF-8 字节
var PUSH_GAP = 60; // 两次上报最小间隔（秒）
var PUSH_BUSY_KEY = "hyrz_push_busy"; // 上报进行中标记：同一秒里多个请求命中时只推一次（旧版会把同一批日志推好几遍）
var PUSH_BUSY_GAP = 20; // 这几秒内不再重复发起上报
// v7：同一秒里好几个请求同时命中时，“先读标记再写标记”根本挡不住（真机上一批日志被推了 4 遍）：
// 改成延迟 0.3~0.9 秒再复查一次标记，先复查通过的人写标记并上报
var PUSH_BUSY_WAIT_MIN = 300;
var PUSH_BUSY_WAIT_RAND = 600;
var FAIL_TS_KEY = "hyrz_fail_ts"; // 上次「上报失败」提示时间（避免刷屏）
// v8：ntfy 在境外，TLS 握手偶尔会被网络环境打断（真机 18:53 一批 5 片，前 3 片就是这么丢的）。
// 传输层报错（err）/ 5xx 时就地重试：不重试的话，丢掉的那几片要等下一个请求把整批日志重推一遍，
// 而那正是「同一批日志在频道里出现好几份」的来源。
var NTFY_TRIES = 2; // 每条最多再试 2 次（共 3 次）
var NTFY_RETRY_MS = 400; // 重试间隔：第 1 次 400ms，第 2 次 800ms
// 参数顺序（有些 Loon 版本会把 argument 按位置传成数组，这里两种形状都认）
var ARG_ORDER = ["debug", "uploadLog", "logTopic"];
var TOPIC_KEY = "hyrz_log_topic"; // 频道名只存在本机（从插件参数读一次后缓存下来）
var NTFY_PUBLISH = "https://ntfy.sh/"; // JSON 发布口（POST 到这里）
// ⚠️ 频道名绝不写进仓库：公开仓库里只有插件和脚本，频道名只从插件参数 logTopic 读
var NTFY_TOPIC = topicFromArg();
var NTFY_URL = NTFY_TOPIC ? NTFY_PUBLISH + NTFY_TOPIC : ""; // 给人回看日志的网址
// 领取类请求必须立刻回给小程序，不能在上报上花时间（请求行也不上报）；
// 它们的结果由 http-response 阶段「先发出 POST、再 $done」补推
var PUSH_SKIP = /getWelfareGiftNow|getTodayActGiftNow|taskLotteryNow/;
// 纯 UI 噪音接口：响应行记下来没意义，跳过（省存储、少上报）
var RESP_SKIP = /getAdvertisingList|homePageRecommendArticleInfo|getNewsCountData|User\/userinfo|Index\/init/;

/* ───────────── 日志 ───────────── */

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function stamp(d) {
  d = d || new Date();
  return (
    pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
  );
}

function maskId(s) {
  s = String(s || "");
  return s.length > 10 ? s.slice(0, 4) + "****" + s.slice(-3) : "****";
}

/** 角色 ID 同样打码：日志会离开手机 */
function maskRole(v) {
  v = String(v === null || v === undefined ? "" : v).trim();
  if (!v || v === "-") return "-";
  return v.length >= 6 ? v.slice(0, 2) + "****" + v.slice(-2) : "****";
}

/** 频道名：优先插件参数 logTopic，并缓存到本机（http-response 阶段可能拿不到参数） */
function topicFromArg() {
  var fromArg = "";
  try {
    var a = $argument;
    if (Object.prototype.toString.call(a) === "[object Array]") {
      fromArg = String(a[ARG_ORDER.indexOf("logTopic")] || "");
    } else if (a && typeof a === "object") {
      fromArg = String(a.logTopic || "");
    }
  } catch (e) {}
  fromArg = fromArg.trim();
  var cached = "";
  try {
    cached = String($persistentStore.read(TOPIC_KEY) || "").trim();
  } catch (e) {}
  if (fromArg) {
    if (fromArg !== cached) {
      try {
        $persistentStore.write(fromArg, TOPIC_KEY);
      } catch (e) {}
    }
    return fromArg;
  }
  return cached;
}

/** 脱敏：日志会被推到公网地址，绝不能带 token */
function redact(t) {
  var s = String(t === null || t === undefined ? "" : t);
  s = s.replace(/[A-Za-z_]*token[A-Za-z_]*=[^&;\s"']*/gi, function (m) {
    return m.split("=")[0] + "=***";
  });
  s = s.replace(/g_tk=[^&;\s"']*/gi, "g_tk=***");
  s = s.replace(/((?:sOpenid|openId|openid)=)([^&;\s"']+)/gi, function (m, k, v) {
    return k + maskId(v);
  });
  s = s.replace(/((?:roleId|角色)=)([^&;\s"']+)/gi, function (m, k, v) {
    return k + maskRole(v);
  });
  return s;
}

function logRead() {
  try {
    return String($persistentStore.read(LOG_KEY) || "");
  } catch (e) {
    return "";
  }
}

function logAppend(newLines) {
  try {
    var cur = logRead();
    var all = cur ? cur.split("\n") : [];
    for (var i = 0; i < newLines.length; i++) all.push(redact(newLines[i]));
    while (all.length > LOG_MAX) all.shift();
    $persistentStore.write(all.join("\n"), LOG_KEY);
    $persistentStore.write("1", DIRTY_KEY);
  } catch (e) {}
}

function logDirty() {
  try {
    return $persistentStore.read(DIRTY_KEY) === "1";
  } catch (e) {
    return false;
  }
}

/** 每个版本、每个阶段只记一条：用来确认 http-request / http-response 到底哪个阶段跑起来了 */
function markPhase(phase) {
  try {
    var seen = String($persistentStore.read(VER_KEY) || "");
    if (seen.indexOf(VERSION + "|" + phase) >= 0) return;
    $persistentStore.write((seen ? seen + "," : "") + VERSION + "|" + phase, VER_KEY);
    logAppend([
      "[" + stamp() + "] ⇦ 脚本 " + VERSION + " 已生效（" +
        (phase === "resp" ? "响应阶段" : "请求阶段") + "）",
    ]);
  } catch (e) {}
}

function pushTs() {
  try {
    return parseInt($persistentStore.read(PUSH_TS_KEY) || "0", 10) || 0;
  } catch (e) {
    return 0;
  }
}

/** 上报失败时弹本地通知（10 分钟最多一条），这样一眼能看出是「脚本没跑」还是「通道不通」 */
function notifyFail(msg) {
  try {
    var now = Math.floor(Date.now() / 1000);
    var last = parseInt($persistentStore.read(FAIL_TS_KEY) || "0", 10) || 0;
    if (now - last < 600) return;
    $persistentStore.write(String(now), FAIL_TS_KEY);
  } catch (e) {}
  try {
    var hint = NTFY_URL
      ? "日志已存在本机，但推不到 ntfy（重试 " + NTFY_TRIES + " 次仍失败）；请开手机 Safari 打开 " + NTFY_URL + " 试试通不通"
      : "日志已存在本机；插件参数 logTopic 没填，所以没上报";
    $notification.post("火影抓包 · 上报失败", shortReason(msg), hint);
  } catch (e) {}
}

/** 把一大坨原始报错压成一句人话（通知里只显示这一行，原文照样写在日志里） */
function shortReason(msg) {
  var m = String(msg || "");
  if (/certificate verify failed|SSL handshake/i.test(m)) return "TLS 握手被网络打断（环境抖动）";
  if (/timeout|timed out|timed-out/i.test(m)) return "连接超时";
  if (/^HTTP /.test(m)) return m.slice(0, 40);
  return m.replace(/\s+/g, " ").slice(0, 60);
}

/** 发一条 ntfy 消息：优先 JSON 发布（中文标题不会出问题），失败自动退回「纯文本发到频道地址」
 *  v6 修正：旧版兜底是把纯文本 POST 到根地址 https://ntfy.sh/，而根地址只收 JSON
 *  → 必然 400（实测 body：invalid request: request body must be valid JSON），
 *  于是日志其实早就传上去了，用户还是会收到「上报失败」的假警报。纯文本必须发到 /<topic>。
 *  v8：传输层报错（TLS 握手 / 超时）或 5xx 就地重试最多 NTFY_TRIES 次，还是不行才记失败。
 */
function ntfySend(title, text, cb) {
  var asJson = true;
  var lastErr = "";
  var tries = 0; // v8：这条消息已经重试过几次
  function attempt() {
    $httpClient.post(
      {
        url: asJson ? NTFY_PUBLISH : NTFY_URL, // 纯文本只能发到频道地址
        timeout: 8000,
        "auto-cookie": false,
        headers: asJson
          ? { "Content-Type": "application/json" }
          : { "Content-Type": "text/plain; charset=utf-8", Title: "HYRZ log" },
        body: asJson
          ? JSON.stringify({ topic: NTFY_TOPIC, title: title, message: text, tags: ["scroll"] })
          : text,
      },
      function (err, resp) {
        var st = resp ? Number(resp.status) : 0;
        if (err || !(st >= 200 && st < 300)) {
          lastErr = err ? String(err.message || err) : "HTTP " + st;
          // v7：只有 ntfy 明确说「格式/体积不对」（4xx）才改发纯文本。
          // 传输层报错（TLS 握手/超时）时改发纯文本会把同一条日志投两遍
          if (asJson && !err && st >= 400 && st < 500) {
            asJson = false;
            attempt();
            return;
          }
          // v8：TLS 握手失败 / 超时这种环境抖动，隔几百毫秒再发一次基本就过了
          if (tries < NTFY_TRIES) {
            tries++;
            setTimeout(attempt, NTFY_RETRY_MS * tries);
            return;
          }
          logAppend(["[" + stamp() + "] ✗ 上报失败 " + lastErr]);
          notifyFail(lastErr);
        }
        if (cb) cb(err, st);
      }
    );
  }
  attempt();
}

/** 字符串的 UTF-8 字节数（ntfy 的限制按字节算：中文 1 字 3 字节） */
function utf8Len(s) {
  s = String(s);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // 代理对（emoji）：4 字节
      i++;
    } else n += 3;
  }
  return n;
}

/** 刚发起过上报？（只读判断；标记只在真要推的那一刻写，见 pushClaim） */
function pushBusy() {
  var now = Math.floor(Date.now() / 1000);
  try {
    var last = parseInt($persistentStore.read(PUSH_BUSY_KEY) || "0", 10) || 0;
    if (now - last < PUSH_BUSY_GAP) return true;
  } catch (e) {}
  return false;
}

/** 抢占上报权：谁先写下时间戳谁推 */
function pushClaim() {
  try {
    $persistentStore.write(String(Math.floor(Date.now() / 1000)), PUSH_BUSY_KEY);
  } catch (e) {}
}

/**
 * 把最近的日志推到 ntfy（按 UTF-8 字节分片，单条 ≤ 3.5KB）
 *
 * v7：noDelay=true 用于 http-response 阶段——那个阶段必须在 $done 之前就把请求发出去，等不起；
 * 其它阶段先等 0.3~0.9 秒再复查一次「正在推」标记，把同一秒里的并发请求挡在门外。
 */
function pushLog(title, cb, optimistic, noDelay) {
  var called = false;
  function once(err) {
    if (called) return;
    called = true;
    if (cb) cb(err);
  }
  if (pushBusy()) {
    once("busy");
    return;
  }
  var lines = logRead().split("\n").filter(function (l) {
    return !!l.replace(/\s/g, "");
  });
  if (!lines.length) {
    once("empty");
    return;
  }

  var chunks = [];
  var cur = "";
  for (var i = 0; i < lines.length; i++) {
    var l = redact(lines[i]);
    if (cur && utf8Len(cur) + utf8Len(l) + 1 > PUSH_BYTES) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) chunks.push(cur);

  function start() {
    pushClaim();
    // optimistic：回调不一定会回来（http-response 阶段 $done 之后上下文可能已释放），
    // 所以先把「已上报」记上，避免同一条日志被反复重推
    if (optimistic) {
      try {
        $persistentStore.write(String(Math.floor(Date.now() / 1000)), PUSH_TS_KEY);
        $persistentStore.write("0", DIRTY_KEY);
      } catch (e) {}
    }
    next();
  }

  var idx = 0;
  var failed = false;
  function next() {
    if (idx >= chunks.length) {
      try {
        $persistentStore.write(String(Math.floor(Date.now() / 1000)), PUSH_TS_KEY);
        // 没推上去就留一个脏标记，下个请求接着推
        if (failed) $persistentStore.write("1", DIRTY_KEY);
        else if (!optimistic) $persistentStore.write("0", DIRTY_KEY);
      } catch (e) {}
      once(failed ? "failed" : null);
      return;
    }
    var t = title + (chunks.length > 1 ? " [" + (idx + 1) + "/" + chunks.length + "]" : "");
    var body = chunks[idx];
    idx++;
    ntfySend(t, body, function (err, st) {
      if (err || !(st >= 200 && st < 300)) failed = true;
      next();
    });
  }
  if (noDelay) {
    start();
    return;
  }
  setTimeout(function () {
    if (pushBusy()) {
      once("busy");
      return;
    }
    start();
  }, PUSH_BUSY_WAIT_MIN + Math.floor(Math.random() * PUSH_BUSY_WAIT_RAND));
}

/* ───────────── 参数 / 解析 ───────────── */

// 有些 Loon 版本会把 argument 按位置传成数组，两种形状都认（顺序见文件顶部 ARG_ORDER）

function argOf(name, def) {
  var v;
  try {
    var a = $argument;
    if (Object.prototype.toString.call(a) === "[object Array]") {
      var i = ARG_ORDER.indexOf(name);
      if (i >= 0) v = a[i];
    } else if (typeof a === "object" && a !== null) {
      v = a[name];
    }
  } catch (e) {}
  if (v !== undefined && v !== null && String(v) !== "") return String(v);
  return def;
}

var DEBUG = argOf("debug", "false") === "true";
var UPLOAD = argOf("uploadLog", "true") === "true";

function readJSON(key) {
  try {
    return JSON.parse($persistentStore.read(key) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function splitMap(str, sep) {
  var out = {};
  String(str || "").split(sep).forEach(function (pair) {
    var i = pair.indexOf("=");
    if (i <= 0) return;
    var k = pair.slice(0, i).trim();
    var v = pair.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (e) {}
    out[k] = v;
  });
  return out;
}

function describeTarget(url, query, form) {
  var noProto = url.replace(/^https?:\/\//, "");
  var host = noProto.split("/")[0].split("?")[0];
  var flow = form["iFlowId"] || query["iFlowId"];
  var act = form["iActivityId"] || query["iActivityId"];
  if (host.indexOf("amesvr") >= 0 || flow) return "amesvr 流程 " + (act ? act + "/" : "") + (flow || "?");
  var route = query["route"] || form["route"];
  if (route) return "ulink " + route;
  return noProto.split("?")[0];
}

function describeAuth(a) {
  return (
    "openid=" + maskId(a.openid) +
    " 角色=" + maskRole(a.roleId) +
    " g_tk=" + (a.gtk ? "已存" : "无") +
    " 票据有效至 " + (a.expire ? stamp(new Date(a.expire * 1000)) : "未知")
  );
}

/* ───────────── 响应解析（http-response 用） ───────────── */

function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 把接口返回压成一句话：领到啥 / 签到状态 / 错误码 */
function summarize(rb) {
  var raw = String(rb || "");
  if (!raw) return "(空)";
  var j = null;
  try {
    j = JSON.parse(raw);
  } catch (e) {}
  if (j === null || j === undefined) return "非JSON " + clip(redact(raw), 140);
  var d = j && j.modRet ? j.modRet : j;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch (e) {}
  }
  if (!d || typeof d !== "object") return clip(redact(raw), 140);
  var jd = d.jData;
  if (typeof jd === "string") {
    try {
      jd = JSON.parse(jd);
    } catch (e) {}
  }
  var out = "";
  if (jd && jd.awardList && jd.awardList.length) {
    out = "领到：" + jd.awardList.map(function (a) {
      return a.sPackageName || a.sItemName || a.name || "?";
    }).join("、");
  } else if (jd && jd.leftQual !== undefined) {
    out = "礼包 leftQual=" + jd.leftQual;
  } else if (jd && jd.openid_jf_everyDay !== undefined) {
    out = "签到：今日" + (String(jd.openid_jf_everyDay) === "1" ? "已签" : "未签") +
      " 本周" + (jd.week_qd_roleid_everyDay !== undefined ? jd.week_qd_roleid_everyDay : "?") + "/7" +
      " 本月" + (jd.qd_nums !== undefined ? jd.qd_nums : "?") + "天";
  } else if (Object.prototype.toString.call(jd) === "[object Array]") {
    var can = 0;
    jd.forEach(function (x) {
      if (x && String(x.leftQual) === "1") can++;
    });
    out = "列表 " + jd.length + " 项，可领 " + can;
  } else if (jd && typeof jd === "object") {
    out = Object.keys(jd)
      .slice(0, 6)
      .map(function (k) {
        return k + "=" + clip(String(jd[k]), 24);
      })
      .join(" ");
  }
  var ret = d.iRet !== undefined ? d.iRet : d.ret;
  if (ret !== undefined) {
    out = "iRet=" + ret + (d.sMsg ? "(" + d.sMsg + ")" : "") + (out ? "｜" + out : "");
  }
  return out || clip(redact(raw), 140);
}

/** http-response：记一句「结果」——领到什么、签到还在不在、报什么错 */
var RESP_PUSH = false; // 响应里出现了「领取/任务」结果时，打完包再补推一次
function handleResponse() {
  RESP_PUSH = false;
  markPhase("resp");
  var rurl = String(($request && $request.url) || "");
  var qi = rurl.indexOf("?");
  var query = qi >= 0 ? splitMap(rurl.slice(qi + 1), "&") : {};
  var rbody = ($request && $request.body) || "";
  var form = splitMap(typeof rbody === "string" ? rbody : "", "&");
  var code = $response && $response.status ? $response.status : "?";
  var sum = summarize($response && $response.body);
  if (!RESP_SKIP.test(rurl)) {
    logAppend([
      "[" + stamp() + "] ← " + describeTarget(rurl, query, form) + " (" + code + ") " + sum,
    ]);
  }
  // 领到东西 / 任务奖励 / 非 0 错误码 / 礼包可领状态 → 这次值得上报。
  // 注意：在 Loon 里 $done 之后再发网络请求是靠不住的（回调拿不到，还会误报「上报失败」），
  // 所以这里「先发出、再放行」：POST 已经交给 Loon 的网络栈了，马上 $done 不拖小程序。
  RESP_PUSH = /领到|签到：|leftQual|awardList|iRet=[1-9]/.test(sum);
  if (RESP_PUSH && UPLOAD && NTFY_TOPIC && logDirty() &&
      Math.floor(Date.now() / 1000) - pushTs() >= PUSH_GAP) {
    pushLog("火影·抓包日志", function () {}, true, true); // 响应阶段：不能等，必须 $done 前发出
  }
  return false;
}

/* ───────────── 主逻辑 ───────────── */

var finished = false;
function finish() {
  if (finished) return;
  finished = true;
  $done({});
}

function handle() {
  markPhase("req");
  var headers = ($request && $request.headers) || {};
  var cookie = headers["Cookie"] || headers["cookie"] || "";
  if (Object.prototype.toString.call(cookie) === "[object Array]") {
    cookie = cookie.join("; ");
  }
  var url = String(($request && $request.url) || "");
  var rawBody = ($request && $request.body) || "";
  var body = typeof rawBody === "string" ? rawBody : "";

  var qIndex = url.indexOf("?");
  var query = qIndex >= 0 ? splitMap(url.slice(qIndex + 1), "&") : {};
  var form = splitMap(body, "&");
  var ck = splitMap(cookie, ";");

  var auth = readJSON(AUTH_KEY);
  var dirty = false;

  // 只有同时带两个 token 的请求才算「已登录」的请求；
  // 否则（比如打开小程序时的预请求）不带 token，不能拿它的 g_tk / 角色信息覆盖已有数据。
  var logged = !!(ck["ieg_ams_session_token"] && ck["ieg_ams_token"]);

  // 1. 登录态 Cookie
  if (logged && cookie !== auth.cookie) {
    auth.cookie = cookie;
    dirty = true;
  }

  if (logged) {
    // 2. g_tk
    var gtk = form["g_tk"] || query["g_tk"];
    if (gtk && gtk !== auth.gtk) {
      auth.gtk = gtk;
      dirty = true;
    }

    // 3. openid
    if (ck["openid"] && ck["openid"] !== auth.openid) {
      auth.openid = ck["openid"];
      dirty = true;
    }

    // 4. 角色 / 区服（福利站请求体里带）
    ["roleId", "area", "platId", "partition"].forEach(function (k) {
      if (form[k] && form[k] !== auth[k]) {
        auth[k] = form[k];
        dirty = true;
      }
    });

    // 5. token 到期时间
    if (ck["ieg_ams_token_time"]) {
      var t = parseInt(ck["ieg_ams_token_time"], 10);
      if (t > 0 && t !== auth.expire) {
        auth.expire = t;
        dirty = true;
      }
    }
  }

  // 6. 记录见过的 iFlowId（最多留 12 个）
  var flow = form["iFlowId"] || query["iFlowId"];
  var act = form["iActivityId"] || query["iActivityId"];
  var flowNew = "";
  if (flow) {
    var flows = auth.flows || {};
    if (!flows[flow]) flowNew = flow;
    flows[flow] = Date.now();
    var keys = Object.keys(flows);
    if (keys.length > 12) {
      keys.sort(function (a, b) {
        return flows[a] - flows[b];
      });
      keys.slice(0, keys.length - 12).forEach(function (k) {
        delete flows[k];
      });
    }
    auth.flows = flows;
    dirty = true;
  }

  // 只在有变化或超过 1 小时没刷新时才写，减少无谓的存储写入
  if (dirty || !auth.updated || Date.now() - auth.updated > 3600000) {
    auth.updated = Date.now();
    $persistentStore.write(JSON.stringify(auth), AUTH_KEY);
  }

  /* 日志 */
  var logLines = [];
  if (dirty && auth.cookie === cookie) {
    logLines.push("[" + stamp() + "] 抓到登录态 ✓ " + describeAuth(auth));
    var fk = Object.keys(auth.flows || {});
    if (fk.length) logLines.push("[" + stamp() + "] 已知流程：" + fk.join(", "));
  }
  if (flowNew) {
    logLines.push("[" + stamp() + "] 新流程 " + flowNew + (act ? "（iActivityId=" + act + "）" : ""));
  }
  logLines.push(
    "[" + stamp() + "] → " + describeTarget(url, query, form) +
      (logged ? " ✓" : "（无登录态）")
  );
  logAppend(logLines);

  if (DEBUG) {
    $notification.post(
      "火影抓包 · 调试 " + VERSION,
      describeTarget(url, query, form),
      redact(body.slice(0, 300)) || "(无 body)"
    );
  }

  /* 顺带上报日志：除了领取请求，其余请求都行；60 秒内只做一次 */
  var nowSec = Math.floor(Date.now() / 1000);
  if (UPLOAD && NTFY_TOPIC && logDirty() && !PUSH_SKIP.test(url) && nowSec - pushTs() >= PUSH_GAP) {
    setTimeout(finish, 4000); // 兜底：上报再慢也不能拖住请求
    pushLog("火影·抓包日志", finish);
    return true;
  }
  return false;
}

var isAsync = false;
try {
  isAsync = typeof $response !== "undefined" ? handleResponse() : handle();
} catch (e) {
  try {
    $notification.post("火影抓包 · 出错", "", String(e));
  } catch (e2) {}
}

// 必须调用，放行请求（响应阶段的上报请求已经在上面发出去了，这里只负责放行）
if (!isAsync) finish();
