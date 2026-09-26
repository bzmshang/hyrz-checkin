/**
 * 火影忍者「福利站」自动签到 —— Loon · cron 脚本
 *
 * 与 hyrz-sniff.js 配套：
 *   sniff  → 你打开微信小程序时自动抓 Cookie / g_tk / openid / 角色信息（续期 24h 票据）
 *   sign   → 每天定时用抓到的信息完成「签到状态查询 → 签到 → 领福利站礼包」
 *
 * 每次运行都会写本地日志（$persistentStore: hyrz_log），并在结束时把日志推到你自己的
 * 私密频道（ntfy，频道名从插件参数 logTopic 读，仓库里不写），通知点一下就能打开。
 * 日志里的 token / g_tk / openid / 角色 已脱敏。
 *
 * v9.1「手动签到」——同一个脚本，插件里多挂了一条 http-request 规则，
 * 浏览器打开下面这两个地址之一就会立刻跑一次完整流程（域名本来就在 Mitm 名单里，点一下就被拦到，
 * 脚本直接返回一个假响应，把结果显示在网页上）：
 *   https://ulinkact.game.qq.com/hyrz-sign-now           → 手动签到（今天签过就跳过）
 *   https://ulinkact.game.qq.com/hyrz-sign-now?force=1   → 今天签过也强制再发一次签到流程，
 *                                                          并回显服务端原文 + 打一条假流程做对照（测试用）
 *
 * 所有接口均来自抓包实测，已在 Scripting 运行时验证可在脚本里重放。
 */

var VERSION = "v9.2"; // 手动签到版（含报错解码/限流识别）；手动页面上会打印出来，方便确认线上/本机是不是同一版
var AUTH_KEY = "hyrz_auth";
var LOG_KEY = "hyrz_log";
var DIRTY_KEY = "hyrz_log_dirty";
var PUSH_TS_KEY = "hyrz_log_ts";
var LOG_MAX = 200;
// v6：ntfy 的 4KB 上限按**字节**算，中文 1 字 3 字节 —— 按字节分片，否则中文长日志会被 413 拒掉
var PUSH_BYTES = 3500;
var PUSH_BUSY_KEY = "hyrz_push_busy"; // 上报进行中标记（同一秒内只推一次）
var PUSH_BUSY_GAP = 20;
// v7：延迟复查一次「正在推」标记，免得同一秒里的并发请求把同一批日志各推一遍
var PUSH_BUSY_WAIT_MIN = 300;
var PUSH_BUSY_WAIT_RAND = 600;
// v8：ntfy 在境外，TLS 握手偶尔会被网络打断；传输层报错/5xx 时就地重试，
// 免得一次抖动就要等下次抓包把整批日志重推一遍（那就是重复推送）
var NTFY_TRIES = 2; // 每条最多再试 2 次（共 3 次）
var NTFY_RETRY_MS = 400; // 重试间隔：第 1 次 400ms，第 2 次 800ms
// 参数顺序（有些 Loon 版本会把 argument 按位置传成数组，这里两种形状都认）
var ARG_ORDER = ["claimGift", "signFlow", "uploadLog", "logTopic"];var TOPIC_KEY = "hyrz_log_topic"; // 频道名只存在本机（从插件参数读一次后缓存下来）
var NTFY_PUBLISH = "https://ntfy.sh/";
// ⚠️ 频道名绝不写进仓库：公开仓库里只有插件和脚本，频道名只从插件参数 logTopic 读
var NTFY_TOPIC = topicFromArg();
var NTFY_URL = NTFY_TOPIC ? NTFY_PUBLISH + NTFY_TOPIC : "";

var UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.57(0x18003921) NetType/4G Language/zh_CN";
var REFERER = "https://servicewechat.com/wxc47b57c32a7fe64b/230/page-frame.html";

var AMS_URL =
  "https://x8m8.ams.game.qq.com/ams/ame/amesvr" +
  "?ameVersion=0.3&sServiceType=hyrz&iActivityId=576370&game=hyrz&e_code=0";
