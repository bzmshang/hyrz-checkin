'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/rewards.js'), 'utf8');
const pass = vm.runInNewContext(source + '\nwelfarePass', Object.create(null));
const GL = 'Welfare/getWelfareStatusNow', G = 'Welfare/getWelfareGiftNow';
const P = 'Welfare/getTodayActInfo', T = 'Index/taskLotteryNow', B = 'Welfare/getTodayActGiftNow';
const both = {gift: true, tasks: true}, tasks = {tasks: true};
const response = json => ({status: 200, err: false, json});
const ok = jData => response({iRet: '0', jData});
const ack = ok({}), award = ok({awardList: [{sPackageName: 'PRIVATE'}]});
const gift = (index, leftQual = '1') => ({index, leftQual, name: 'PRIVATE'});
const task = (index, curDone = '1', leftQual = '1') => ({...gift(index, leftQual), curDone, target: 1});
const boxes = (left = [0, 0, 0]) => [40, 60, 100].map((target, index) =>
  ({index, target, curDone: 0, leftQual: left[index]}));
const panel = (points = 100, rows = [], bs = boxes()) => ok({actIntegral: points, integralTaskList: rows, task: bs});
const read = (route, r) => [route, {}, r];
const write = (route, index, r) => [route, {index}, r];
// Compare the entire transcript OUTSIDE the code under test (including extra calls
// after a stop). No timer, service, credentials, persistence or injected host API.
async function replay(opts, script, expected, hooks = {}) {
  const seen = [], waits = [];
  const result = await pass({enough: () => true, wait: async ms => { waits.push(ms); }, ...hooks,
    call: async (route, extra) => {
      seen.push([route, {...extra}]);
      const r = script[seen.length - 1]?.[2];
      if (r instanceof Error) throw r;
      return r;
    }}, opts);
  assert.deepEqual(seen, script.map(([route, extra]) => [route, extra]));
  if (!hooks.wait) assert.deepEqual(waits, Array(Math.max(0, seen.length - 1)).fill(250));
  const defaults = {state: 'ok', gifts: 0, claims: 0, boxes: 0, points: null, full: false,
    giftState: 'skipped', taskState: 'skipped'};
  assert.deepEqual({...result}, {...defaults, ...expected});
}

test('opt-in, real empty gift list, no cached confirmation on a later invocation', async () => {
  await replay({gift: false, tasks: false}, [], {});
  await replay({gift: true}, [read(GL, ok([]))], {giftState: 'ok'});
  await replay(tasks, [read(P, panel())], {points: 100, taskState: 'ok', full: true});
  await replay(tasks, [read(P, panel(0))], {points: 0, taskState: 'ok'});
});
test('only offered earned IDs; refresh after claims, then confirm all boxes', async () => {
  const before = [task('readArticle'), task('sign', 0), task('like', 1, 0)];
  await replay(both, [read(GL, ok([gift(0), gift('weekly', 0)])), write(G, '0', award),
    read(P, panel(30, before, boxes([1, 1, 1]))), write(T, 'readArticle', ack),
    read(P, panel('110', [], boxes([1, 1, 1]))), ...['0', '1', '2'].map(i => write(B, i, ack)),
    read(P, panel(110))], {gifts: 1, claims: 1, boxes: 3, points: 110, full: true, giftState: 'ok', taskState: 'ok'});
});
test('readiness comes from points OR box progress, not leftQual alone', async () => {
  const bs = boxes([1, 1, 1]); bs[1].curDone = '60';
  await replay(tasks, [read(P, panel(40, [], bs)), write(B, '0', ack), write(B, '1', ack),
    read(P, panel(40, [], boxes([0, 0, 1])))], {taskState: 'ok', boxes: 2, points: 40});
  await replay(tasks, [read(P, panel(99))], {taskState: 'ok', points: 99});
});
test('remaining eligible tasks or boxes prevent full; no repeated attempts', async () => {
  for (const latest of [panel(101, [task('sign')]), panel(101, [], boxes([1, 0, 0]))]) {
    await replay(tasks, [read(P, panel(101, [], boxes([1, 0, 0]))), write(B, '0', ack), read(P, latest)],
      {state: 'partial', taskState: 'partial', boxes: 1, points: 101});
  }
});
test('known refusals never count, even when the final panel no longer offers the item', async () => {
  for (const code of [2026, 4150, 4411]) await replay(both, [read(GL, ok([gift('weekly')])),
    write(G, 'weekly', response({iRet: code})), read(P, panel())],
    {state: 'partial', giftState: 'partial', taskState: 'ok', points: 100});
  await replay(tasks, [read(P, panel(100, [task('sign'), task('like')])), write(T, 'sign', ack),
    write(T, 'like', response({iRet: 4036})), read(P, panel())],
    {state: 'partial', taskState: 'partial', claims: 1, points: 100});
  await replay(tasks, [read(P, panel(100, [], boxes([0, 0, 1]))), write(B, '2', response({iRet: 4150})),
    read(P, panel())], {state: 'partial', taskState: 'partial', points: 100});
});

