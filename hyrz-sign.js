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
 * v9.4「活跃任务」——福利站里那个「活跃任务」面板（浏览帖子 / 点赞 / 看金币助手……攒积分开宝箱）：
 *   https://ulinkact.game.qq.com/hyrz-task-now           → 先跑一遍签到 + 礼包，再处理活跃任务
 *                                                           （后面加 ?report=0 就只领不「上报查看类任务」）
 *   定时任务默认不碰活跃任务：要把参数 autoTasks 打开才会顺带领一次（且不会替你去「逛页面」）。
 *
 * v9.5 —— 修一个把服务端「正常返回」误判成「顶层挡回」的 bug：
 *   ulinkact 的接口正常返回形状是 {"iRet":0,"sMsg":"ok","jData":{…}}（**没有** modRet），
 *   而「顶层挡回」的判断原来是「没有 modRet、但有 sMsg」→ 面板一拉回来就被判成被挡回，
 *   活跃任务整段直接跳过（2026-09-27 09:36 真机实测就是这样：页面写着「服务端顶层挡回（ret=无｜ok）」）。
 *   现在只有真带 ret（且非 0）才算顶层挡回，带 jData 的一律按正常返回处理；
 *   手动页还会多印一行「任务进度」，每项做到哪、能不能领一眼可见。
 *
 * v9.6 —— 活跃任务的「领」和「上报」两件事按新证据重排，手动页再加两段诊断：
 *   ① 「领任务奖励」改用 Index/taskLotteryNow：09-26 真实抓包里点「领取」发的就是它，
 *      回 iRet=0「领取任务奖励成功」、今日积分 70→90。旧代码用的 Welfare/getTodayActGiftNow
 *      其实是**积分宝箱**的接口（09-25 抓包：今日积分 70 时它被连着调了 2 次，正好是门槛
 *      40 / 60 的两个宝箱），拿它按任务键去领，服务端一律回 4027「无活跃度不能领取奖励」。
 *   ② 上报查看类任务去掉 readArticle / like：服务端对这两个 index 回 1226「index参数范围不对」，
 *      它们只能在小程序里真的去读帖子 / 点赞（其余 7 个都能被 taskDone 认掉）。
 *   ③ 手动页多两段诊断：「日志上报」状态行（上报开关 / 频道名有没填）和本机抓包日志尾巴。
 *      频道一直没动静时，这两段就能说明是「频道名没填」「上报被卡」还是「本机根本没抓到」。
 *   ④ 另外：可以用 ?topic=<频道名> 把频道名存进本机（两个脚本共用），升级插件不会丢。
 *
 * v9.10 —— 「等一下就好」的服务端忙码就地重试（09-28 09:00 定时任务实测）：
 *   那天 09:00 准点那一跑，7 项奖励领取全被服务端回 4414「系统繁忙，请重试」，
 *   「今日查看忍者站」的上报被回 1103「手速太快了，请稍后再试」→ 今日积分停在 0/100。
 *   这两个码的返回里都带 jData，走的不是「顶层挡回」那条路（旧的限流判断认不出来），
 *   所以加了 busyCode()：撞上 1103 / 4414 时同一项再试两次（中间歇 0.9~1.8s），
 *   一整批都在忙就歇 4s 整批再来一轮（最多两轮）；两轮后照实写一行
 *   「服务端在限流（…）：N 项…没成，过一会儿再来一次就行」——不谎报，也不硬刚。
 *
 * v9.11 —— 4414 的真因找到了，并据此做出「补领」（09-28 真机实测）：
 *   ① 真因**不是**限流，而是「登录态不是当天刷新的」：读接口（活跃信息 / 任务状态）用旧会话
 *      照常能看，但发奖接口 Index/taskLotteryNow 只认「当天在小程序里刷出来」的那个会话。
 *      证据：09-28 09:00 那跑用的是 09-27 12:47 抓的票据 → 7 项奖励全被回 4414；
 *      当天 10:25 用户在小程序里点了一下（票据 10:25:01 刷新），同一份脚本 10:26 再跑就
 *      顺顺当当领了 9 项 +140、积分 10 → 150、开掉 3 个宝箱。
 *      所以不再硬刚忙码：authStale() 看出会话不是今天的就**不领**（一行「活跃任务：没领 ——
 *      登录态不是今天的…」），省得白挨一顿「系统繁忙」。
 *   ② 补领：插件多挂了两条 cron（12:00 / 21:00，同一个脚本、多带一个参数 catchup）——
 *      你在小程序里点一下把票据刷新之后，它们会把当天没领的奖励补上；跑完只在真领到东西时
 *      才发通知（已经领满 / 会话还是旧的就不打扰）。
 *   ③ 抓包脚本同版本起还会在「抓到今天的票据、且当天确实没领满」时发一条「点我补领」的
 *      通知（一天最多一条），点开当场补齐。
 *   ④ 09:00 那一跑如果票据还是昨天的，就只做签到 + 礼包，奖励留给补领 —— 不谎报、不白打。
 *   本机标记 hyrz_day = {d, full, pts}：记「今天有没有领满」，补领和通知都看它。
 *
 * v9.9 —— 通知与插件详情瘦身（用户：「loon 上面那个详细太多了，一长片」）：
 *   ① 通知正文只留结论行（签到 / 礼包 / 已领 N 项 / 已开积分宝箱 N 个 / 活跃自检 / 还没做完的 N 项 / 限流提示），
 *      逐项明细（每项任务的返回、宝箱原文、对照行、上报结果）只写在频道日志和手动页里。
 *   ② 插件 #!desc 从一大片历史变更压成一段话（历史都放在仓库的更新日志里）。
 *
 * v9.8 —— 让「活跃任务」也能全自动（小程序这边能做的，保证拿到 100 分以上）：
 *   ① 定时任务打开参数 autoTasks 后，会**连「上报查看类任务」一起做**（v9.4~v9.7 只有手动页才上报），
 *      所以不用开浏览器也能攒够积分（100 分是第 3 个积分宝箱的门槛：40 / 60 / 100）。
 *   ② 每次跑完多一行自检「活跃自检：今日积分 X/100」，不够时把「没做完的项」列出来，
 *      并标明哪几项只能你自己做（服务端实测不认脚本代发的那几个）。
 *
 * * 所有接口均来自抓包实测，已在 Scripting 运行时验证可在脚本里重放。
 */

