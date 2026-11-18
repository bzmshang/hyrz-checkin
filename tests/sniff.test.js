'use strict';
// Standalone: node tests/sniff.test.js. All traffic below is plain fixture data in a VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = new vm.Script(fs.readFileSync(path.join(__dirname, '../hyrz-sniff.js'), 'utf8'));
const A = 'hyrz_v916_auth', P = 'hyrz_v916_pending', D = 'hyrz_v916_capture';
const AMS = 'https://x8m8.ams.game.qq.com/ams/ame/amesvr';
const W = 'https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php';
const WURL = W + '?iActId=8265', AMSURL = AMS + '?game=hyrz&iActivityId=576370';
const NOW = 1800000000123, EXP = 1800080000;
const role = 'roleId=roleA&area=2&platId=0&partition=3', full = role + '&g_tk=42';
function cookie(id = 'fixture%2DA', exp = EXP, token = 't%2B%2F%3D') {
  return `openid=${id}; ieg_ams_session_token=session-A; ieg_ams_token=${token}; ieg_ams_token_time=${exp}`;
}
function req(body = full, ck = cookie(), url = WURL) {
  return {method: 'POST', url, body, headers: {Cookie: ck, 'X-Fixture': 'never-save'}};
}
function rig(initial = {}) {
  const mem = {...initial};
  let now = NOW;
  function hook(request, response, store = {}) {
    const writes = [], reads = [], done = [], forbidden = [];
    const context = {$request: request, Date: {now: () => now}, $done(...args) { done.push(args); },
      $persistentStore: {read(k) { reads.push(k); return mem[k]; },
        write(v, k) { writes.push(k); mem[k] = v; return true; }, ...store}};
    if (response !== undefined) context.$response = response;
    for (const name of ['$httpClient', '$notification', '$argument', 'console', 'fetch', 'setTimeout', 'setInterval']) {
      Object.defineProperty(context, name, {get() { forbidden.push(name); throw Error('disabled'); }});
    }
    script.runInNewContext(context);
    assert.deepEqual(forbidden, []);
    assert.equal(done.length, 1); assert.equal(done[0].length, 1);
    assert.equal(Object.prototype.toString.call(done[0][0]), '[object Object]');
    assert.deepEqual(Reflect.ownKeys(done[0][0]), []);
    const slot = k => /^hyrz_v916_cmp_(?:(?:status|sign|ams)_(?:req|resp)|overlap)$/.test(k);
    assert.ok(reads.every(k => [A, D, 'hyrz_v916_cmp_ownUntil'].includes(k)) && writes.every(k => [A, P, D].includes(k) || slot(k)));
    now += 13;
    return writes.filter(k => !slot(k)); // Existing assertions cover auth/legacy snapshot only; dedicated comparison tests check new slots.
  }
  return {hook, mem, get: k => JSON.parse(mem[k] || 'null'), now: () => now};
}

test('JS checks exact HTTPS authority, path and activity before reads/writes in either phase', () => {
  const h = rig();
  for (const url of [WURL.replace('https:', 'http:'), 'https://example.invalid/?iActId=8265',
    WURL.replace('/7335/', '/7336/'), W + '/?iActId=8265', W, W + '?iActId=1', WURL + '&game=other',
    WURL + '&sAppId=other', AMSURL.replace('/ams/ame/', '/other/'), AMS + '?iActivityId=576370',
    AMS + '?iActivityId=576370&game=other', AMS + '?sServiceType=hyrz&iActivityId=1', AMSURL + '&sServiceType=other',
    WURL.replace('com/', 'com:8080/'), WURL + '#fragment', WURL + '&iActId=1']) {
    for (const r of [undefined, {status: 200, body: '{}'}]) assert.deepEqual(h.hook(req(full, cookie(), url), r), []);
  }
  assert.deepEqual(h.hook(req(full + '&iActId=1')), []);
  assert.deepEqual(h.hook(req('x'.repeat(16385))), []);
  assert.deepEqual(h.mem, {});
});

