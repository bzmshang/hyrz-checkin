// Offline contract tests: the only HTTP implementation is the stub below.
"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.join(__dirname, ".."),
  source = fs.readFileSync(path.join(root, "hyrz-sign.js"), "utf8");
const TAG = {
  diag: "火影·只读诊断",
  sign: "火影·手动签到",
  daily: "火影·每日签到",
  log: "火影·看日志",
  fallback: "火影·定时补领-12",
  pending: "火影·待办检查",
  task: "火影·手动补领",
};
const now = Date.now(),
  ns = "hyrz_v916_",
  sentinel = "SYNTHETIC_PRIVATE_VALUE";
const auth = {
  scope: "test-generation",
  cookie: sentinel,
  openid: sentinel,
  gtk: sentinel,
  expire: Math.floor(now / 1000) + 86300,
  roleId: "1",
  area: "1",
  platId: "1",
  partition: "1",
};
const ok = (v) => ({ modRet: { iRet: 0, jData: { openid_jf_everyDay: v } } });
function store() {
  return { [ns + "auth"]: JSON.stringify(auth) };
}
function start({
  mode = "sign",
  arg = {},
  q = [],
  db = store(),
  badWrite = false,
  request = false,
  serve,
} = {}) {
  const calls = [],
    notes = [],
    unhandled = [];
  let completions = 0,
    done;
  const finished = new Promise((r) => (done = r));
  const timers = new Set();
  function st(fn, ms) {
    let h = setTimeout(
      () => {
        timers.delete(h);
        fn();
      },
      ms === 220 || ms === 250 ? 5 : ms,
    );
    timers.add(h);
    return h;
  }
  const ctx = {
    $argument: arg,
    $script: { name: TAG[mode] || mode },
    $persistentStore: {
      read: (k) => db[k],
      write: (v, k) => {
        if (badWrite) return false;
        db[k] = v;
        return true;
      },
    },
    $httpClient: {
      post: (o, cb) => {
        calls.push(o);
        const x = serve ? serve(o) : q.shift();
        if (!x) {
          unhandled.push(o.url);
          return cb("unexpected", { status: 0 }, "");
        }
        const err = x.err || null,
          st = x.status ?? 200;
        cb(err, { status: st }, x.body ?? JSON.stringify(x.json ?? x));
      },
    },
    $notification: { post: (...n) => notes.push(n) },
    setTimeout: st,
    clearTimeout: (h) => {
      clearTimeout(h);
      timers.delete(h);
    },
    $done: (v) => {
      completions++;
      done(v);
    },
  };
  if (request) ctx.$request = { url: "https://example.invalid/" };
  vm.runInNewContext(source, ctx);
  return {
    calls,
    notes,
    db,
    p: finished.then((value) => {
      for (const h of timers) clearTimeout(h);
      assert.deepEqual(unhandled, []);
      assert.equal(completions, 1);
      return value;
    }),
  };
}
const flow = (c) => new URLSearchParams(c.body).get("iFlowId");
test("read-only: queries once, no upload/notification even if options enabled", async () => {
  const x = start({
    mode: "diag",
    arg: {
      claimGift: true,
      autoTasks: true,
      uploadLog: true,
      logTopic: "synthetic",
    },
    q: [ok("0")],
  });
  const v = await x.p;
  assert.deepEqual(x.calls.map(flow), ["1083547"]);
  assert.match(v.content, /今天未签/);
  assert.equal(x.notes.length, 0);
});
test("confirmed unsigned => one action, one independent verification with fixed TLS", async () => {
  const x = start({ q: [ok(0), { modRet: { iRet: 0 } }, ok("1")] });
  assert.match((await x.p).title, /复检确认/);
  assert.deepEqual(x.calls.map(flow), ["1083547", "1083576", "1083547"]);
  for (const c of x.calls) {
    assert.equal(c.insecure, false);
    assert.equal(c["auto-redirect"], false);
  }
});
test("already signed => no action", async () => {
  const x = start({ q: [ok(1)] });
  assert.match((await x.p).title, /今天已签/);
  assert.equal(x.calls.length, 1);
});
for (const [label, reply] of Object.entries({
  missing: { modRet: { iRet: 0, jData: {} } },
  unexpected: ok(2),
  html: { body: "<html>PRIVATE</html>" },
  nonzero: { modRet: { iRet: 903, jData: { openid_jf_everyDay: "0" } } },
  auth: { modRet: { iRet: "101" } },
  badHttp: { status: 503, json: ok(0) },
  busy: { status: 429 },
  timeout: { err: "mock timeout", status: 0 },
}))
  test("unknown or refused status blocks all writes: " + label, async () => {
    const x = start({ q: [reply], arg: { claimGift: true, autoTasks: true } });
    await x.p;
    assert.equal(x.calls.length, 1);
  });