var WELFARE_URL = "https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php";
var IACT_ID = "8265";
var SAPP_ID = "ULINK-AKKJ-784060";
var STATUS_FLOW = "1083547"; // 页面打开时自动发的那条：只读，返回今日是否已签（不会签到）
// v9：签到动作的流程号 —— 09-26 09:05:28 用户手点「签到」时抓到的全新流程
//（iActivityId=576370，之前的历史里从没出现过），点完页面显示「已签到」
var SIGN_FLOW = "1083576";

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

/** 频道名：优先插件参数 logTopic，并缓存到本机（缓存丢了也不影响签到） */
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

/** 发一条 ntfy 消息：优先 JSON 发布（中文标题不会出问题），失败自动退回「纯文本发到频道地址」
 *  v6 修正：兜底必须发到 /<topic>。根地址 https://ntfy.sh/ 只收 JSON，
 *  纯文本发过去会 400（实测：invalid request: request body must be valid JSON）。
 *  v8：传输层报错（TLS 握手 / 超时）或 5xx 就地重试最多 NTFY_TRIES 次，还是不行才当失败。
 */
function ntfySend(title, text, cb) {
  var asJson = true;
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
        // v7：只有 ntfy 明确说「格式/体积不对」（4xx）才改发纯文本；
        // 传输层报错（TLS 握手/超时）时改发会把同一条日志投两遍
        if (asJson && !err && st >= 400 && st < 500) {
          asJson = false;
          attempt();
          return;
        }
        // v8：TLS 握手失败 / 超时这种环境抖动，隔几百毫秒再发一次基本就过了
        if (!err && st >= 200 && st < 300) {
          if (cb) cb(err, st);
          return;
        }
        if (tries < NTFY_TRIES) {
          tries++;
          setTimeout(attempt, NTFY_RETRY_MS * tries);
          return;
        }
        if (cb) cb(err, st);
      }
    );
  }
  attempt();
}

