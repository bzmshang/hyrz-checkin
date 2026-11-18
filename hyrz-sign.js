/* v9.16.2 | 火影福利站：只对已配置的本人会话操作。不从网页触发，不搜索流程，不推送原始日志。 */
"use strict";
var VER = "9.16.2",
  NS = "hyrz_v916_",
  START = Date.now(),
  END = START + 45000;
var STATUS = "1083547",
  SIGN = "1083576";
var AMS =
  "https://x8m8.ams.game.qq.com/ams/ame/amesvr?ameVersion=0.3&sServiceType=hyrz&iActivityId=576370&game=hyrz&e_code=0";
var WEL = "https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php";
var ORIG_REFERER =
  "https://servicewechat.com/wxc47b57c32a7fe64b/230/page-frame.html";
var ORIG_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.57(0x18003921) NetType/4G Language/zh_CN";
var MODES = {
  "火影·每日签到": "daily",
  "火影·定时补领": "catch",
  "火影·待办检查": "pending",
  "火影·只读诊断": "diag",
  "火影·手动签到": "sign",
  "火影·手动补领": "task",
  "火影·看日志": "log",
};
var OUT = {
  init: "开始",
  capture: "未取得本版会话",
  incomplete: "会话缺字段",
  expired: "本机票据已到期",
  login: "接口未认可插件本次登录态",
  network: "网络请求未完成",
  http: "HTTP 请求失败",
  shape: "响应缺少明确的签到状态",
  business: "服务端返回业务错误",
  busy: "服务端繁忙或限流；本轮停止",
  changed: "会话已变化；本轮停止",
  locked: "另一项签到正在运行",
  storage: "本机状态无法保存",
  budget: "已到本轮时间上限",
  config: "配置或脚本入口不匹配",
  signed: "复检确认：本次已签",
  already: "状态查询确认：今天已签",
  unsigned: "状态查询确认：今天未签",
  unconfirmed: "已尝试；复检未确认签到",
  cooldown: "上次签到刚发出；不重复提交",
  task: "签到已确认；另见奖励结果",
  error: "脚本没有跑完",
};
var RR = {
  ok: "已查询",
  partial: "有项目未确认",
  unknown: "返回不可确认",
  busy: "遇限流，已停止",
  budget: "时间用尽，已停止",
  login: "需要刷新登录",
  noRole: "缺角色或区服",
  skipped: "未启用",
  stale: "请先在今天打开小程序刷新会话",
};
function read(k) {
  try {
    return JSON.parse($persistentStore.read(NS + k) || "null");
  } catch (e) {
    return null;
  }
}
function write(k, v) {
  try {
    return $persistentStore.write(JSON.stringify(v), NS + k) === true;
  } catch (e) {
    return false;
  }
}
function num(v) {
  return (typeof v === "string" || typeof v === "number") &&
    /^-?\d{1,7}$/.test(String(v))
    ? String(v)
    : "-";
}
function day(t) {
  return new Date(t + 8 * 3600000).toISOString().slice(0, 10);
}
function time(t) {
  return typeof t === "number" && t > 0 && t <= Date.now() + 86400000
    ? new Date(t + 8 * 3600000).toISOString().slice(5, 19).replace("T", " ")
    : "无记录";
}
function bag(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      var j = JSON.parse(v);
      return j && typeof j === "object" && !Array.isArray(j) ? j : null;
    } catch (e) {}
  }
  return null;
}
function enabled(v) {
  return v === true || v === "true";
}
function args() {
  var v = typeof $argument === "undefined" ? null : $argument;
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
// Literal fallback is restricted to read-only actions: a missing tag cannot trigger a write.
function readOnlyMode() {
  var arg = typeof $argument === 'undefined' ? null : $argument;
  return arg === 'read:diagnosis' ? 'diag' : arg === 'read:history' ? 'log' : null;
}
function localOutput(text) {
  try { console.log(String(text)); } catch (_) {} // Optional host API; $done still runs.
}
function modeOf() {
  if (readOnlyMode()) return readOnlyMode();
  var n = typeof $script === "undefined" ? "" : String($script.name || "");
  return /^火影·定时补领-(12|15|18|21|23)$/.test(n)
    ? "catch"
    : Object.prototype.hasOwnProperty.call(MODES, n)
      ? MODES[n]
      : null;
}
function delay(n) {
  return new Promise(function (ok) {
    setTimeout(ok, n);
  });
}
function active(a) {
  var b = read("auth");
  return !!(
    b &&
    a &&
    a.scope &&
    b.scope === a.scope &&
    b.cookie === a.cookie &&
    b.gtk === a.gtk &&
    b.openid === a.openid &&
    b.roleId === a.roleId &&
    b.partition === a.partition &&
    b.area === a.area &&
    b.platId === a.platId
  );
}
function form(o) {
  return Object.keys(o)
    .map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]);
    })
    .join("&");
}
function fault(kind) {
  var e = new Error(kind);
  e.kind = kind;
  return e;
}
function codeOK(v) {
  return v === undefined || String(v) === "0";
}
function http(opts, limit) {
  return new Promise(function (resolve) {
    var done = false,
      timer;
    function end(err, res, body) {
      if (done) return;
      done = true;
      if (typeof clearTimeout === "function" && timer) clearTimeout(timer);
      var j = null;
      try {
        j = typeof body === "string" ? JSON.parse(body) : null;
      } catch (e) {}
      resolve({
        err: !!err,
        status: (res && Number(res.status)) || 0,
        json: j,
      });
    }
    opts.timeout = Math.min(limit, END - Date.now() - 300);
    if (opts.timeout < 350) {
      resolve({ err: true, status: 0, json: null });
      return;
    }
    opts.insecure = false;
    opts["auto-cookie"] = false;
    opts["auto-redirect"] = false;
    timer = setTimeout(function () {
      end(true);
    }, opts.timeout + 180);
    try {
      $httpClient.post(opts, end);
    } catch (e) {
      end(true);
    }
  });
}
function game(a, url, body) {
  if (Date.now() > END - 1200) throw fault("budget");
  if (!active(a)) throw fault("changed");
  if (a.expire && Number(a.expire) * 1000 <= Date.now()) throw fault("expired");
  return http(
    {
      url: url,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: a.cookie,
        Referer: ORIG_REFERER,
        "User-Agent": ORIG_UA,
      },
      body: form(body),
    },
    6800,
  );
}
function ams(a, flow) {
  // Local timing hint only, not an HTTP header. This interval can include
  // concurrent mini-program traffic, so the hook cannot label it as official.
  write("cmp_ownUntil", Date.now() + 15000);
  return game(a, AMS, {
    iActivityId: "576370",
    iFlowId: flow,
    sOpenid: a.openid,
    openId: a.openid,
    g_tk: a.gtk,
  });
}
function evidence(r) {
  var j = bag(r.json) || {},
    m = bag(j.modRet) || {},
    f = bag(j.flowRet) || {};
  return (
    "HTTP=" +
    num(r.status) +
    " 顶层=" +
    num(j.ret) +
    " 流程=" +
    num(f.iRet) +
    " 业务=" +
    num(m.iRet !== undefined ? m.iRet : j.iRet)
  );
}
function failure(r) {
  if (r.status === 429) return "busy";
  if (r.status === 401) return "login";
  if (r.err || !r.status) return "network";
  if (r.status < 200 || r.status >= 300) return "http";
  var j = bag(r.json);
  if (!j) return "shape";
  var m = bag(j.modRet) || {},
    f = bag(j.flowRet) || {};
  var codes = [j.ret, j.iRet, m.iRet, f.iRet].map(String);
  var msg = [j.msg, j.sMsg, m.sMsg, f.sMsg]
    .map(function (s) {
      return typeof s === "string"
        ? s.slice(0, 160).replace(/\\u([a-f0-9]{4})/gi, function (_, h) {
            return String.fromCharCode(parseInt(h, 16));
          })
        : "";
    })
    .join(" ");
  if (codes.indexOf("101") >= 0 || /请先登录|登录已失效|登录已过期/.test(msg))
    return "login";
  if (
    codes.indexOf("1103") >= 0 ||
    codes.indexOf("4414") >= 0 ||
    /访问数过多|手速太快|请求频繁|系统繁忙|too many/i.test(msg)
  )
    return "busy";
  if (![j.ret, j.iRet, m.iRet, f.iRet].every(codeOK)) return "business";
  return null;
}
function status(r) {
  var why = failure(r);
  if (why) return why;
  var mod = bag(r.json.modRet),
    data = mod && bag(mod.jData),
    v = data && data.openid_jf_everyDay;
  return v === 0 || v === "0"
    ? "unsigned"
    : v === 1 || v === "1"
      ? "already"
      : "shape";
}