test("failed verification is never announced as signed; next run avoids duplicate action", async () => {
  const db = store(),
    x = start({ db, q: [ok(0), ok(1), { status: 502 }] });
  assert.match((await x.p).title, /未确认/);
  const y = start({ db, q: [ok(0)] });
  assert.match((await y.p).title, /不重复/);
  assert.equal(y.calls.length, 1);
});
test("network, logs and output: do not serialize arbitrary upstream fields", async () => {
  const x = start({
    q: [{ modRet: { iRet: 101, sMsg: sentinel, token: sentinel } }],
  });
  const v = await x.p;
  assert.ok(!JSON.stringify(v).includes(sentinel));
  assert.ok(!x.db[ns + "events"].includes(sentinel));
});
test("off is off even with legacy topic and throwing client", async () => {
  const db = store();
  db.hyrz_log_topic = sentinel;
  const x = start({
    mode: "daily",
    arg: { uploadLog: false, logTopic: "synthetic" },
    db,
    serve: () => {
      throw Error(sentinel);
    },
  });
  await x.p;
  assert.deepEqual(x.calls.map(flow), ["1083547"]);
  assert.ok(!db[ns + "events"].includes(sentinel));
});
test("explicit ntfy opt-in sends one constant summary only; 429 never retried", async () => {
  const x = start({
    mode: "daily",
    arg: { uploadLog: true, logTopic: "synthetic" },
    q: [ok(1), { status: 429 }],
  });
  await x.p;
  assert.equal(x.calls.length, 2);
  const o = x.calls[1];
  assert.equal(o.url, "https://ntfy.sh/");
  assert.equal(o.insecure, false);
  assert.ok(!o.body.includes(sentinel));
  assert.deepEqual(Object.keys(JSON.parse(o.body)).sort(), [
    "message",
    "title",
    "topic",
  ]);
});
test("disabled catchup and empty pending never access network", async () => {
  for (const opt of [
    { mode: "fallback" },
    { mode: "pending", arg: { catchup: true } },
  ]) {
    const x = start(opt);
    await x.p;
    assert.equal(x.calls.length, 0);
  }
});
test("catchup with autoTasks=false still checks server-confirmed rewards; failed box not full", async () => {
  const panel = {
    iRet: 0,
    jData: {
      actIntegral: 100,
      integralTaskList: [],
      task: [40, 60, 100].map((target, index) => ({
        target,
        index,
        curDone: 100,
        leftQual: index === 2 ? 1 : 0,
      })),
    },
  };
  const x = start({
    mode: "fallback",
    arg: { catchup: true, autoTasks: false },
    q: [ok(1), panel, { iRet: 4414 }],
  });
  await x.p;
  assert.equal(x.calls.length, 3);
  assert.equal(JSON.parse(x.db[ns + "day"]).full, false);
  assert.match(x.db[ns + "events"], /已停止/);
});
test("expired and missing credentials: explicit diagnoses and zero requests", async () => {
  for (const a of [null, { ...auth, expire: 1 }, { ...auth, gtk: "" }]) {
    const db = store();
    db[ns + "auth"] = JSON.stringify(a);
    const x = start({ db, mode: "diag" });
    await x.p;
    assert.equal(x.calls.length, 0);
  }
});
test("concurrent cron/manual share lease: at most one write sequence", async () => {
  const db = store();
  let signed = false;
  function serve(c) {
    if (flow(c) === "1083576") {
      signed = true;
      return { modRet: { iRet: 0 } };
    }
    return ok(+signed);
  }
  const x = start({ db, serve }),
    y = start({ mode: "daily", db, serve });
  await Promise.all([x.p, y.p]);
  assert.equal(
    [...x.calls, ...y.calls].filter((c) => flow(c) === "1083576").length,
    1,
  );
});
test("failed durable storage never allows a mutating workflow", async () => {
  const x = start({ badWrite: true });
  assert.match((await x.p).title, /无法保存/);
  assert.equal(x.calls.length, 0);
});
test("local logs never contact games or ntfy or show legacy records", async () => {
  const db = store();
  db.hyrz_log = sentinel;
  db.hyrz_log_topic = sentinel;
  const x = start({
    db,
    mode: "log",
    arg: { logTopic: "synthetic", uploadLog: true },
  });
  assert.ok(!(await x.p).content.includes(sentinel));
  assert.equal(x.calls.length, 0);
});
test("unknown tag, URL invocation, unbound options: fail closed", async () => {
  for (const cfg of [{ mode: "other" }, { request: true }, { arg: null }]) {
    const x = start(cfg);
    await x.p;
    assert.equal(x.calls.length, 0);
  }
});
test("daily sign-only does not discard fresh reward pending", async () => {
  const db = store();
  db[ns + "pending"] = JSON.stringify({ at: now, scope: auth.scope });
  const x = start({ db, mode: "daily", q: [ok(1)] });
  await x.p;
  assert.equal(JSON.parse(db[ns + "pending"]).at, now);
});
test("identity switch during status read: no action on the prior account", async () => {
  const db = store();
  const x = start({
    db,
    serve: () => {
      db[ns + "auth"] = JSON.stringify({ ...auth, scope: "other-synthetic" });
      return ok(0);
    },
  });
  assert.match((await x.p).title, /会话已变化/);
  assert.equal(x.calls.length, 1);
});

