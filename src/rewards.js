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