/* v9.13 —— 抓包脚本不再发「该补领了」通知（用户 2026-10-02：「补领通知能不能不要一直发」）：
   那条通知的前提本来就是「你人已经在小程序里了」，再弹一条纯属多余；而签到通知里那行
   「活跃任务：没领 —— 打开一次微信小程序就自动补领」已经把话说清楚了。
   签到脚本这一版没改逻辑，只跟着升版本号就行——
   v9.12 —— 通知瘦身 + 插件里的手动按钮（用户 2026-10-01：「通知里面不要写一大堆什么需要手动的 /
   通知点开不要去跳转，在插件里面做个跳转按钮去日志，根据不同的id跳 / 插件里面增加手动签到补领的按钮别用个url」）：
   ① 通知只讲「自动领到了什么 / 什么没领到（+原因）」，不再列「还没做完的 N 项」那些要你自己动手的清单。
   ② 通知不再挂 openUrl —— 点开只是看内容，不再往浏览器/频道跳。
   ③ 插件里新增三条手动入口（Loon 的「脚本」列表里点一下就跑，结果直接出在 Loon 内的网页里）：
      火影·手动签到 / 火影·手动补领 / 火影·看日志；网页顶部三个按钮按 id 跳不同页面（sign / task / log）。
   ④ 顺手修 12:00 / 21:00 两条补领 cron：cron 表达式按官方写法加引号（实测这两条从装上起一次都没跑过）。
*/
var VERSION = "v9.13"; // 这行会打印在手动页上，方便确认线上/本机是不是同一版
var AUTH_KEY = "hyrz_auth";
var LOG_KEY = "hyrz_log";
var DIRTY_KEY = "hyrz_log_dirty";
var PUSH_TS_KEY = "hyrz_log_ts";
var LOG_MAX = 200;
var DAY_KEY = "hyrz_day"; // v9.11 本机标记：{d:"2026-09-28", full:true, pts:150} —— 补领靠它判断今天有没有领满
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
// v9.11：多一个 catchup —— 只有「补领」那两条 cron 会带它，09:00 那条不带（见文件头 v9.11）
var ARG_ORDER = ["claimGift", "signFlow", "uploadLog", "logTopic", "autoTasks", "catchup"];
var TOPIC_KEY = "hyrz_log_topic"; // 频道名只存在本机（插件参数读一次就缓存下来；?topic= 也能写）
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
    var t = argTable();
    if (t) fromArg = unsubstituted(t.logTopic);
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
// v9.12：还多认一种形状 —— 纯字面量字符串（插件里那三条 generic 手动按钮写的就是 argument="now=sign"），
//        并且把「没被替换掉」的 {占位符} 当成没填：这样万一某个形状不被支持，也只是回落到默认值，不会把
//        "{claimGift}" 这种字符串当成真值用出去。

/** $argument 归一化成 {名字: 值}：数组按 ARG_ORDER 对位，字符串按 k=v 解析 */
function argTable() {
  var a = null;
  try {
    a = $argument;
  } catch (e) {
    a = null;
  }
  if (a === undefined || a === null) return null;
  if (Object.prototype.toString.call(a) === "[object Array]") {
    var o = {};
    for (var i = 0; i < ARG_ORDER.length && i < a.length; i++) o[ARG_ORDER[i]] = a[i];
    return o;
  }
  if (typeof a === "object") return a;
  var s = String(a).replace(/["']/g, ""); // 万一 Loon 把 argument="now=sign" 连引号一起递过来
  if (!s) return null;
  var map = {};
  var re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^,;&]*)/g;
  var m;
  var hit = 0;
  while ((m = re.exec(s)) !== null) {
    map[m[1]] = m[2];
    hit++;
  }
  // 也照顾「只给了一个值」的形状（比如 argument="sign"）：当成 now=
  if (!hit && /^[A-Za-z][A-Za-z0-9_-]*$/.test(s)) map.now = s;
  return map;
}

/** 没被替换掉的占位符（如 "{logTopic}"）一律当空 */
function unsubstituted(v) {
  var s = String(v === undefined || v === null ? "" : v).trim();
  if (s.length > 1 && (s.charAt(0) === '"' || s.charAt(0) === "'") && s.charAt(s.length - 1) === s.charAt(0)) {
    s = s.slice(1, -1).trim();
  }
  return /^\{[\w.\-]+\}$/.test(s) ? "" : s;
}

function argOf(name, def) {
  var v;
  try {
    var t = argTable();
    if (t) v = t[name];
  } catch (e) {}
  var s = unsubstituted(v);
  return s !== "" ? s : def;
}

var UPLOAD = argOf("uploadLog", "true") === "true";
// v9.4：定时任务要不要顺带领「活跃任务」奖励（默认关：领的时候会多打十来个接口）
// v9.8：打开后连「上报查看类任务」一起做 —— 不开浏览器也能把小程序这边的活跃分攒够（100 分 = 第 3 个宝箱）
var AUTO_TASKS = argOf("autoTasks", "false") === "true";
// v9.1：手动签到时网页要尽快出结果，上报只等 2.5s；没推上去的话脏标记还在，下次抓包会补推
var UPLOAD_BUDGET = 9000;
var UPLOAD_NOTE = ""; // 上报失败时附加到通知里的提示
// v9.11「补领」：只有插件里那两条补领 cron 会把这个参数带进来（"true" / "false"）。
// "" = 不是补领那一跑（09:00 的定时签到、手动页都不带它）。
// 开关关掉时值是 "false" —— 那时这两条 cron 直接走开，连一个请求都不发。
var CATCHUP = argOf("catchup", "");

/* ───────────── v9.11：登录态是不是「今天刷出来的」 ─────────────
   09-28 实测：读接口对旧会话宽容（状态查询、活跃任务列表照样给），
   但发奖接口（Index/taskLotteryNow / 积分宝箱）只认当天在小程序里刷出的会话，
   旧会话一律回 4414「系统繁忙，请重试」——所以会话不是今天的就别去领，也不要去重试。 */