test('malformed envelopes, HTTP/transport uncertainty and unknown codes stop both phases', async () => {
  for (const r of [null, response(null), response([]), response({}), response({ret: 0, jData: []}),
    ...[false, null, '', [], '0.0', 777].map(iRet => response({iRet, jData: []})),
    response({ret: -9, iRet: 0, jData: []}), {...ok([]), status: 503}, {...ok([]), status: 302},
    {...ok([]), err: true}, new Error('PRIVATE')]) {
    await replay(both, [read(GL, r)], {state: 'unknown', giftState: 'unknown'});
  }
  for (const r of [ok(null), ok({awardList: []}), ok({awardList: [null]}), response({iRet: 12345})])
    await replay(both, [read(GL, ok([gift('daily')])), write(G, 'daily', r)], {state: 'unknown', giftState: 'unknown'});
});
test('reject incomplete, duplicate or malformed rows before any writes', async () => {
  for (const data of [null, {}, [gift('daily'), gift('bad key')], [gift(0), gift('0')], [gift('daily', null)]])
    await replay(both, [read(GL, ok(data))], {state: 'unknown', giftState: 'unknown'});
  const dup = boxes(); dup[2].index = 0; dup[2].target = 40;
  const wrong = boxes(); wrong[2].target = 60;
  for (const p of [ok({}), panel(null), panel(-1), panel(100, null), panel(100, [task('unrecognised')]),
    panel(100, [task('sign'), task('sign')]), panel(100, [task('sign', null)]), panel(100, [task('like', 1, true)]),
    panel(100, [], []), panel(100, [], dup), panel(100, [], wrong), panel(100, [], [...boxes(), null])]) {
    await replay(tasks, [read(P, p)], {state: 'unknown', taskState: 'unknown'});
  }
});
test('throttling stops at every boundary, including confirmation reads; no trailing wait', async () => {
  const path = [read(GL, ok([gift('weekly')])), write(G, 'weekly', award), read(P, panel(30, [task('sign')])),
    write(T, 'sign', ack), read(P, panel(100, [], boxes([1, 0, 0]))), write(B, '0', ack), read(P, panel())];
  for (const busy of [{status: 429, err: true, json: null}, response({iRet: 1103}), response({iRet: '4414'}),
    response({ret: '-1', msg: '\\u7a0d\\u540e\\u518d\\u8bd5'}), response({ret: 429, iRet: 0, jData: []})]) {
    for (let i = 0; i < path.length; i++) {
      const script = [...path.slice(0, i), [...path[i].slice(0, 2), busy]];
      await replay(both, script, {state: 'busy', giftState: i < 2 ? 'busy' : 'ok', taskState: i < 2 ? 'skipped' : 'busy',
        gifts: +(i > 1), claims: +(i > 3), boxes: +(i > 5)});
    }
  }
});
test('auth stops; failed recheck cannot use old points or completion', async () => {
  for (const [r, state] of [[{status: 401, json: null, err: false}, 'login'], [response({iRet: '101'}), 'login'],
    [response({iRet: -1, sMsg: '未绑定游戏角色'}), 'noRole'], [response({flowRet: {iRet: 1103}}), 'busy'],
    [response({modRet: {iRet: 101}}), 'login'], [response({...panel().json, flowRet: {iRet: 0}}), 'unknown'],
    [ok({}), 'unknown'], [response(null), 'unknown']]) {
    await replay(tasks, [read(P, panel(100, [], boxes([0, 0, 1]))), write(B, '2', ack), read(P, r)],
      {state, taskState: state, boxes: 1});
  }
});
test('deadline before a call, during pacing and from the transport', async () => {
  const expected = {state: 'budget', giftState: 'budget'};
  await replay(both, [], expected, {enough: () => false});
  let time = true, waits = 0;
  await replay(both, [read(GL, ok([gift('daily')]))], expected, {enough: () => time, wait: async () => { waits++; time = false; }});
  assert.equal(waits, 1);
  await replay(both, [read(GL, new Error('budget'))], expected);
});
test('bounded lists, per-phase attempts and total network including confirmation', async () => {
  const gifts = Array.from({length: 5}, (_, i) => gift(i));
  const g = gifts.slice(0, 4).map(it => write(G, String(it.index), award));
  const ts = 'sign duel phone ninja guestInfo active actCalendar like wallpaper readArticle scrollRecord'.split(' ').map(id => task(id));
  const t = ts.slice(0, 10).map(it => write(T, it.index, ack));
  await replay(both, [read(GL, ok(Array(65).fill(gift('daily'))))], {state: 'budget', giftState: 'budget'});
  await replay(both, [read(GL, ok(gifts)), ...g], {state: 'budget', giftState: 'budget', gifts: 4});
  await replay(tasks, [read(P, panel(100, ts)), ...t], {state: 'budget', taskState: 'budget', claims: 10});
  await replay(both, [read(GL, ok(gifts.slice(0, 4))), ...g, read(P, panel(30, ts.slice(0, 10))), ...t,
    read(P, panel(100, [], boxes([1, 1, 1]))), ...['0', '1', '2'].map(i => write(B, i, ack))],
    {state: 'budget', giftState: 'ok', taskState: 'budget', gifts: 4, claims: 10, boxes: 3});
});