/** 字符串的 UTF-8 字节数（ntfy 的限制按字节算） */
function utf8Len(s) {
  s = String(s);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** 刚发起过上报？（只读判断；标记在真要推的那一刻才写，见 pushClaim） */
function pushBusy() {
  var now = Math.floor(Date.now() / 1000);
  try {
    var last = parseInt($persistentStore.read(PUSH_BUSY_KEY) || "0", 10) || 0;
    if (now - last < PUSH_BUSY_GAP) return true;
  } catch (e) {}
  return false;
}

/** 抢占上报权 */
function pushClaim() {
  try {
    $persistentStore.write(String(Math.floor(Date.now() / 1000)), PUSH_BUSY_KEY);
  } catch (e) {}
}

/**
 * 把最近的日志推到 ntfy（按 UTF-8 字节分片，单条 ≤ 3.5KB）
 * v7：先等 0.3~0.9 秒再复查一次标记，避免和抓包脚本/并发请求撞车重复推。
 */
function pushLog(title, cb, noDelay) {
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

  var idx = 0;
  var failed = false;
  function start() {
    pushClaim();
    next();
  }
  function next() {
    if (idx >= chunks.length) {
      try {
        $persistentStore.write(String(Math.floor(Date.now() / 1000)), PUSH_TS_KEY);
        if (!failed) $persistentStore.write("0", DIRTY_KEY); // 没推上去就留脏标记，下次抓包时接着推
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

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

/* ───────────── 工具 ───────────── */

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

var UPLOAD = argOf("uploadLog", "true") === "true";
// v9.1：手动签到时网页要尽快出结果，上报只等 2.5s；没推上去的话脏标记还在，下次抓包会补推
var UPLOAD_BUDGET = 9000;
var UPLOAD_NOTE = ""; // 上报失败时附加到通知里的提示

function readAuth() {
  try {
    return JSON.parse($persistentStore.read(AUTH_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function describeAuth(a) {
  return (
    "openid=" + maskId(a.openid) +
    " 角色=" + maskRole(a.roleId) +
    " 区服=" + (a.partition || "-") +
    " g_tk=" + (a.gtk ? "已存" : "无") +
    " 票据有效至 " + (a.expire ? stamp(new Date(a.expire * 1000)) : "未知")
  );
}

function notify(title, sub, content) {
  var body = String(content) + UPLOAD_NOTE;
  if (NTFY_URL) $notification.post(title, sub, body, { openUrl: NTFY_URL });
  else $notification.post(title, sub, body);
}

function post(url, body, cookie) {
  return new Promise(function (resolve) {
    $httpClient.post(
      {
        url: url,
        timeout: 15000,
        "auto-cookie": false,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "*/*",
          Cookie: cookie,
          Referer: REFERER,
          "User-Agent": UA,
        },
        body: body,
      },
      function (err, resp, data) {
        resolve({
          err: err,
          status: resp ? resp.status : 0,
          text: typeof data === "string" ? data : "",
        });
      }
    );
  });
}

/** 带日志的请求 */
async function req(name, url, body, cookie) {
  var t0 = Date.now();
  var r = await post(url, body, cookie);
  logAppend([
    "[" + stamp() + "] POST " + name + " → " + r.status + "（" + (Date.now() - t0) + "ms）｜" +
      String(r.text).replace(/\s+/g, " ").slice(0, 150),
  ]);
  return r;
}

async function uploadLog(title) {
  if (!UPLOAD) return;
  if (!NTFY_TOPIC) {
    UPLOAD_NOTE = "\n⚠️ 插件参数 logTopic 没填，日志只留在本机（通知里就是全部内容）。";
    return;
  }
  var ok = false;
  await Promise.race([
    new Promise(function (resolve) {
      pushLog(title, function (err) {
        // v7：err === "busy" 表示抓包脚本刚推过同一批日志（20 秒内），不算失败，别弹假告警
        ok = !err || err === "busy";
        if (err === "busy") UPLOAD_NOTE = "\n（日志刚由抓包脚本推过，这次就不重复推了）";
        resolve();
      });
    }),
    sleep(UPLOAD_BUDGET),
  ]);
  if (!ok) UPLOAD_NOTE = "\n⚠️ 日志没推上去（网络/通道问题），已存在本机，下次抓包时会重试。";
}

function jparse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/* ───────────── 接口封装 ───────────── */

function amsBody(flow, openid, gtk) {
  return (
    "iActivityId=576370&iFlowId=" + flow +
    "&sOpenid=" + encodeURIComponent(openid) +
    "&openId=" + encodeURIComponent(openid) +
    "&g_tk=" + gtk
  );
}

function welfareUrl(route) {
  return WELFARE_URL + "?route=" + route + "&iActId=" + IACT_ID +
    "&sAppId=" + SAPP_ID + "&game=hyrz&e_code=0";
}

function roleBody(auth, extra) {
  return (
    "area=" + (auth.area || "2") +
    "&platId=" + (auth.platId || "1") +
    "&partition=" + (auth.partition || "") +
    "&roleId=" + (auth.roleId || "") +
    "&iActId=" + IACT_ID +
    "&sAppId=" + SAPP_ID +
    "&g_tk=" + (auth.gtk || "") +
    (extra || "")
  );
}

/** 解析 AMS 签到返回 */
function parseStatus(json) {
  if (!json || !json.modRet) return null;
  var mod = json.modRet;
  // 服务端的话术是 \uXXXX 转义的中文，先解回来再判断
  if (mod.iRet === 101 || unesc(mod.sMsg || "").indexOf("请先登录") >= 0) {
    return { needLogin: true };
  }
  var d = mod.jData || {};
  if (typeof d === "string") d = jparse(d) || {};
  return {
    needLogin: false,
    todaySigned: String(d.openid_jf_everyDay || "0") === "1",
    weekDays: Number(d.week_qd_roleid_everyDay || 0),
    monthDays: Number(d.qd_nums || 0),
  };
}

/* ───────────── 主流程 ───────────── */

async function main(opts) {
  opts = opts || {};
  var manual = !!opts.manual; // 手动模式：结果要带回去显示在网页上
  var force = !!opts.force; // 手动 + ?force=1：今天签过也再发一次签到流程（测试用）
  var t0 = Date.now();
  var auth = readAuth();
  var raws = []; // 手动模式下要带回去的服务端原文
  var lines = [];
  var title = manual ? "火影签到 · 手动" : "火影签到";
  if (manual) UPLOAD_BUDGET = 2500;

  logAppend([
    "",
    "[" + stamp() + "] ===== " + (manual ? "手动签到" : "自动签到") +
      (force ? "（强制）" : "") + "开始 · 脚本 " + VERSION + " =====",
  ]);

  if (!auth.cookie) {
    logAppend(["[" + stamp() + "] 本地还没有登录态，跳过"]);
    await uploadLog("火影签到日志");
    notify(
      title,
      "还没有登录信息",
      "保持 Loon 开启，打开一次微信小程序「火影忍者福利站」——Cookie 会自动抓取，之后每天自动签到。"
    );
    return { head: "还没有登录信息（先打开一次微信小程序）", lines: lines, raws: raws };
  }

  if (auth.expire && auth.expire * 1000 < Date.now()) {
    logAppend([
      "[" + stamp() + "] 票据已过期（" + stamp(new Date(auth.expire * 1000)) + "），跳过",
    ]);
    await uploadLog("火影签到日志");
    notify(
      title,
      "登录已过期（24h）",
      "打开一次微信小程序「火影忍者福利站」即可自动续期，下次定时任务会补上。"
    );
    return {
      head: "登录已过期（" + stamp(new Date(auth.expire * 1000)) + "）",
      lines: lines,
      raws: raws,
    };
  }

  logAppend(["[" + stamp() + "] 登录态 " + describeAuth(auth)]);

  var gtk = auth.gtk || "";
  var openid = auth.openid || "";
  // v9：默认用实测的签到流程；参数为空、或还留着旧默认的状态查询流程号，都按「没填」处理
  var signFlow = String(argOf("signFlow", "") || "").trim();
  if (!signFlow || signFlow === STATUS_FLOW) signFlow = SIGN_FLOW;

  // 1. 查签到状态
  var r1 = await req("状态查询 " + STATUS_FLOW, AMS_URL, amsBody(STATUS_FLOW, openid, gtk), auth.cookie);
  var j1 = jparse(r1.text);
  var st = parseStatus(j1);
  var t1 = topErr(j1);
  if (manual) raws.push(["状态查询 " + STATUS_FLOW, r1.text]);

  if (st && st.needLogin) {
    logAppend(["[" + stamp() + "] 登录态失效（AMS 提示请先登录）"]);
    await uploadLog("火影签到日志");
    notify(title, "登录已失效", "请重新打开一次微信小程序「火影忍者福利站」，Cookie 会自动更新。");
    return { head: "登录已失效（先打开一次微信小程序）", lines: lines, raws: raws };
  }
  if (!st) {
    // v9.2：服务端最近常直接扔一个顶层错误（连流程引擎都没进），把它的原话解成中文摆出来
    if (t1) {
      lines.push("签到状态：服务端直接挡回（顶层 ret=" + t1.ret + (t1.msg ? "｜" + t1.msg : "") + "）" + throttleHint(t1));
      logAppend(["[" + stamp() + "] 状态查询被顶层挡回 ret=" + t1.ret + (t1.msg ? "(" + t1.msg + ")" : "")]);
    } else {
      lines.push("签到状态：返回异常 " + String(r1.text).slice(0, 60));
    }
  } else {
    logAppend([
      "[" + stamp() + "] 状态：今日" + (st.todaySigned ? "已签" : "未签") +
        " 本周 " + st.weekDays + "/7 本月 " + st.monthDays + " 天",
    ]);
  }

  // v9.2：状态查询就被顶层挡回（限流）时，签到请求干脆别发 —— 越打恢复越慢，而且结果一定是错的
  var throttled = !!(t1 && !st && isThrottle(t1));
  if (throttled) {
    lines.push("服务端在限流（" + t1.msg + "）：这次连签到请求都没发，过一阵子再点一次就行 —— 跟脚本无关");
  }

  // 2. 该打签到就打签到流程
  //    v9：去掉了「参数等于状态流程就不打」的岔路 —— 只要今天还没签，签到请求就一定发出去
  //    v9.1：手动 + ?force=1 时，今天已签也照样发一次（用来现场验证流程号对不对）
  if (!throttled && (force || !st || !st.todaySigned)) {
    var signedBefore = !!(st && st.todaySigned);
    var r2 = await req(
      (force && signedBefore ? "强制签到动作 " : "签到动作 ") + signFlow,
      AMS_URL,
      amsBody(signFlow, openid, gtk),
      auth.cookie
    );
    var sj = jparse(r2.text);
    var st2 = parseStatus(sj);
    var t2 = topErr(sj);
    var fret = sj && sj.flowRet ? sj.flowRet.iRet : null;
    var fmsg = sj && sj.flowRet ? unesc(sj.flowRet.sMsg || "").slice(0, 60) : "";
    var ret = sj && sj.modRet ? sj.modRet.iRet : null;
    var msg = sj && sj.modRet ? unesc(sj.modRet.sMsg || "").slice(0, 60) : "";
    if (manual) raws.push(["签到动作 " + signFlow, r2.text]);
    logAppend([
      "[" + stamp() + "] 签到返回 flowRet.iRet=" + fmtRet(fret) + (fmsg ? "(" + fmsg + ")" : "") +
        " modRet.iRet=" + fmtRet(ret) + (msg ? "(" + msg + ")" : "") +
        (t2 ? " 顶层 ret=" + t2.ret + (t2.msg ? "(" + t2.msg + ")" : "") : ""),
    ]);
    // 再查一次确认（签到到底成没成，以复检为准）
    var r3 = await req("状态复检 " + STATUS_FLOW, AMS_URL, amsBody(STATUS_FLOW, openid, gtk), auth.cookie);
    var st3 = parseStatus(jparse(r3.text));
    if (manual) raws.push(["状态复检 " + STATUS_FLOW, r3.text]);
    if (st3 && !st3.needLogin) st = st3;
    else if (st2 && !st2.needLogin && st2.todaySigned) st = st2;
    // 顶层错误 = 这次请求连流程引擎都没进（签名里只有 ret/msg，没有 modRet）
    var t2s = t2 ? "顶层 ret=" + t2.ret + (t2.msg ? "｜" + t2.msg : "") + throttleHint(t2) : "";
    if (st && st.todaySigned && !signedBefore) {
      lines.push("签到：成功 ✅（流程 " + signFlow + "）");
    } else if (signedBefore) {
      // 本来就是已签状态 —— 不谎报成功，只把服务端原话摆出来
      lines.push(
        "签到：今天已经签过了，这次是为了测试强制重发（流程 " + signFlow + "）→ " +
          "服务端 flowRet.iRet=" + fmtRet(fret) + (fmsg ? "｜" + fmsg : "") +
          " · modRet.iRet=" + fmtRet(ret) + (msg ? "｜" + msg : "") +
          (t2s ? " · " + t2s : "")
      );
    } else if (t2s) {
      // 服务端顶层就把这次请求挡了 —— 这是它的事，不是流程号的事
      lines.push("签到：这次没进去（流程 " + signFlow + "）→ " + t2s);
    } else {
      // 把服务端的原话带回通知里，一眼能看出下一步该改什么
      lines.push(
        "签到：未确认（流程 " + signFlow + "，签到返回 iRet=" + fmtRet(ret) + (msg ? "｜" + msg : "") + "）"
      );
    }

    // 手动 + 强制：再打一条假流程做对照。
    // 假流程和真流程返回一模一样 → 这次请求本身没被认（多半是登录态问题），不能拿来判断流程号。
    if (force) {
      var rb = await req("对照（假流程 " + BOGUS_FLOW + "）", AMS_URL, amsBody(BOGUS_FLOW, openid, gtk), auth.cookie);
      var bj = jparse(rb.text);
      var bf = bj && bj.flowRet ? bj.flowRet.iRet : null;
      var bm = bj && (bj.modRet || bj.flowRet)
        ? unesc((bj.modRet && bj.modRet.sMsg) || (bj.flowRet && bj.flowRet.sMsg) || "").slice(0, 60)
        : "";
      var tb = topErr(bj);
      var br = bj && bj.modRet ? bj.modRet.iRet : null;
      if (manual) raws.push(["对照 · 假流程 " + BOGUS_FLOW, rb.text]);
      lines.push("对照：假流程 " + BOGUS_FLOW + " → flowRet.iRet=" + fmtRet(bf) + " · modRet.iRet=" + fmtRet(br) + (bm ? "｜" + bm : ""));
      if (t2) {
        // 签到那条根本没进流程引擎（顶层就被挡）→ 这种状态下「对比」没有意义，别给假结论
        lines.push("对照：这次不作数 —— 签到请求被服务端顶层挡回（顶层 ret=" + t2.ret + (t2.msg ? "｜" + t2.msg : "") + "）" + throttleHint(t2));
        if (tb) lines.push("（假流程 " + BOGUS_FLOW + " 也被挡：顶层 ret=" + tb.ret + (tb.msg ? "｜" + tb.msg : "") + "）");
      } else {
        lines.push(
          String(br) === String(ret) && String(bf) === String(fret)
            ? "⚠️ 签到流程和假流程返回完全一样 → 这次请求本身没被服务端认（多为登录态/参数问题），还不能据此判断流程号"
            : "✅ 签到流程的返回和假流程不一样 → 服务端认得 " + signFlow + " 这条流程，签到是有效的"
        );
      }
    }
  }

  // 3. 福利站礼包
  if (!throttled && argOf("claimGift", "true") === "true" && auth.roleId) {
    var listRes = await req("礼包列表", welfareUrl("Welfare/getWelfareStatusNow"), roleBody(auth, ""), auth.cookie);
    var listJson = jparse(listRes.text);
    var items =
      listJson && Object.prototype.toString.call(listJson.jData) === "[object Array]"
        ? listJson.jData
        : [];
    var claimable = items.filter(function (it) {
      return Number(it.leftQual) === 1;
    });

    if (claimable.length === 0) {
      lines.push("福利站礼包：暂无可领取");
      logAppend(["[" + stamp() + "] 礼包：共 " + items.length + " 项，没有可领的"]);
    } else {
      var skipped = 0;
      for (var i = 0; i < claimable.length; i++) {
        var it = claimable[i];
        var index = String(it.index || "");
        var name = String(it.name || index);
        if (!index) continue;
        var got = await req("领取 " + index, welfareUrl("Welfare/getWelfareGiftNow"), roleBody(auth, "&index=" + index), auth.cookie);
        var gj = jparse(got.text);
        var awards =
          gj && gj.jData && Object.prototype.toString.call(gj.jData.awardList) === "[object Array]"
            ? gj.jData.awardList
            : [];
        var ret = gj ? gj.iRet : -1;
        if (gj && ret === 0 && awards.length > 0) {
          var names = awards.map(function (a) {
            return String(a.sPackageName || "");
          });
          lines.push("已领取「" + name + "」→ " + names.join(" + "));
        } else if (ret === 2026 || ret === 4150) {
          // 2026 = 不是能直接领的礼包（比如签到入口）／4150 = 本周已领过
          skipped++;
        } else {
          lines.push("领取「" + name + "」失败：" + (unesc(gj && gj.sMsg) || "未知原因"));
        }
      }
      if (skipped > 0) lines.push("福利站：另有 " + skipped + " 项已领过或不可领");
    }
  }

  // 4. 汇总
  var head;
  if (st) {
    head =
      (st.todaySigned ? "今日已签到 ✅" : "今日未签到 ❌") +
      "　本周 " + st.weekDays + "/7 · 本月 " + st.monthDays + " 天";
  } else {
    head = "签到状态未知";
  }

  logAppend([
    "[" + stamp() + "] 结果：" + head +
      (lines.length ? "｜" + lines.join(" ／ ") : ""),
    "[" + stamp() + "] ===== 结束，用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s =====",
  ]);

  await uploadLog("火影签到日志");

  notify(
    title,
    head,
    (lines.length ? lines.join("\n") : "无需处理") + "\n\n（点击通知查看完整日志）"
  );

  return { head: head, lines: lines, raws: raws };
}

/* ───────────── 入口 ───────────── */

// v9.1：手动签到。插件里有一条 http-request 规则盯着这个地址，命中就不进真网络，直接返回一个假响应。
var MANUAL_RE = /^https?:\/\/ulinkact\.game\.qq\.com\/hyrz-sign-now(\?|$)/i;
// 对照用的假流程号：AMS 里不存在这个 flow，用来分辨「流程号错」和「这次请求本身没被认」
var BOGUS_FLOW = "999999";

// 服务端有时干脆不给这个字段（跟「返回 0」是两回事）：显示成「无」，免得看着像脚本出错
function fmtRet(v) {
  return v === null || v === undefined ? "无" : String(v);
}

// 服务端的报错文案是 \uXXXX 转义的中文，直接显示就是天书 —— 解回中文（并处理 \/ 与 \\\\）
function unesc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) {
      return String.fromCharCode(parseInt(h, 16));
    })
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

// 顶层错误：连流程引擎都没进就被挡回（响应里没有 modRet，只有 ret/msg、flowRet）
// —— 2026-09-26 实测：限流时就是这个形状（ret=-1「目前访问数过多！请稍后再试！」）
function topErr(j) {
  if (!j || j.modRet) return null;
  if (j.ret === undefined && j.msg === undefined && j.sMsg === undefined) return null;
  return { ret: fmtRet(j.ret), msg: unesc(j.msg || j.sMsg || "").slice(0, 60) };
}

// 服务端的限流/防刷话术：跟脚本、跟流程号都没关系，过一阵子就好
function isThrottle(t) {
  return !!t && /访问(数|人数)过[多频]|人数过多|稍后再试|too many|频繁|系统繁忙/i.test(t.msg || "");
}

function throttleHint(t) {
  if (!t) return "";
  if (isThrottle(t)) return "→ 这是服务端的限流/防刷（跟脚本无关），过一阵子再试一次";
  if (String(t.ret) === "-1") return "→ 服务端这次没受理（多为限流/防刷），过一阵子再试一次";
  return "";
}

/** 把这次结果拼成一页纯文本，直接当网页内容返回 */
function manualText(res) {
  res = res || {};
  var out = [];
  out.push("火影签到 · 手动签到（脚本 " + VERSION + "）");
  out.push("--------------------------------");
  out.push(res.head || "（无结果）");
  var ls = res.lines || [];
  for (var i = 0; i < ls.length; i++) out.push("· " + ls[i]);
  var raws = res.raws || [];
  if (raws.length) {
    out.push("");
    out.push("服务端原文（已把 \\uXXXX 转义解成中文、已脱敏）：");
    for (var j = 0; j < raws.length; j++) {
      out.push("[" + raws[j][0] + "]");
      // 先解码再脱敏：顺序不能反（解码后仍会被 redact 扫一遍）
      out.push(redact(unesc(raws[j][1])).replace(/\s+/g, " ").slice(0, 400));
    }
  }
  out.push("");
  out.push("时间 " + stamp() + "　（这一页可以关掉了，日志也会发到通知/频道）");
  return out.join("\n");
}

function reply(body) {
  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: body,
    },
  });
}

// 只在「被当成请求脚本调起来」时有值；定时任务里根本没有这个变量
var REQ_URL =
  typeof $request !== "undefined" && $request && $request.url ? String($request.url) : "";

if (REQ_URL && MANUAL_RE.test(REQ_URL)) {
  // —— 手动签到（浏览器里点一下） ——
  var FORCE = /[?&]force=1(&|$)/.test(REQ_URL);
  main({ manual: true, force: FORCE })
    .then(function (res) {
      reply(manualText(res));
    })
    .catch(function (e) {
      try {
        logAppend(["[" + stamp() + "] 手动签到出错：" + String(e)]);
      } catch (e2) {}
      reply("火影签到 · 手动签到出错：\n" + redact(String(e)));
    });
} else if (REQ_URL) {
  // 被当成请求脚本调起来了、但地址不匹配（插件的规则理论上不会让它发生）
  // —— 原样放行，绝不拖慢小程序自己的请求
  $done({});
} else {
  main({})
    .then(function () {
      $done();
    })
    .catch(function (e) {
      try {
        logAppend(["[" + stamp() + "] 出错：" + String(e)]);
      } catch (e2) {}
      notify("火影签到 · 出错", "", String(e));
      pushLog("火影签到日志", function () {
        $done();
      });
      setTimeout(function () {
        $done();
      }, 9000);
    });
}