test('exact app without credentials: strictly enumerated status/action and latest phase times only', () => {
  const h = rig();
  const r = flow => req('sOpenid=not-diagnostic&iFlowId=' + flow, '', AMSURL);
  assert.deepEqual(h.hook(r('1083547')), [D]);
  assert.deepEqual(h.get(D), {rev: 2, at: NOW, reqAt: NOW, respAt: 0, phase: 'req', kind: 'status',
    activity: '576370', flow: '1083547', http: null, code: null});
  const at = h.now();
  assert.deepEqual(h.hook(r('1083576'), {status: '200', body: JSON.stringify({modRet: {iRet: 101,
    sMsg: 'never-save', jData: {name: 'never-save'}}})}), [D]);
  assert.deepEqual(h.get(D), {rev: 2, at, reqAt: NOW, respAt: at, phase: 'resp', kind: 'sign',
    activity: '576370', flow: '1083576', http: 200, code: 101});
  for (const body of ['private-text', '{"ret":"never-save"}', '{"ret":777777}', 'x'.repeat(32769)]) {
    h.hook(r('not-diagnostic'), {status: 'private-status', body});
    assert.equal(h.get(D).code, null); assert.equal(h.get(D).http, null);
    assert.equal(h.get(D).kind, 'ams'); assert.equal(h.get(D).flow, '');
  }
  h.hook(req(), {status: 200, body: '{"iRet":0}'});
  assert.equal(h.get(D).code, 0); assert.equal(h.get(D).kind, 'welfare');
  assert.deepEqual(Object.keys(h.mem).sort(), [D, 'hyrz_v916_cmp_status_req', 'hyrz_v916_cmp_sign_resp', 'hyrz_v916_cmp_ams_resp'].sort());
});

test('minimal encoded cookie, scoped queue and idempotence; old keys are neither read nor changed', () => {
  const h = rig({hyrz_auth: '{"cookie":"legacy-only"}', hyrz_log_topic: 'legacy-only'});
  const parts = cookie().split('; ');
  const r = req(full, ['discard=never-save', ...parts.slice().reverse()]);
  assert.deepEqual(h.hook(r), [D, A, P]);
  const a = h.get(A);
  assert.match(a.scope, /^g[0-9a-f]{32}$/);
  assert.deepEqual(a, {cookie: cookie(), openid: 'fixture-A', expire: EXP, updated: NOW, scope: a.scope,
    gtk: '42', roleId: 'roleA', area: '2', platId: '0', partition: '3'});
  assert.deepEqual(h.get(P), {scope: a.scope, at: NOW});
  delete h.mem[P]; // scheduled consumer, not the hook
  for (const poll of [req(full), req('', cookie(), AMSURL), req('roleId=roleA'), req(full, cookie() + '; extra=unused')]) {
    assert.deepEqual(h.hook(poll), [D]);
  }
  assert.equal(h.get(P), null); assert.deepEqual(h.get(A), a);
  assert.equal(h.mem.hyrz_auth, '{"cookie":"legacy-only"}');
  assert.equal(h.mem.hyrz_log_topic, 'legacy-only');
  assert.ok(!h.mem[D].includes(a.scope));
});

test('unproven, ambiguous, expired or oversized credentials cannot alter active auth', () => {
  const h = rig(); h.hook(req());
  for (const ck of [undefined, '', 'extra=only', cookie().replace('openid=', 'unused='),
    cookie().replace('ieg_ams_session_token=', 'unused='), cookie().replace('ieg_ams_token=', 'unused='),
    cookie().replace('ieg_ams_token_time=', 'unused='), cookie('', EXP), cookie('fixture-B', EXP, ''),
    cookie() + '; openid=fixture-A', cookie('fixture-B', Math.floor(NOW / 1000)), cookie('fixture-B', EXP + 'junk'),
    cookie('fixture-B', EXP, '%Q'), cookie('fixture-B', EXP, 'x'.repeat(2049)), 'x'.repeat(8193)]) {
    const r = req(); r.headers.Cookie = ck;
    assert.deepEqual(h.hook(r), [D]);
  }
  for (const s of ['sOpenid=fixture-B', 'openId=fixture-B', 'openid=fixture-B']) {
    assert.deepEqual(h.hook(req(full + '&' + s)), [D]);
  }
  assert.equal(h.get(A).updated, NOW);
});

test('compare expiry per identity; earlier corroborated welfare switch isolates auth from delayed AMS', () => {
  const h = rig(); h.hook(req()); const old = h.get(A);
  const b = cookie('fixture-B', EXP - 300, 'session-B');
  assert.deepEqual(h.hook(req('g_tk=99', cookie('fixture-B', EXP - 1))), [D]);
  assert.deepEqual(h.hook(req(full, cookie('fixture-A', EXP - 1))), [D]);
  assert.deepEqual(h.hook(req(role, b)), [D, A]);
  const partial = h.get(A);
  assert.equal(partial.openid, 'fixture-B'); assert.equal(partial.gtk, '');
  assert.notEqual(partial.scope, old.scope); assert.equal(h.get(P).scope, old.scope);
  assert.deepEqual(h.hook(req('g_tk=42', cookie(), AMSURL)), [D]); // delayed old account cannot switch back
  assert.deepEqual(h.hook(req(full, b)), [D, A, P]);
  assert.deepEqual(h.get(P), {scope: h.get(A).scope, at: h.get(A).updated});
  assert.equal(h.get(A).gtk, '42');
});