function compareLine() {
  var now = Date.now(), pieces = [];
  function recent(x) {
    return x && Number.isSafeInteger(x.at) && x.at > 0 && x.at <= now && day(x.at) === day(now);
  }
  function val(x) { return Number.isSafeInteger(x) ? num(x) : "-"; }
  function clock(x) { return time(x.at).slice(-8); }
  [["status","状态1083547"],["sign","动作1083576"],["ams","未归类AMS"]].forEach(function(pair) {
    var prefix = "cmp_" + pair[0], req = read(prefix + "_req"), res = read(prefix + "_resp");
    if (!recent(req) && !recent(res)) return;
    var parts = [];
    if (recent(res)) parts.push("响应 " + clock(res) + " HTTP=" + val(res.http) + " 顶层=" + val(res.top) + " 流程=" + val(res.flow) + " 业务=" + val(res.biz) + (res.signed === 1 ? " 已签" : res.signed === 0 ? " 未签" : ""));
    if (recent(req) && (!recent(res) || req.at > res.at)) parts.push("另见请求 " + clock(req) + "（未确认对应响应）");
    pieces.push(pair[1] + "：" + parts.join("，"));
  });
  var overlap = read("cmp_overlap");
  if (recent(overlap)) pieces.push("与插件请求时间重叠 " + clock(overlap) + "（不计入上述观察）");
  return "签到页观察（今日被动记录）：" + (pieces.join("；") || "暂无 AMS 记录");
}
function snapshot() {
  var c = read("capture") || {},
    a = read("auth") || {},
    last = read("daily") || {};
  return [
    "本机时间记录（东八区）｜v" + VER,
    compareLine(),
    "最近捕获" + (c.rev === 2 ? "（采集 v9.16.2）" : "（尚无新版采集）") + "：" +
      time(c.at) +
      "；类型：" +
      ({ ams: "活动", welfare: "福利站", status: "签到状态", sign: "签到动作" }[
        c.kind
      ] || "-") +
      "；流程=" +
      num(c.flow) +
      "；请求/响应 HTTP=" +
      num(c.http) +
      " 业务=" +
      num(c.code),
    "会话：" +
      (a.cookie ? "有" : "无") +
      "；身份字段：" +
      (a.openid ? "有" : "无") +
      "；校验字段：" +
      (a.gtk ? "有" : "无") +
      "；角色：" +
      (a.roleId ? "有" : "无") +
      "；到期：" +
      time(Number(a.expire) * 1000),
    "最近每日定时：" + time(last.at) + " / " + (OUT[last.state] || "无记录"),
  ];
}
function record(mode, r) {
  var e = {
    at: Date.now(),
    mode: mode,
    state: r.state,
    steps: r.steps.slice(0, 5),
  };
  if (mode === "daily") write("daily", e);
  var arr = read("events");
  if (!Array.isArray(arr)) arr = [];
  arr.push(e);
  write("events", arr.slice(-24));
}
function row(e) {
  return (
    time(e.at) +
    " " +
    ({
      daily: "每日",
      catch: "定时补领",
      pending: "待办",
      diag: "诊断",
      sign: "手动签到",
      task: "手动补领",
    }[e.mode] || "-") +
    "：" +
    (OUT[e.state] || "-") +
    (Array.isArray(e.steps) && e.steps.length
      ? "\n  " + e.steps.slice(0, 5).join("\n  ")
      : "")
  );
}
function makeResult(state, steps) {
  return { state: state, steps: steps || [] };
}
function isAuto(m) {
  return ["daily", "catch", "pending"].indexOf(m) >= 0;
}
var ticket = "";
async function acquire() {
  var cur = read("lease"),
    now = Date.now();
  if (cur && cur.until > now) return false;
  var mine = now + "-" + Math.random();
  if (!write("lease", { id: mine, until: now + 60000 })) throw fault("storage");
  await delay(220);
  cur = read("lease");
  if (!cur || cur.id !== mine) return false;
  ticket = mine;
  return true;
}
function release() {
  var cur = read("lease");
  if (ticket && cur && cur.id === ticket) write("lease", null);
  ticket = "";
}
function owns() {
  var cur = read("lease");
  return ticket && cur && cur.id === ticket && cur.until > Date.now();
}
function updateDay(a, d) {
  if (!active(a) || !owns()) throw fault("changed");
  if (!write("day", d)) throw fault("storage");
}
function alreadyDone(d, g, t) {
  return (
    d.signed === true && (!g || d.gifts === true) && (!t || d.full === true)
  );
}
function statusBody(a) {
  if (!a || !a.cookie || !a.scope) return "capture";
  if (!a.openid || !a.gtk) return "incomplete";
  if (a.expire && Number(a.expire) * 1000 <= Date.now()) return "expired";
  return "";
}
function rewardIO(a) {
  var allowed = [
    "Welfare/getWelfareStatusNow",
    "Welfare/getWelfareGiftNow",
    "Welfare/getTodayActInfo",
    "Index/taskLotteryNow",
    "Welfare/getTodayActGiftNow",
  ];
  return {
    enough: function () {
      return Date.now() < END - 5000;
    },
    wait: delay,
    call: async function (route, extra) {
      if (!owns() || !active(a)) throw fault("changed");
      if (allowed.indexOf(route) < 0) throw fault("config");
      var body = {
        area: a.area,
        platId: a.platId,
        partition: a.partition,
        roleId: a.roleId,
        iActId: "8265",
        sAppId: "ULINK-AKKJ-784060",
        g_tk: a.gtk,
      };
      if (extra && Object.prototype.hasOwnProperty.call(extra, "index")) {
        if (!/^[A-Za-z0-9_-]{1,48}$/.test(String(extra.index)))
          throw fault("config");
        body.index = extra.index;
      }
      return game(
        a,
        WEL +
          "?route=" +
          route +
          "&iActId=8265&sAppId=ULINK-AKKJ-784060&game=hyrz&e_code=0",
        body,
      );
    },
  };
}
async function run(mode, arg, a, pending) {
  var steps = [],
    r = makeResult("init", steps),
    diag = mode === "diag";
  var authErr = statusBody(a);
  if (authErr) return makeResult(authErr);
  var flow = String(arg.signFlow || SIGN);
  if (!/^\d{1,9}$/.test(flow) || flow === STATUS) return makeResult("config");
  var gift = mode !== "task" && enabled(arg.claimGift),
    tasks =
      mode === "task" ||
      mode === "catch" ||
      mode === "pending" ||
      (mode === "daily" && enabled(arg.autoTasks));
  var k = day(Date.now()),
    d = read("day") || {};
  if (d.scope !== a.scope || d.d !== k) d = { scope: a.scope, d: k };
  if (diag) {
    var query = await ams(a, STATUS);
    r.state = active(a) ? status(query) : "changed";
    steps.push("查状态 " + STATUS + "：" + evidence(query));
    return r;
  }
  if (!owns()) return makeResult("locked");
  if ((mode === "pending" || mode === "catch") && alreadyDone(d, gift, tasks))
    return { silent: true, ack: true };
  var q = await ams(a, STATUS),
    s = status(q);
  steps.push("查状态 " + STATUS + "：" + evidence(q));
  if (!active(a)) return makeResult("changed", steps);
  if (s !== "already" && s !== "unsigned") return makeResult(s, steps);
  if (s === "unsigned") {
    d.signed = false;
    if (d.attempt && Date.now() - d.attempt < 600000)
      return makeResult("cooldown", steps);
    d.attempt = Date.now();
    updateDay(a, d);
    var action = await ams(a, flow);
    steps.push("签到动作 " + flow + "：" + evidence(action));
    var actionFail = failure(action);
    if (actionFail === "busy" || actionFail === "login")
      return makeResult(actionFail, steps);
    var chk = await ams(a, STATUS),
      after = status(chk);
    steps.push("复检 " + STATUS + "：" + evidence(chk));
    if (!active(a)) return makeResult("changed", steps);
    if (after !== "already") {
      steps.push("复检结论：" + (OUT[after] || OUT.shape));
      return makeResult("unconfirmed", steps);
    }
    r.state = "signed";
  } else r.state = "already";
  d.signed = true;
  updateDay(a, d);
  if (!tasks && !gift) {
    r.ack = true;
    return r;
  }
  if (!a.roleId || !a.area || !a.platId || !a.partition) {
    steps.push("奖励：" + RR.noRole);
    return r;
  }
  var pendingTasks = tasks;
  if (tasks && (!a.expire || day((Number(a.expire) - 86400) * 1000) !== k)) {
    pendingTasks = false;
    steps.push("活跃：" + RR.stale);
  }
  if (gift || pendingTasks) {
    var w = await welfarePass(rewardIO(a), { gift: gift, tasks: pendingTasks });
    var g = RR[w.giftState] || RR.unknown,
      t = RR[w.taskState] || RR.unknown;
    if (gift) steps.push("礼包：" + g + "；本次领取 " + num(w.gifts));
    if (pendingTasks)
      steps.push(
        "活跃：" +
          t +
          "；本次任务 " +
          num(w.claims) +
          "、宝箱 " +
          num(w.boxes) +
          "；积分 " +
          num(w.points) +
          (w.full ? "；已复核领满" : ""),
      );
    if (gift) d.gifts = w.giftState === "ok";
    if (pendingTasks) d.full = w.full === true;
    updateDay(a, d);
    r.ack = (!tasks || pendingTasks) && w.state === "ok";
  }
  return r;
}
async function summaryPush(mode, r, arg) {
  if (!isAuto(mode) || !enabled(arg.uploadLog) || !r || r.silent) return;
  var t = String(arg.logTopic || "");
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(t) || Date.now() > END - 1800) return;
  var v = await http(
    {
      url: "https://ntfy.sh/",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: t,
        title: "火影签到 v" + VER,
        message: OUT[r.state] || OUT.error,
      }),
    },
    1500,
  );
  if (v.err || v.status < 200 || v.status >= 300)
    r.steps.push("频道摘要未获确认；不重发");
}
async function entry() {
  // 没有 HTTP 控制面，即使旧规则误调用也直接放行。
  if (typeof $request !== "undefined" && $request != null) {
    // Never reinterpret an HTTP hook as a Generic action. Only an empty placeholder
    // with an explicitly read-only Generic argument may proceed; no mutation.
    if ($request.url || !readOnlyMode()) return {};
  }
  var m = modeOf(),
    arg = args(),
    a = read("auth"),
    p = read("pending");
  if (m === 'diag' || m === 'log') localOutput('[火影 v' + VER + '] ' + (m === 'diag' ? '只读诊断开始（不会签到或领奖）' : '读取本机运行记录'));
  if (!m)
    return {
      title: "火影 v" + VER,
      content: OUT.config + "；请确认只启用本版插件，且入口 tag 未改名。",
    };
  if (m === "log") {
    var rows = read("events");
    return {
      title: "火影·本机记录 v" + VER,
      content: snapshot()
        .concat(
          ["最近运行："],
          (Array.isArray(rows) ? rows : []).slice(-5).reverse().map(row),
        )
        .join("\n"),
    };
  }
  if (m === 'diag' && readOnlyMode()) arg = {}; // No plugin settings required for a status read.
  if (!arg) {
    return {
      title: "火影 v" + VER,
      content: "插件参数未绑定：请从 v9.16 插件的入口运行，未发出请求。",
    };
  }
  if (m === "pending" || m === "catch") {
    if (!enabled(arg.catchup)) return {};
    if (m === "pending") {
      if (
        !a ||
        !p ||
        p.scope !== a.scope ||
        p.at !== a.updated ||
        !Number.isSafeInteger(p.at) ||
        day(p.at) !== day(Date.now())
      )
        return {};
      var tried = read("pendingTry");
      if (
        tried &&
        tried.scope === p.scope &&
        tried.at === p.at &&
        tried.next > Date.now()
      )
        return {};
    }
  }
  var r;
  if (m === "daily") write("daily", { at: Date.now(), state: "init" });
  try {
    if (m !== "diag" && !(await acquire())) r = makeResult("locked");
    else {
      a = read("auth");
      if (
        m === "pending" &&
        (!a || !p || p.scope !== a.scope || p.at !== a.updated)
      )
        return {};
      if (
        m === "pending" &&
        !write("pendingTry", {
          scope: p.scope,
          at: p.at,
          next: Date.now() + 30 * 60000,
        })
      )
        throw fault("storage");
      r = await run(m, arg, a, p);
      if (
        r.ack &&
        (m === "task" || m === "pending" || m === "catch") &&
        p &&
        a &&
        p.scope === a.scope &&
        owns()
      ) {
        var current = read("pending");
        if (current && current.scope === p.scope && current.at === p.at)
          write("pending", null);
      }
    }
  } catch (e) {
    r = makeResult(
      e && Object.prototype.hasOwnProperty.call(OUT, e.kind) ? e.kind : "error",
    );
  } finally {
    release();
  }
  if (r.silent) return {};
  if (r.state !== "locked") await summaryPush(m, r, arg);
  record(m, r);
  if (isAuto(m)) {
    if (m === "daily" || r.state === "signed") {
      try {
        $notification.post(
          "火影签到 v" + VER,
          OUT[r.state],
          r.steps
            .filter(function (x) {
              return /^(活跃|礼包)：/.test(x);
            })
            .join("\n") || "详情在「火影·看日志」",
        );
      } catch (e) {}
    }
    return {};
  }
  return {
    title: "火影 v" + VER + "｜" + OUT[r.state],
    content: [
      "版本 v" + VER + "｜" + (m === "diag" ? "只读诊断" : "手动运行"),
      "结论：" + OUT[r.state],
    ]
      .concat(r.steps, snapshot())
      .join("\n"),
  };
}
(function () {
  var done = false;
  function finish(v) {
    if (!done) {
      done = true;
      if (v && typeof v.content === 'string') localOutput(v.content);
      $done(v || {});
    }
  }
  entry().then(finish, function () {
    finish({
      title: "火影 v" + VER,
      content: "本次未跑完；请查看 Loon 脚本运行记录。",
    });
  });
})();
// Standalone concatenation unit. No host globals, storage or cached panel.
async function welfarePass(io, opts) {
  const out = {state: 'ok', gifts: 0, claims: 0, boxes: 0, points: null,
    full: false, giftState: 'skipped', taskState: 'skipped'};
  const keys = ['readArticle', 'like', 'dynamicArticle', 'goldHelper', 'scrollRecord',
    'actCalendar', 'wallpaper', 'ninja', 'guestInfo', 'sign', 'duel', 'active', 'phone'];
  const targets = [40, 60, 100];
  let calls = 0, phase;
  // Only locally generated states may escape. Never copy upstream messages or names.
  class Stop { constructor(state) { this.state = state; } }
  function stop(state) { throw new Stop(state); }
  function need(condition) { if (!condition) stop('unknown'); }
  function record(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function integer(x) {
    if (typeof x === 'string' && x.length <= 17 && /^-?(0|[1-9][0-9]*)$/.test(x)) x = Number(x);
    return Number.isSafeInteger(x) ? x : null;
  }
  function uint(x) { const n = integer(x); need(n !== null && n >= 0); return n; }
  function list(x) {
    need(Array.isArray(x));
    if (x.length > 64) stop('budget');
    return x;
  }
  function message(x) {
    return typeof x === 'string' ? x.slice(0, 512).replace(/\\u([\da-f]{4})/gi,
      (_, h) => String.fromCharCode(parseInt(h, 16))) : '';
  }
  async function request(route, index) {
    if (calls >= 20 || io.enough() !== true) stop('budget');
    if (calls) {
      await io.wait(250);
      if (io.enough() !== true) stop('budget');
    }
    calls++;
    const r = await io.call(route, index === undefined ? {} : {index});
    need(record(r));
    if (r.status === 429) stop('busy');
    if (r.status === 401) stop('login');
    need(r.err === false && Number.isInteger(r.status));
    const j = r.json;
    need(record(j));
    const code = integer(j.iRet), top = integer(j.ret);
    // A gateway may return a flow envelope instead of the welfare response.
    // Read its stop signals, but never accept it as a successful welfare call.
    const layers = [j, j.flowRet, j.modRet].filter(record);
    const codes = [top, ...layers.map(layer => integer(layer.iRet))];
    const text = layers.map(layer => message(layer.msg) + ' ' + message(layer.sMsg)).join(' ');
    if (codes.some(n => n === 1103 || n === 4414 || n === 429) ||
        (top !== null && top !== 0 && /访问(数|人数)过[多频]|人数过多|稍后再试|频繁|系统繁忙|too many|rate limit/i.test(text))) stop('busy');
    need(r.status >= 200 && r.status < 300);
    if (codes.includes(101) || /请(先|重新)?登录|未登录|登录(态)?(已)?(过期|失效)|not logged in/i.test(text)) stop('login');
    if (/(未绑定|请(先)?绑定)(游戏)?角色|角色不存在|no role bound/i.test(text)) stop('noRole');
    need((j.ret === undefined || top === 0) && code !== null && j.modRet === undefined && j.flowRet === undefined);
    return {code, data: j.jData};
  }
  // A panel/list is an atomic snapshot. Validate even the non-eligible rows
  // before the first write; duplicate or unrecognised identities are not evidence.
  function rows(items, kind, points) {
    const seen = new Set(), eligible = [];
    let allReady = true;
    for (const row of list(items)) {
      need(record(row));
      const left = uint(row.leftQual);
      need(left <= 1);
      let id = row.index, ready = true;
      if (kind === 'gift') {
        if (Number.isSafeInteger(id) && id >= 0) id = String(id);
        need(typeof id === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(id));
      } else {
        const target = uint(row.target), done = uint(row.curDone);
        need(target > 0);
        ready = done >= target;
        if (kind === 'box') {
          const n = uint(id);
          need(n < targets.length && target === targets[n]);
          id = String(n);
          ready = ready || points >= target;
        } else need(keys.includes(id));
      }
      need(!seen.has(id));
      seen.add(id);
      if (left === 1 && ready) eligible.push(id);
      if (!ready) allReady = false;
    }
    if (kind === 'box') need(seen.size === targets.length);
    return {eligible, allReady};
  }
  async function panel() {
    out.points = null;
    const {code, data} = await request('Welfare/getTodayActInfo');
    need(code === 0 && record(data));
    const points = uint(data.actIntegral);
    const tasks = rows(data.integralTaskList, 'task', points);
    const boxes = rows(data.task, 'box', points);
    out.points = points;
    return {tasks, boxes};
  }
  // Exactly one attempt per offered index, in panel order. A known refusal
  // stays partial even if a later panel no longer offers the item.
  async function collect(ids, cap, route, count, refusals) {
    for (let i = 0; i < ids.length; i++) {
      if (i >= cap) stop('budget');
      if (count !== 'gifts') out.points = null; // mutation may change the last snapshot
      const {code, data} = await request(route, ids[i]);
      if (refusals.includes(code)) { out[phase] = 'partial'; continue; }
      need(code === 0);
      if (count === 'gifts') {
        need(record(data));
        const awards = list(data.awardList);
        need(awards.length > 0 && awards.every(record));
      }
      out[count]++;
    }
  }
  try {
    if (opts && opts.gift === true) {
      phase = 'giftState'; out[phase] = 'ok';
      const {code, data} = await request('Welfare/getWelfareStatusNow');
      need(code === 0);
      await collect(rows(data, 'gift').eligible, 4, 'Welfare/getWelfareGiftNow', 'gifts', [2026, 4150, 4411]);
    }
    if (opts && opts.tasks === true) {
      phase = 'taskState'; out[phase] = 'ok';
      let p = await panel();
      if (p.tasks.eligible.length) {
        await collect(p.tasks.eligible, 10, 'Index/taskLotteryNow', 'claims', [1226, 1228, 4027, 4036]);
        p = await panel(); // new points/box eligibility, never add points locally
      }
      if (p.boxes.eligible.length) {
        await collect(p.boxes.eligible, 3, 'Welfare/getTodayActGiftNow', 'boxes', [2026, 4150, 4027, 4036]);
        p = await panel(); // a successful open alone is not completion evidence
      }
      if (p.tasks.eligible.length || p.boxes.eligible.length) out[phase] = 'partial';
      out.full = p.boxes.allReady && out[phase] === 'ok' && out.giftState !== 'partial';
    }
    if (out.taskState === 'partial' || out.giftState === 'partial') out.state = 'partial';
  } catch (e) {
    const budget = e === 'budget' || (e && [e.kind, e.code, e.name, e.message]
      .some(v => v === 'budget' || v === 'BUDGET' || v === 'BudgetError'));
    out.state = e instanceof Stop ? e.state : budget ? 'budget' : 'unknown';
    if (phase) out[phase] = out.state;
    out.full = false;
  }
  return out;
}