test("passive own-session capture → read-only status → one verified daily action (all clients mocked)", async () => {
  const db = {};
  let done = 0;
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "hyrz-sniff.js"), "utf8"),
    {
      $request: {
        method: "POST",
        url: "https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php?iActId=8265",
        body: "g_tk=42&roleId=fixture&area=2&platId=0&partition=3",
        headers: {
          Cookie:
            "openid=demoAccount; ieg_ams_session_token=fixture; ieg_ams_token=demo; ieg_ams_token_time=" +
            auth.expire,
        },
      },
      $persistentStore: {
        read: (k) => db[k],
        write: (v, k) => {
          db[k] = v;
          return true;
        },
      },
      $done: () => {
        done++;
      },
    },
  );
  assert.equal(done, 1);
  assert.ok(db[ns + "auth"]);
  const q = start({ mode: "diag", db, q: [ok(0)] });
  assert.match((await q.p).content, /今天未签/);
  const next = start({
    mode: "daily",
    db,
    q: [ok(0), { modRet: { iRet: 0 } }, ok(1)],
  });
  await next.p;
  assert.deepEqual(next.calls.map(flow), ["1083547", "1083576", "1083547"]);
  assert.equal(JSON.parse(db[ns + "daily"]).state, "signed");
});
test("unconfirmed pending stays queued, respects backoff, then runs despite missing day state", async () => {
  const db = store(),
    a = { ...auth, updated: now };
  db[ns + "auth"] = JSON.stringify(a);
  db[ns + "pending"] = JSON.stringify({ at: now, scope: a.scope });
  let x = start({
    mode: "pending",
    arg: { catchup: true },
    db,
    q: [{ status: 429 }],
  });
  await x.p;
  assert.ok(JSON.parse(db[ns + "pending"]));
  x = start({ mode: "pending", arg: { catchup: true }, db });
  await x.p;
  assert.equal(x.calls.length, 0);
  db[ns + "pendingTry"] = JSON.stringify({
    at: now,
    scope: a.scope,
    next: now - 1,
  });
  x = start({
    mode: "pending",
    arg: { catchup: true },
    db,
    q: [
      ok(1),
      {
        iRet: 0,
        jData: {
          actIntegral: 100,
          integralTaskList: [],
          task: [40, 60, 100].map((target, index) => ({
            target,
            index,
            curDone: 100,
            leftQual: 0,
          })),
        },
      },
    ],
  });
  await x.p;
  assert.equal(JSON.parse(db[ns + "pending"]), null);
  assert.equal(JSON.parse(db[ns + "day"]).full, true);
});