function dayOf(sec) {
  var d = new Date((sec || Math.floor(Date.now() / 1000)) * 1000);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
/** 票据是什么时候刷出来的：sniff 存的 expire 就是「有效至」= 刷出来那一刻 + 24h */
function authIssued(a) {
  var e = parseInt((a || {}).expire, 10);
  return e > 0 ? e - 86400 : 0;
}
/** 会话不是今天刷的 → true（发奖接口不会认）*/
function authStale(a, nowSec) {
  var t = authIssued(a);
  if (!t) return false; // 老数据里没有票据时间：不误伤，照旧试一次
  if (nowSec >= t && nowSec - t < 6 * 3600) return false; // 6 小时内刷出来的，跨天也算新鲜
  return dayOf(t) !== dayOf(nowSec);
}
function readDay() {
  try {
    return JSON.parse($persistentStore.read(DAY_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}
function writeDay(o) {
  try {
    $persistentStore.write(JSON.stringify(o), DAY_KEY);
  } catch (e) {}
}

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

// v9.9：通知里只留「一眼能看懂的结论行」。逐项细节（每个任务的返回、宝箱原文、对照行、上报明细）
// 全部留在频道日志和手动页里 —— 用户说过「loon 上面那个详细太多了，一长片」。
// v9.12：通知里**不再**写「还没做完的 N 项」这类需要你自己动手的行（用户：「通知里面不要写一大堆什么需要手动的」），
// 只留「自动领到了什么 / 什么没领到（+原因）」—— 手动清单只写在频道日志和手动页里。
var NOTIFY_KEEP = /^(签到[:：]|签到状态[:：]|福利站|已领取「|领取「|活跃任务|已领任务奖励|已开「|开「|今日活跃积分|活跃自检|服务端在限流|上报任务时被限流|领任务奖励时被限流|(\d+ )?项领取都被服务端挡回)/;
function briefLines(lines) {
  // 先把所有开箱行收拢成一行（通知里没必要一箱一行）
  var boxes = [];
  var i;
  for (i = 0; i < lines.length; i++) {
    var mb = /^已开「(\d+)积分宝箱」/.exec(String(lines[i]));
    if (mb) boxes.push(mb[1]);
  }
  var out = [];
  var boxDone = false;
  for (i = 0; i < lines.length; i++) {
    var s = String(lines[i]);
    if (/^已开「\d+积分宝箱」/.test(s)) {
      if (!boxDone) {
        boxDone = true;
        if (boxes.length) out.push("已开积分宝箱 " + boxes.length + " 个（" + boxes.join(" / ") + "）");
      }
      continue;
    }
    if (/^今日活跃积分/.test(s)) continue; // 自检行里已经有分数了
    if (/^活跃任务：这会儿没有能直接领的/.test(s)) continue; // 没可领的就不占一行
    if (/^活跃任务：今天已经领满了/.test(s)) continue; // v9.11：补领那两跑领满就不占一行
    if (/^还没做完的/.test(s)) continue; // v9.12：要你自己动手的清单不进通知
    if (NOTIFY_KEEP.test(s)) out.push(s);
  }
  return out;
}

function notify(title, sub, content) {
  // v9.12：通知不再挂 openUrl（用户：「通知点开不要去跳转」）——
  // 想看日志就点 Loon「脚本」列表里的「火影·看日志」；完整日志照旧推到频道里。
  $notification.post(title, sub, String(content) + UPLOAD_NOTE);
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

/* ───────────── 活跃任务（v9.4） ───────────── */

// 2026-09-26 抓包实测的「福利站 · 活跃任务」结构（Welfare/getTodayActInfo）：
//   jData.integralTaskList = [{name, pointNum, target, weight, index, leftQual, curDone}, …]
//     index 是任务的英文键：readArticle / like / dynamicArticle / goldHelper / scrollRecord /
//     actCalendar / wallpaper / ninja / guestInfo / sign / duel / active / phone；leftQual=1 表示还能领
//   jData.task = 三个「积分宝箱」[{name, target:40/60/100, curDone, leftQual, index:0/1/2}, …]
//   jData.actIntegral = 今日积分（宝箱就看这个：攒到 target 才能开对应的宝箱）
//
// 四个接口的分工（v9.6 按 09-25 / 09-26 的真实抓包厘清）：
//   Welfare/getTodayActInfo     拉面板：任务进度 + 积分宝箱 + 今日积分
//   Welfare/getTodayActGiftNow  开**积分宝箱**：index=0/1/2（门槛 40 / 60 / 100，看 actIntegral）
//                               —— 拿任务键去调它，服务端回 4036「活跃度未达成不能领取奖励」
//   Index/taskLotteryNow        领**任务奖励**：&index=<任务键>，一次只领一项
//                               09-27 12:16 用户在小程序里手点「今日签到」实捕：
//                               index=sign → iRet=0「领取任务奖励成功」，今日积分 0→10；
//                               不带 index 回的是 1228「index参数范围不对」（不是 1226）
//   Index/taskDone              上报「查看类」任务：index=<任务键>
// 请求形状都沿用礼包那一套（area/platId/partition/roleId/g_tk）。
var TASK_INFO_ROUTE = "Welfare/getTodayActInfo";
var TASK_BOX_ROUTE = "Welfare/getTodayActGiftNow"; // 积分宝箱
var TASK_CLAIM_ROUTE = "Index/taskLotteryNow"; // 领任务奖励
var TASK_DONE_ROUTE = "Index/taskDone";
// 只靠「打开一下某个页面」就能完成的任务；决斗场 / 游戏内活跃度 / 绑手机号这类不做。
// v9.7：去掉 readArticle / like —— 服务端对这两个 index 回 1226「index参数范围不对」，
// 它们只能在小程序里真的去读帖子 / 点赞（其余 7 个都实测能被 taskDone 认掉）。
// 注：v9.7 之前「上报查看类」只在手动页做；v9.8 起定时任务打开 autoTasks 也会做。
var VIEW_TASK_KEYS = [
  "dynamicArticle", "goldHelper", "scrollRecord",
  "actCalendar", "wallpaper", "ninja", "guestInfo",
];
var TASK_GAP = 250; // 连着打一串接口时留点间隔，别像脚本扫站
// v9.10：09:00 准点那一跑，服务端会把「上报 / 领奖励」成批回成 1103「手速太快了，请稍后再试」
// 或 4414「系统繁忙，请重试」（09-28 09:00 实测：7 项领取全被 4414 挡回，今日积分停在 0）。
// 这两个码都是「等一下再来」，跟脚本、跟流程号都没关系，所以——
var BUSY_TRIES = 3;          // 同一项最多试几次（含第一次）
var BUSY_GAP_MIN = 900;      // 单项重试前歇 0.9~1.8s（接着打还是 1103）
var BUSY_GAP_RAND = 900;
var BUSY_ROUND_WAIT = 4000;  // 一整批都在忙：歇 4s 整批再来一轮
var BUSY_ROUNDS = 2;         // 最多几轮（两轮还忙就照实写出来，不再硬刚）
// v9.8：3 个积分宝箱的门槛是 40 / 60 / 100 —— 100 就是「小程序这边能做的全做完」该到的分。
var BOX_FULL = 100;
// 这几项服务端不认脚本代发（实测 readArticle/like 回 1226，duel/phone 要真打 / 真收短信，
// active 是游戏内活跃度），自检时把它们标成「只能你自己做」，不算在脚本欠账里。
var USER_ONLY_KEYS = ["readArticle", "like", "duel", "phone", "active"];
function userOnly(it) {
  return USER_ONLY_KEYS.indexOf(String((it || {}).index || "")) >= 0;
}
function sumPoints(list) {
  return (list || []).reduce(function (a, it) { return a + Number((it || {}).pointNum || 0); }, 0);
}

function taskDone(it) {
  it = it || {};
  return Number(it.curDone || 0) >= Number(it.target || 1);
}
/** 可领 = 还能领（leftQual=1）且进度已够 */
function taskClaimable(it) {
  return !!it && String(it.leftQual) === "1" && taskDone(it);
}
/** 积分宝箱能不能开：要么自己的进度够了，要么今日积分已经过了门槛（curDone 有时是 0，得看 actIntegral） */
function boxReady(bx, integral) {
  if (!bx || String(bx.leftQual) !== "1") return false;
  var target = Number(bx.target || 0);
  if (!target) return false;
  return Number(bx.curDone || 0) >= target || Number(integral || 0) >= target;
}
/** 领到手的东西（服务端给 awardList 时把礼包名列出来） */
function awardTail(j) {
  var list =
    j && j.jData && Object.prototype.toString.call(j.jData.awardList) === "[object Array]"
      ? j.jData.awardList
      : [];
  var names = list
    .map(function (a) { return String(a.sPackageName || ""); })
    .filter(function (s) { return !!s; });
  return names.length ? "（" + names.join(" + ") + "）" : "";
}

/** 拉一次活跃任务面板 */
async function fetchTasks(auth, manual, raws) {
  var r = await req("活跃任务列表", welfareUrl(TASK_INFO_ROUTE), roleBody(auth, ""), auth.cookie);
  if (manual) raws.push(["活跃任务列表 " + TASK_INFO_ROUTE, r.text]);
  var j = jparse(r.text);
  var d = j && j.jData ? j.jData : {};
  return {
    json: j,
    err: topErr(j),
    tasks: Object.prototype.toString.call(d.integralTaskList) === "[object Array]" ? d.integralTaskList : [],
    boxes: Object.prototype.toString.call(d.task) === "[object Array]" ? d.task : [],
    integral: d.actIntegral,
    ico: d.icoIntegral, // 兑换积分（只是拿来对照：领/开奖时它有没有被扣）
  };
}

function plainWhy(j, e) {
  if (e) return "顶层 ret=" + e.ret + (e.msg ? "｜" + e.msg : "");
  return unesc(j && j.sMsg) || "未知原因";
}

/**
 * 一次活跃任务的完整处理：
 *   ① 上报「查看类」任务（v9.8：手动页默认做，定时任务打开 autoTasks 也做）→ ② 领可领的任务奖励 → ③ 开积分宝箱 → ④ 回报今日积分变化
 * 每一步都只信服务端的回答（iRet=0 才算成），剩下的照原话写出来。
 */
async function taskPass(auth, opts) {
  opts = opts || {};
  var manual = !!opts.manual;
  var raws = opts.raws || [];
  var lines = [];
  var stopped = false; // 碰到限流就收手，别越打越慢

  var t = await fetchTasks(auth, manual, raws);
  if (t.err) {
    lines.push("活跃任务：服务端顶层挡回（ret=" + t.err.ret + (t.err.msg ? "｜" + t.err.msg : "") + "）" +
      (isThrottle(t.err) ? "，过一阵子再试" : ""));
    return { lines: lines, integral: null };
  }
  if (!t.json || Number(t.json.iRet) !== 0) {
    lines.push("活跃任务：列表没拿到（" + (unesc(t.json && t.json.sMsg) || "返回不是 JSON") + "）");
    return { lines: lines, integral: null };
  }
  var before = t.integral;
  if (manual && t.tasks.length) {
    lines.push(
      "任务进度：" +
        t.tasks.map(function (it) {
          return String(it.name || it.index || "") + " " + fmtRet(it.curDone) + "/" + fmtRet(it.target) +
            (taskClaimable(it) ? " ✅能领" : "");
        }).join("　")
    );
  }
  logAppend([
    "[" + stamp() + "] 活跃任务：共 " + t.tasks.length + " 项，可领 " +
      t.tasks.filter(taskClaimable).length + " 项，今日积分 " + fmtRet(before),
  ]);

  // ① 「查看类」任务上报（v9.8：定时任务打开 autoTasks 也会做 —— 用户要的是「小程序这边能做的自动做满」，
  //    不开那个参数就还是只有手动页做）
  var sentN = 0;
  var sentOk = 0;
  var busyRep = []; // v9.10：重试完服务端还在说忙的那几项（名字）
  if (opts.report) {
    var todo = t.tasks.filter(function (it) {
      return VIEW_TASK_KEYS.indexOf(String(it.index || "")) >= 0 && !taskDone(it);
    });
    for (var i = 0; i < todo.length && !stopped; i++) {
      var key = String(todo[i].index || "");
      var rname = String(todo[i].name || key);
      var dr;
      var dj;
      var de;
      var rtries = 0;
      // v9.10：手速太快 / 系统繁忙就歇一下重试同一项（最多 BUSY_TRIES 次）
      while (true) {
        dr = await req("上报任务 " + key, welfareUrl(TASK_DONE_ROUTE), roleBody(auth, "&index=" + key), auth.cookie);
        dj = jparse(dr.text);
        de = topErr(dj);
        rtries++;
        if (dj && Number(dj.iRet) === 0) break;
        if (!stopped && rtries < BUSY_TRIES && busyCode(dj, de)) {
          logAppend([
            "[" + stamp() + "] 上报「" + key + "」服务端说忙（" + busyHint(dj, de) + "），歇一下再试（第 " + (rtries + 1) + " 次）",
          ]);
          await sleep(busyWait());
          continue;
        }
        break;
      }
      if (manual) raws.push(["上报任务 " + TASK_DONE_ROUTE + " index=" + key, dr.text]);
      sentN++;
      if (dj && Number(dj.iRet) === 0) sentOk++;
      else if (busyCode(dj, de)) {
        busyRep.push(rname); // 重试完还在忙：不谎报，最后汇总一行
      } else if (de && isThrottle(de)) {
        stopped = true;
        lines.push("上报任务时被限流了（" + de.msg + "），剩下的先不试");
      } else {
        lines.push(
          "上报「" + rname + "」没通过：" + plainWhy(dj, de) +
            (dj && Number(dj.iRet) === 1226 ? "（这个 index 服务端不收，跳过）" : "")
        );
      }
      await sleep(TASK_GAP);
    }
    if (busyRep.length) {
      lines.push("服务端在限流（手速太快）：" + busyRep.length + " 项上报没通过，过一会儿再来一次就行");
      logAppend([
        "[" + stamp() + "] 活跃任务：上报 " + busyRep.join("、") + " 重试后服务端仍在说忙",
      ]);
    }
    if (sentN) {
      logAppend(["[" + stamp() + "] 活跃任务：上报 " + sentN + " 项，服务端认了 " + sentOk + " 项"]);
      if (sentOk) t = await fetchTasks(auth, manual, raws); // 重新拉一份，看看有没有变「可领」
    }
  }

  // ② 领任务奖励 —— v9.7：逐项带任务键领（这是这版唯一的功能改动，也是任务一直没领到的根因）
  //    09-27 12:16 用户在小程序里手点「今日签到」，抓到真实形状：
  //      Index/taskLotteryNow&index=sign → iRet=0「领取任务奖励成功」，今日积分 0 → 10
  //    而不带 index 回的是 1228「index参数范围不对」（不是 1226）—— 所以 v9.6 那个
  //    「先不带、只有回 1226 才带上 index 再试」的判断永远走不到带 index 那一步。
  var gotN = 0;
  var gotPoints = 0;
  var leftN = 0;
  var cl = t.tasks.filter(taskClaimable);
  if (!stopped && cl.length) {
    if (manual) {
      lines.push(
        "可领（服务端 index）：" +
          cl
            .map(function (it) {
              return String(it.index || "") + " +" + Number(it.pointNum || 0);
            })
            .join("　")
      );
    }
    // 一项一项领：index = 面板里的任务键（服务端一次只认一项，成功一项就加它自己的 pointNum）
    var fail = {};
    // v9.10：一整批都在忙（4414 / 1103）时，歇一下把没领到的整批再来一轮（最多 BUSY_ROUNDS 轮）
    var pending = cl.slice();
    for (var round = 0; round < BUSY_ROUNDS && pending.length && !stopped; round++) {
      var again = [];
      for (var k = 0; k < pending.length && !stopped; k++) {
        var it = pending[k];
        var idx = String(it.index || "");
        if (!idx) continue;
        var nm = String(it.name || idx);
        var lr = await req("领任务奖励 " + idx, welfareUrl(TASK_CLAIM_ROUTE), roleBody(auth, "&index=" + idx), auth.cookie);
        if (manual) raws.push(["领任务奖励 " + TASK_CLAIM_ROUTE + " index=" + idx, lr.text]);
        var lj = jparse(lr.text);
        var le = topErr(lj);
        var lret = lj ? Number(lj.iRet) : -1;
        if (lj && lret === 0) {
          gotN++;
          gotPoints += Number(it.pointNum || 0);
          lines.push("已领「" + nm + "」+" + Number(it.pointNum || 0) + " 活跃积分" + awardTail(lj));
        } else if (busyCode(lj, le)) {
          again.push(it); // 忙 → 放回去，等下一轮（不当成失败，也不谎报）
        } else if (le && isThrottle(le)) {
          stopped = true;
          lines.push("领任务奖励时被限流了（" + le.msg + "），剩下的先不试");
        } else {
          // 同一种失败只印一行：好几项都回 4036 时，页面不该刷一串一模一样的话
          var fk = String(lret);
          if (!fail[fk]) fail[fk] = { n: 0, msg: plainWhy(lj, le), names: [] };
          fail[fk].n++;
          fail[fk].names.push(nm);
        }
        await sleep(TASK_GAP);
      }
      if (again.length && round + 1 < BUSY_ROUNDS && !stopped) {
        logAppend([
          "[" + stamp() + "] 活跃任务：领奖励时服务端说忙，" + again.length + " 项歇一下再来一轮",
        ]);
        await sleep(BUSY_ROUND_WAIT);
      }
      pending = stopped ? [] : again;
    }
    if (pending.length) {
      lines.push("服务端在限流（系统繁忙）：" + pending.length + " 项奖励没领到，过一会儿再来一次就行");
      logAppend([
        "[" + stamp() + "] 活跃任务：" + pending.map(function (x) { return String(x.index || ""); }).join(",") +
          " 重试后服务端仍在说忙",
      ]);
    }

    if (gotN) {
      lines.push("已领任务奖励：" + gotN + " 项，合计 +" + gotPoints + " 活跃积分");
      logAppend(["[" + stamp() + "] 活跃任务：领了 " + gotN + " 项，合计 +" + gotPoints + " 积分"]);
      t = await fetchTasks(auth, manual, raws); // 积分到账了，宝箱门槛要按新的算
    }

    for (var f in fail) {
      var fo = fail[f];
      if (fo.n === 1) lines.push("领取「" + fo.names[0] + "」失败：" + fo.msg);
      else lines.push(fo.n + " 项领取都被服务端挡回：" + fo.msg);
    }
  } else if (!stopped) {
    lines.push("活跃任务：这会儿没有能直接领的（先做掉「去完成」的，或用本页的上报试试）");
  }

  // ③ 积分宝箱（今日积分过了 40 / 60 / 100 才能开）—— 这才是 Welfare/getTodayActGiftNow 的用处
  var boxN = 0;
  var busyBox = 0;
  if (!stopped) {
    var boxes = t.boxes.filter(function (bx) { return boxReady(bx, t.integral); });
    for (var b = 0; b < boxes.length && !stopped; b++) {
      var bx = boxes[b];
      var bi = String(bx.index);
      var br;
      var bj;
      var be;
      var bret = -1;
      var btries = 0;
      // v9.10：开箱撞上「忙」也歇一下重试（2026 / 4150 是另一种意思，不在这里重试）
      while (true) {
        br = await req("积分宝箱 " + bi, welfareUrl(TASK_BOX_ROUTE), roleBody(auth, "&index=" + bi), auth.cookie);
        bj = jparse(br.text);
        be = topErr(bj);
        bret = bj ? Number(bj.iRet) : -1;
        btries++;
        if ((bj && bret === 0) || bret === 2026 || bret === 4150) break;
        if (!stopped && btries < BUSY_TRIES && busyCode(bj, be)) {
          logAppend([
            "[" + stamp() + "] 开「" + String(bx.name || "积分宝箱") + "」服务端说忙（" + busyHint(bj, be) + "），歇一下再试",
          ]);
          await sleep(busyWait());
          continue;
        }
        break;
      }
      if (manual) raws.push(["积分宝箱 " + TASK_BOX_ROUTE + " index=" + bi, br.text]);
      if (bj && bret === 0) {
        boxN++;
        lines.push("已开「" + String(bx.name || "积分宝箱") + "」" + awardTail(bj));
      } else if (bret === 2026 || bret === 4150) {
        leftN++; // 已领过 / 积分还不够
      } else if (be && isThrottle(be)) {
        stopped = true;
      } else if (busyCode(bj, be)) {
        busyBox++;
      } else {
        lines.push("开「" + String(bx.name || "积分宝箱") + "」没成：" + plainWhy(bj, be));
      }
      await sleep(TASK_GAP);
    }
    if (boxN) logAppend(["[" + stamp() + "] 活跃任务：开了 " + boxN + " 个积分宝箱"]);
    if (busyBox) {
      lines.push("服务端在限流（系统繁忙）：" + busyBox + " 个宝箱没开成，过一会儿再来一次就行");
      logAppend(["[" + stamp() + "] 活跃任务：" + busyBox + " 个宝箱重试后服务端仍在说忙"]);
    }
  }

  // ④ 回报今日积分的变化（只是给日志看，不影响结果）
  if (sentOk || gotN) {
    lines.push(
      "今日活跃积分 " + fmtRet(before) + " → " + fmtRet(t.integral) +
        "（兑换积分 " + fmtRet(t.ico) + "）" +
        (boxN ? "（开宝箱的还没算进去）" : "")
    );
  } else if (leftN) {
    lines.push("活跃任务：另有 " + leftN + " 项已领过或不可领");
  }
  // ⑤ v9.8 自检：小程序这边能做的，到底够不够开满 3 个积分宝箱（门槛 100 分）
  //    用户的要求就是「小程序里能操作的保证满 100」，所以这里直接给出 X/100 + 还差什么。
  var nowI = Number(t.integral || 0);
  var undone = t.tasks.filter(function (it) { return !taskDone(it); });
  var mine = undone.filter(function (it) { return !userOnly(it); });
  var chk = "活跃自检：" + fmtRet(nowI) + "/" + BOX_FULL;
  if (nowI >= BOX_FULL) chk += " ✅ 够开满 3 个积分宝箱";
  else chk += " ⚠️ 还差 " + (BOX_FULL - nowI) + " 分" + (mine.length ? "（脚本还能补 " + sumPoints(mine) + " 分）" : "");
  lines.push(chk);
  if (undone.length) {
    lines.push(
      "还没做完的 " + undone.length + " 项：" +
        undone.map(function (it) {
          var k = String(it.index || "");
          return String(it.name || k) + " +" + Number(it.pointNum || 0) + (userOnly(it) ? "（只能你自己做）" : "（脚本能代做）");
        }).join("　")
    );
  }
  logAppend([
    "[" + stamp() + "] 活跃自检：今日积分 " + fmtRet(nowI) + "/" + BOX_FULL +
      (undone.length
        ? "，还没做完 " + undone.length + " 项（" + undone.map(function (it) { return String(it.index || ""); }).join(",") + "）"
        : "，全部做完"),
  ]);
  // v9.11：got / boxes 是给 main() 判断「这一跑到底领到东西没」（补领只在领到时才通知）
  return { lines: lines, integral: nowI, full: nowI >= BOX_FULL, got: gotN, boxes: boxN };
}

/* ───────────── 主流程 ───────────── */

async function main(opts) {
  opts = opts || {};
  var manual = !!opts.manual; // 手动模式：结果要带回去显示在网页上
  var force = !!opts.force; // 手动 + ?force=1：今天签过也再发一次签到流程（测试用）
  var tasks = !!opts.tasks; // v9.4：顺带处理「活跃任务」（手动页默认做；定时任务看参数 autoTasks）
  var report = !!opts.report; // 是否上报「查看类」任务（v9.8）
  var t0 = Date.now();
  var nowSec = Math.floor(Date.now() / 1000);
  var today = dayOf(nowSec);
  var day = readDay();
  var dayFull = day.d === today && !!day.full; // v9.11：今天已经领满了（补领那两跑据此直接走开）
  var catchRun = !manual && CATCHUP === "true"; // v9.11：这一跑是不是「补领」（只在真领到东西时才通知）
  var did = false; // 这次有没有真领到 / 真签上（省得补领发一堆白通知）
  var auth = readAuth();
  var stale = authStale(auth, nowSec); // 会话不是今天刷的（写接口不会认，见文件头 v9.11）
  var raws = []; // 手动模式下要带回去的服务端原文
  var lines = [];
  var title = manual ? (tasks ? "火影签到 · 手动 · 活跃任务" : "火影签到 · 手动") : "火影签到";
  if (manual) UPLOAD_BUDGET = 2500;

  logAppend([
    "",
    "[" + stamp() + "] ===== " + (manual ? "手动签到" + (tasks ? " + 活跃任务" : "") : "自动签到") +
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
      did = true;
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
          did = true;
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

  // 4. 活跃任务（v9.4）—— 手动页默认做；定时任务要参数 autoTasks 打开
  if (tasks && !throttled && auth.roleId) {
    var issSec = authIssued(auth);
    if (dayFull) {
      // v9.11：今天已经领满过（领满那次会写本机标记）——补领那两跑直接走开，一个接口都不打
      lines.push("活跃任务：今天已经领满了（" + fmtRet(day.pts) + "/" + BOX_FULL + "），不用再补");
      logAppend(["[" + stamp() + "] 活跃任务：今天已领满，跳过"]);
    } else if (stale) {
      // v9.11：会话不是今天刷的 → 发奖接口只会回 4414，不去白挨（真因见文件头）
      lines.push(
        "活跃任务：没领 —— 登录态不是今天的（" +
          (issSec ? stamp(new Date(issSec * 1000)) + " 刷的" : "时间未知") +
          "），打开一次微信小程序就自动补领"
      );
      logAppend([
        "[" + stamp() + "] 活跃任务：登录态非当天（" +
          (issSec ? stamp(new Date(issSec * 1000)) : "未知") + " 刷出），跳过领奖",
      ]);
      // 标记「今天确实没领满」：抓包脚本抓到今天的票据时会据此发一条「点我补领」的通知
      writeDay({ d: today, full: false, pts: null });
    } else {
      var tp = await taskPass(auth, { manual: manual, report: report, raws: raws });
      for (var q = 0; q < (tp.lines || []).length; q++) lines.push(tp.lines[q]);
      if (tp.got || tp.boxes) did = true;
      if (tp.integral !== null && tp.integral !== undefined) {
        writeDay({ d: today, full: !!tp.full, pts: Number(tp.integral) });
      }
    }
  }

  // 5. 汇总
  var head;
  if (st) {
    head =
      (st.todaySigned ? "今日已签到 ✅" : "今日未签到 ❌") +
      "　本周 " + st.weekDays + "/7 · 本月 " + st.monthDays + " 天";
  } else {
    head = "签到状态未知";
  }
  // v9.8：把「小程序这边能操作到的活跃分」直接放进标题，通知里一眼就知道够不够 100
  if (tasks && tp && tp.integral !== null && tp.integral !== undefined) {
    head +=
      "　｜　活跃 " + fmtRet(tp.integral) + "/" + BOX_FULL +
      (tp.full ? " ✅" : "（还差 " + (BOX_FULL - Number(tp.integral)) + " 分）");
  } else if (tasks && dayFull) {
    head += "　｜　活跃 " + fmtRet(day.pts) + "/" + BOX_FULL + " ✅（今天已领满）";
  } else if (tasks && stale && !throttled) {
    head += "　｜　活跃待补领（登录态要刷新）";
  }

  logAppend([
    "[" + stamp() + "] 结果：" + head +
      (lines.length ? "｜" + lines.join(" ／ ") : ""),
    "[" + stamp() + "] ===== 结束，用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s =====",
  ]);

  await uploadLog("火影签到日志");

  // v9.9：正文只放结论行；详情（每项任务的返回原文、宝箱原文、对照行）在频道日志和手动页里
  var brief = briefLines(lines);
  if (!catchRun || did) {
    notify(
      title,
      head,
      (brief.length ? brief.join("\n") : lines.length ? "详情见频道日志" : "无需处理")
    );
  } else {
    // v9.11：补领那两跑如果什么都没领到（今天已领满 / 会话还不是今天的），就不打扰
    logAppend(["[" + stamp() + "] 补领：这一跑没有新东西，不通知 —— " + head]);
  }

  return { head: head, lines: lines, raws: raws };
}

/* ───────────── 入口 ───────────── */

// v9.1：手动签到。插件里有一条 http-request 规则盯着这个地址，命中就不进真网络，直接返回一个假响应。
var MANUAL_RE = /^https?:\/\/ulinkact\.game\.qq\.com\/hyrz-sign-now(\?|$)/i;
// v9.4：同一个域名下再挂一条 —— 手动作「签到 + 领活跃任务」（后面加 ?report=0 就只领不「上报查看类任务」）
var TASK_RE = /^https?:\/\/ulinkact\.game\.qq\.com\/hyrz-task-now(\?|$)/i;
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
  if (!j || j.modRet) return null; // AMS：进了流程引擎，业务码看 modRet
  if (j.jData !== undefined) return null; // ulink 的正常形状：{"iRet":0,"sMsg":"ok","jData":{…}}
  var r = j.ret;
  if (r === undefined || r === null || r === "") return null; // 连 ret 都没有：不是顶层挡回
  if (String(r) === "0") return null;
  return { ret: fmtRet(r), msg: unesc(j.msg || j.sMsg || "").slice(0, 60) };
}

// 服务端的限流/防刷话术：跟脚本、跟流程号都没关系，过一阵子就好
function isThrottle(t) {
  return !!t && /访问(数|人数)过[多频]|人数过多|稍后再试|too many|频繁|系统繁忙/i.test(t.msg || "");
}

/**
 * v9.10 服务端的「忙」码：1103 手速太快 / 4414 系统繁忙 —— 都是「等一下再试」，
 * 不是业务结论（不像 1226/4036/4411 那种「就是这样」）。这两种形状里都带 jData，
 * topErr() 认不出来（它只在顶层被挡回时给结果），所以这里自己看 iRet。
 * 注意别拿 sMsg 去猜：1226 的文案里也有「系统繁忙」，但它不是忙码。
 */
function busyCode(j, e) {
  if (e && isThrottle(e)) return true;
  if (!j) return false;
  var r = parseInt(j.iRet, 10);
  return r === 1103 || r === 4414;
}
function busyWait() {
  return BUSY_GAP_MIN + Math.floor(Math.random() * BUSY_GAP_RAND);
}
function busyHint(j, e) {
  var s = (e && e.msg) || (j && unesc(j.sMsg)) || "服务端说忙";
  return String(s).slice(0, 30);
}

function throttleHint(t) {
  if (!t) return "";
  if (isThrottle(t)) return "→ 这是服务端的限流/防刷（跟脚本无关），过一阵子再试一次";
  if (String(t.ret) === "-1") return "→ 服务端这次没受理（多为限流/防刷），过一阵子再试一次";
  return "";
}

/** 把这次结果拼成一页纯文本，直接当网页内容返回 */
/* v9.6 诊断：频道一直没动静时，先看这两段 */

/** 单行截断（本地日志行可能很长） */
function clipLine(s, n) {
  s = String(s === null || s === undefined ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 「日志上报」状态一行：开关有没开、频道名有没填、这次推上去没有 */
function pushStatusLine() {
  var t = NTFY_TOPIC || "";
  var s =
    "日志上报：" + (UPLOAD ? "开" : "关") + "｜频道名：" +
    (t
      ? "已设（尾 " + t.slice(-6) + "）"
      : "没填（填插件参数 logTopic，或者打开一次 …?topic=频道名）");
  if (!UPLOAD) s += "｜上报开关关着，日志只在本机";
  else if (NTFY_TOPIC && UPLOAD_NOTE) s += "｜" + UPLOAD_NOTE.replace(/\s+/g, " ").replace(/^⚠️\s*/, "");
  else if (NTFY_TOPIC) s += "｜这次已经推给频道了";
  return s;
}

/**
 * 本机日志尾巴：把抓包/签到日志里跟小程序请求有关的那几行挑出来。
 * 频道没动静时，这是唯一能看到「小程序自己发了什么请求」的地方（本机存储，不会外传）。
 */
function logTail(n) {
  var all = [];
  try {
    all = logRead().split("\n");
  } catch (e) {}
  var keep = [];
  for (var i = 0; i < all.length; i++) {
    var l = String(all[i] || "").replace(/\s+$/, "");
    if (!l) continue;
    if (/→\s|←\s|抓到登录态|新流程|已知流程/.test(l)) keep.push(l);
  }
  if (!keep.length) return ["（本机还没抓到过小程序的请求 —— 打开一次小程序再看）"];
  keep = keep.slice(Math.max(0, keep.length - (n || 20)));
  return keep.map(function (l) {
    return redact(unesc(clipLine(l, 220)));
  });
}

/** ?topic=<频道名>：只写进本机存储（两个脚本共用），升级插件也不会丢 —— 永不进仓库 */
function saveTopicFromUrl(url) {
  var m = String(url || "").match(/[?&]topic=([^&]+)/);
  if (!m) return "";
  var v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch (e) {}
  v = String(v).trim();
  if (!v) return "";
  try {
    $persistentStore.write(v, TOPIC_KEY);
  } catch (e) {}
  return v;
}

function manualText(res, defTitle) {
  res = res || {};
  var out = [];
  out.push((defTitle || "火影签到 · 手动签到") + "（脚本 " + VERSION + "）");
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
  out.push("· " + pushStatusLine());
  var tail = logTail(20);
  out.push("");
  out.push("本机日志尾巴（抓包脚本记的最近 " + tail.length + " 行，用来对照小程序自己发了什么）：");
  for (var m = 0; m < tail.length; m++) out.push("  " + tail[m]);
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

// v9.12：手动页改成网页（页内自带三个按钮互相跳），不再是一长片纯文本
function replyHtml(body) {
  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: body,
    },
  });
}

/* ───────────── v9.12：插件里的「手动按钮」（generic 脚本 + 页内跳转） ─────────────
   Loon 的插件页只能放开关 / 下拉 / 输入框（官方语法就这三样，放不了按钮），
   所以「点一下就跑」的入口做成了 generic 类型的手动脚本（写在插件里，但要在 App 的
   「脚本」列表里手点，不会自己跑）：
     火影·手动签到  argument="now=sign"
     火影·手动补领  argument="now=task"
     火影·看日志    argument="now=log"
   点一下 → 就在 Loon 内的网页里出结果（$done({title, htmlMessage})），不跳浏览器、不用输网址；
   网页顶部三个按钮按 id 跳不同页面（sign / task / log），日志页再分 全部 / 签到 / 补领。
   注：这三条的 argument 是写死的字面量（不带插件参数占位符），所以这一跑用的是
   参数默认值 + 本机缓存的频道名（领礼包=开、上报=开、签到流程=默认 1083576）。 */
var PANEL_URL = "https://ulinkact.game.qq.com/hyrz-panel-now";
var PANEL_RE = /^https?:\/\/ulinkact\.game\.qq\.com\/hyrz-panel-now(\?|$)/i;
var PANEL_TITLE = {
  sign: "手动签到",
  task: "手动补领活跃奖励",
  log: "运行日志",
  logsign: "签到日志",
  logtask: "补领 / 活跃日志",
};

function panelId(v) {
  v = String(v || "").toLowerCase().trim();
  if (v === "sign") return "sign";
  if (v === "task" || v === "tasks") return "task";
  if (v === "logsign" || v === "log-sign" || v === "signlog") return "logsign";
  if (v === "logtask" || v === "log-task" || v === "tasklog") return "logtask";
  return "log";
}

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageHtml(title, sub, navHtml, inner) {
  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">" +
    "<title>" + esc(title) + "</title><style>" +
    "body{margin:0;padding:16px 14px 40px;font:15px/1.55 -apple-system,BlinkMacSystemFont,\u2018PingFang SC\u2019,sans-serif;background:#f2f2f7;color:#111;-webkit-text-size-adjust:100%}" +
    "h1{font-size:19px;margin:2px 0 4px}.sub{color:#8e8e93;font-size:12.5px;margin:0 0 12px}" +
    ".nav{display:flex;gap:8px;margin:0 0 12px}.nav a{flex:1;text-align:center;text-decoration:none;background:#fff;color:#0a84ff;padding:11px 4px;border-radius:12px;font-weight:600;font-size:13.5px}" +
    ".nav a.on{background:#0a84ff;color:#fff}" +
    ".card{background:#fff;border-radius:12px;padding:11px 13px;margin:0 0 10px}" +
    ".card h2{font-size:12.5px;margin:0 0 6px;color:#8e8e93;font-weight:600}" +
    "pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace}" +
    "@media(prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}.nav a,.card{background:#1c1c1e}.nav a.on{background:#0a84ff}}" +
    "</style></head><body><h1>" + esc(title) + "</h1><p class=\"sub\">" + esc(sub) + "</p>" + navHtml + inner + "</body></html>"
  );
}

function panelNav(id) {
  function a(k, label) {
    return '<a class="' + (k === id ? "on" : "") + '" href="' + PANEL_URL + "?id=" + k + '">' + label + "</a>";
  }
  return '<div class="nav">' + a("sign", "手动签到") + a("task", "手动补领") + a("log", "看日志") + "</div>";
}

function logNav(id) {
  function a(k, label) {
    return '<a class="' + (k === id ? "on" : "") + '" href="' + PANEL_URL + "?id=" + k + '">' + label + "</a>";
  }
  return '<div class="nav">' + a("log", "全部") + a("logsign", "只看签到") + a("logtask", "只看补领") + "</div>";
}

function card(title, inner) {
  return '<div class="card">' + (title ? "<h2>" + esc(title) + "</h2>" : "") + inner + "</div>";
}

function preHtml(lines) {
  return "<pre>" + esc((lines || []).join("\n")) + "</pre>";
}

/** 本机日志（最近 n 行，脱敏 + 截断） */
function localLog(n) {
  var all = [];
  try {
    all = logRead().split("\n");
  } catch (e) {}
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var l = String(all[i] || "").replace(/\s+$/, "");
    if (l) out.push(redact(unesc(clipLine(l, 300))));
  }
  return out.slice(Math.max(0, out.length - (n || 60)));
}

/** 从自己的 ntfy 频道拉最近 48h 的日志（只在本机发起；频道名只存在本机） */
function fetchChannelLog(cb) {
  if (!NTFY_TOPIC) {
    cb([], "还没设频道名（插件参数 logTopic），频道日志看不了 —— 下面是本机日志。");
    return;
  }
  var settled = false;
  function done(entries, note) {
    if (settled) return;
    settled = true;
    cb(entries, note || "");
  }
  setTimeout(function () {
    done([], "拉频道日志超时 —— 下面是本机日志。");
  }, 9000); // 兜底：网络卡住也不能把页面挂死
  try {
    $httpClient.get(
    {
      url: NTFY_PUBLISH + NTFY_TOPIC + "/json?poll=1&since=48h",
      timeout: 8000,
      headers: { Accept: "application/x-ndjson" },
    },
    function (err, resp, data) {
      var st = resp ? Number(resp.status) : 0;
      if (err || (st && (st < 200 || st >= 400)) || !data) {
        done([], "拉频道日志失败（" + (err || "HTTP " + st) + "）—— 下面是本机日志。");
        return;
      }
      var entries = [];
      var lines = String(data).split("\n");
      for (var i = 0; i < lines.length; i++) {
        var l = String(lines[i] || "").trim();
        if (!l) continue;
        var m = jparse(l);
        if (!m || (m.event && m.event !== "message")) continue;
        entries.push({
          when: m.time ? stamp(new Date(Number(m.time) * 1000)) : "",
          title: unesc(String(m.title || "日志")),
          body: unesc(String(m.message || "")),
        });
      }
      entries.reverse(); // 新的在上面
      done(entries, "");
    }
    );
  } catch (e) {
    // 万一这个 Loon 版本没有 $httpClient.get，也不能把手动页搞白屏
    done([], "拉频道日志不可用（" + String(e) + "）—— 下面是本机日志。");
  }
}

function logEntriesHtml(entries, id, note) {
  var out = note ? card("提示", preHtml([note])) : "";
  var keep = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var text = e.title + "\n" + e.body;
    if (id === "logsign" && !/签到/.test(text)) continue;
    if (id === "logtask" && !/补领|活跃/.test(text)) continue;
    keep.push(e);
  }
  if (!keep.length) {
    out += card("频道日志", preHtml(["（这 48 小时里没有匹配的日志）"]));
  } else {
    var n = Math.min(keep.length, 8);
    for (var j = 0; j < n; j++) {
      var body = String(keep[j].body || "").split("\n").slice(0, 45);
      var clean = [];
      for (var k = 0; k < body.length; k++) clean.push(clipLine(redact(body[k]), 300));
      out += card((keep[j].when ? keep[j].when + " ｜ " : "") + keep[j].title, preHtml(clean));
    }
    if (keep.length > n) out += card("", preHtml(["（只列最近 " + n + " 条，共 " + keep.length + " 条）"]));
  }
  out += card("本机日志尾巴", preHtml(localLog(30)));
  return out;
}

function resultHtml(res) {
  res = res || {};
  var out = card("结果", preHtml([String(res.head || "（无结果）")]));
  var ls = res.lines || [];
  if (ls.length) out += card("明细", preHtml(ls));
  var raws = res.raws || [];
  if (raws.length) {
    var rl = [];
    for (var i = 0; i < raws.length; i++) {
      rl.push("[" + raws[i][0] + "] " + redact(unesc(String(raws[i][1]))).replace(/\s+/g, " ").slice(0, 300));
    }
    out += card("服务端原文（已脱敏）", preHtml(rl));
  }
  out += card("上报状态", preHtml([pushStatusLine()]));
  out += card("本机日志尾巴", preHtml(localLog(30)));
  return out;
}

/** 一页 = 一次动作 + 结果（id 决定做什么：sign / task / log / logsign / logtask） */
function renderPanel(id, done) {
  id = panelId(id);
  var title = PANEL_TITLE[id] || "手动";
  var sub = "火影福利站 · 脚本 " + VERSION + " · " + stamp();
  if (id === "log" || id === "logsign" || id === "logtask") {
    fetchChannelLog(function (entries, note) {
      // 日志页上三主按钮也都留着（只是「看日志」高亮）+ 一排日志筛选
      done(pageHtml(title, sub, panelNav("log") + logNav(id), logEntriesHtml(entries, id, note)));
    });
    return;
  }
  var nav = panelNav(id);
  var opts = id === "task" ? { manual: true, tasks: true, report: true } : { manual: true };
  main(opts)
    .then(function (res) {
      done(pageHtml(title, sub, nav, resultHtml(res)));
    })
    .catch(function (e) {
      try {
        logAppend(["[" + stamp() + "] 手动页出错：" + String(e)]);
      } catch (e2) {}
      done(pageHtml(title, sub, nav, card("出错", preHtml([redact(String(e))]))));
    });
}

// 只在「被当成请求脚本调起来」时有值；定时任务里根本没有这个变量
var REQ_URL =
  typeof $request !== "undefined" && $request && $request.url ? String($request.url) : "";

// v9.12：没有 $request、又带着 now= 标记的，就是 Loon 里手点的那三条 generic 手动按钮
var NOW = REQ_URL ? "" : argOf("now", "");

if (!REQ_URL && NOW) {
  // —— 手动按钮（Loon 的「脚本」列表里点一下）：结果直接渲染在 Loon 内的网页里 ——
  renderPanel(NOW, function (html) {
    $done({ title: "火影福利站 · " + (PANEL_TITLE[panelId(NOW)] || "手动"), htmlMessage: html });
  });
} else if (REQ_URL && saveTopicFromUrl(REQ_URL)) {
  // —— 只存频道名：一次搞定，以后升级插件都不用再填（频道名只在本机，绝不进仓库） ——
  var T = String($persistentStore.read(TOPIC_KEY) || "");
  var tmsg =
    "频道名已存到本机（尾 " + T.slice(-6) + "，共 " + T.length + " 字）。\n\n" +
    "下一次运行就会把日志推到这儿 —— 以后升级插件也不用再填一遍。\n";
  if (NTFY_TOPIC && NTFY_TOPIC !== T) {
    tmsg += "\n⚠️ 插件参数 logTopic 里还填着别的频道（尾 " + NTFY_TOPIC.slice(-6) +
      "），插件参数优先；想用新存的这个，把参数清空就行。\n";
  }
  tmsg += "（现在打开一次 …/hyrz-task-now 就能看到日志推没推上去。）";
  reply(tmsg);
} else if (REQ_URL && PANEL_RE.test(REQ_URL)) {
  // —— v9.12：手动页里的「跳转按钮」：同一个地址换一个 id 就换一页 ——
  var PID = (String(REQ_URL).match(/[?&]id=([^&]*)/) || [])[1] || "log";
  try {
    PID = decodeURIComponent(PID);
  } catch (e) {}
  renderPanel(PID, function (html) {
    replyHtml(html);
  });
} else if (REQ_URL && MANUAL_RE.test(REQ_URL)) {
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
} else if (REQ_URL && TASK_RE.test(REQ_URL)) {
  // —— 手动「签到 + 领活跃任务」（浏览器里点一下） ——
  var REPORT = !/[?&]report=0(&|$)/.test(REQ_URL);
  main({ manual: true, tasks: true, report: REPORT })
    .then(function (res) {
      reply(manualText(res, "火影签到 · 手动签到 + 领活跃任务"));
    })
    .catch(function (e) {
      try {
        logAppend(["[" + stamp() + "] 手动领活跃任务出错：" + String(e)]);
      } catch (e2) {}
      reply("火影签到 · 手动领活跃任务出错：\n" + redact(String(e)));
    });
} else if (REQ_URL) {
  // 被当成请求脚本调起来了、但地址不匹配（插件的规则理论上不会让它发生）
  // —— 原样放行，绝不拖慢小程序自己的请求
  $done({});
} else if (CATCHUP === "false") {
  // v9.11：补领开关关掉了 —— 那两条 cron 只是挂着，直接走开（一个请求、一条通知都不发）
  logAppend(["[" + stamp() + "] 补领已关闭（插件参数 catchup），这次跳过"]);
  $done();
} else {
  main({ tasks: AUTO_TASKS, report: AUTO_TASKS })
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