test('changed session invalidates unsupplied role and g_tk; refresh with confirmed binding retains scope', () => {
  const h = rig(); h.hook(req()); const first = h.get(A);
  const rotated = cookie('fixture%2DA', EXP + 1, 'new-token');
  assert.deepEqual(h.hook(req(full, rotated)), [D, A, P]);
  assert.equal(h.get(A).scope, first.scope); assert.notEqual(h.get(A).updated, first.updated);
  const next = cookie('fixture%2DA', EXP + 2, 'another-token');
  assert.deepEqual(h.hook(req('g_tk=43', next, AMSURL)), [D, A, P]);
  const partial = h.get(A);
  assert.deepEqual([partial.roleId, partial.area, partial.platId, partial.partition, partial.gtk], ['', '', '', '', '43']);
  assert.notEqual(partial.scope, first.scope);
  assert.deepEqual(h.hook(req(role, next)), [D, A]); assert.equal(h.get(A).gtk, '');
  assert.deepEqual(h.hook(req(full, next)), [D, A, P]);
  assert.deepEqual(h.hook(req(full, next)), [D]);
});

test('no role assembly across packets; role, area, platform and partition all delimit generations', () => {
  const h = rig(); h.hook(req()); let a = h.get(A);
  for (const r of ['roleId=roleB&area=2&platId=0&partition=3', 'roleId=roleB&area=3&platId=0&partition=3',
    'roleId=roleB&area=3&platId=1&partition=3', 'roleId=roleB&area=3&platId=1&partition=8']) {
    assert.deepEqual(h.hook(req(r)), [D, A]);
    assert.notEqual(h.get(A).scope, a.scope); assert.equal(h.get(A).gtk, '');
    assert.equal(h.get(P).scope, a.scope);
    assert.deepEqual(h.hook(req(r + '&g_tk=53')), [D, A, P]); a = h.get(A);
  }
  for (const fragment of ['roleId=roleC', 'area=2&platId=1&partition=8']) {
    h.hook(req(fragment));
    assert.equal(h.get(A).roleId, ''); assert.equal(h.get(A).gtk, '');
    assert.notEqual(h.get(A).scope, h.get(P).scope);
  }
  h.hook(req(full)); a = h.get(A);
  h.hook(req('g_tk=43', cookie(), AMSURL)); // changed g_tk alone doesn't prove the old role
  assert.notEqual(h.get(A).scope, a.scope); assert.equal(h.get(A).gtk, '43'); assert.equal(h.get(A).roleId, '');
});

test('reject incoherent/unscoped v2 state and require a usable observation to schedule', () => {
  const h = rig({[A]: '{"cookie":"legacy-only","gtk":"1"}'});
  assert.deepEqual(h.hook(req('roleId=X&g_tk=42')), [D, A]);
  assert.equal(h.get(A).gtk, ''); assert.equal(h.get(A).roleId, ''); assert.equal(h.get(P), null);
  for (const body of [role + '&g_tk=NaN', role + '&g_tk=1&g_tk=2', role + '&g_tk=' + '7'.repeat(513),
    full.replace('roleA', 'x'.repeat(65)), full.replace('platId=0', 'platId='), full.replace('area=2', 'area=%0A')]) {
    h.hook(req(body)); assert.equal(h.get(A).gtk, ''); assert.equal(h.get(P), null);
  }
  assert.deepEqual(h.hook(req('g_tk=42', cookie(), WURL + '&' + role)), [D]); // query is not a role source
  h.hook(req(full)); const a = h.get(A);
  h.mem[A] = JSON.stringify({...a, openid: 'not-bound'});
  assert.deepEqual(h.hook(req(role)), [D, A]);
  assert.notEqual(h.get(A).scope, a.scope); assert.equal(h.get(A).gtk, '');
});

test('storage or malformed context failures always pass through; failed auth write cannot schedule', () => {
  const h = rig(); h.hook(undefined); h.hook({url: WURL, body: new Uint8Array([1])});
  h.hook(req(), undefined, {read() { throw Error('fixture read failure'); }});
  const keys = []; h.hook(req(), undefined, {write(_, k) { keys.push(k); return k !== A; }});
  assert.deepEqual(keys, [D, A]);
  h.hook(req(), undefined, {write() { throw Error('fixture write failure'); }});
  assert.deepEqual(h.mem, {});
});

test('navigation is diagnostic only, even with a current cookie', () => {
  const h = rig();
  assert.deepEqual(h.hook({...req(), method: 'GET'}), [D]);
  assert.deepEqual(h.hook({...req(), method: undefined}), [D]);
  assert.equal(h.get(A), null); assert.equal(h.get(P), null);
});
