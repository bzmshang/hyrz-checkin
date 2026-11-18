// v9.16 · Loon http-request / http-response. Passive, local, own-session only.
// No migration: hyrz_auth (unscoped full header), legacy logs, URLs and arguments
// are not inputs. No diagnostic is an authorization or proof of check-in success.
(function () {
  'use strict';
  const AUTH = 'hyrz_v916_auth', PENDING = 'hyrz_v916_pending', CAPTURE = 'hyrz_v916_capture';
  const AMS = 'https://x8m8.ams.game.qq.com/ams/ame/amesvr';
  const WELFARE = 'https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php';
  const ROLE = ['roleId', 'area', 'platId', 'partition'];
  const COOKIES = ['openid', 'ieg_ams_session_token', 'ieg_ams_token', 'ieg_ams_token_time'];
  const PARAMS = ['game', 'sServiceType', 'iActivityId', 'iActId', 'sAppId', 'iFlowId',
    'g_tk', 'openId', 'sOpenid', 'openid'].concat(ROLE);
  const AUTH_FIELDS = ['cookie', 'gtk', 'openid', 'expire', 'updated', 'scope'].concat(ROLE);
  const bounded = (s, n) => typeof s === 'string' && s.length <= n;
  const owns = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const gtkOK = s => bounded(s, 10) && /^[0-9]{1,10}$/.test(s);
  const roleOK = (k, s) => bounded(s, 64) && (k === 'roleId'
    ? /^[A-Za-z0-9_-]{1,64}$/ : /^[0-9]{1,10}$/).test(s);

  function readJSON(key, limit) {
    const raw = $persistentStore.read(key);
    if (!bounded(raw, limit)) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  // Only decode named, bounded form values. null is explicitly invalid/ambiguous;
  // undefined is absent. Never interpolate any of these values into a diagnostic.
  function params(text) {
    const out = Object.create(null);
    for (const pair of text.split('&')) {
      const i = pair.indexOf('=');
      const key = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      if (!PARAMS.includes(key)) continue;
      const raw = i < 0 ? '' : pair.slice(i + 1);
      if (owns(out, key) || raw.length > 512) { out[key] = null; continue; }
      try { out[key] = decodeURIComponent(raw.replace(/\+/g, ' ')); }
      catch (_) { out[key] = null; }
    }
    return out;
  }

  function target(req) {
    const url = req.url;
    if (!bounded(url, 8192) || /[\s\\#\x00-\x1f\x7f]/.test(url)) return null;
    const i = url.indexOf('?'), path = i < 0 ? url : url.slice(0, i);
    if (path !== AMS && path !== WELFARE) return null;
    const body = req.body == null ? '' : req.body;
    if (!bounded(body, 16384)) return null;
    const q = params(i < 0 ? '' : url.slice(i + 1)), f = params(body);
    function get(k) {
      if (owns(q, k) && owns(f, k) && q[k] !== f[k]) return null;
      return owns(f, k) ? f[k] : q[k];
    }
    const game = get('game'), service = get('sServiceType');
    if ((game !== undefined && game !== 'hyrz') || (service !== undefined && service !== 'hyrz')) return null;
    if (path === AMS) {
      if (get('iActivityId') !== '576370' || (game !== 'hyrz' && service !== 'hyrz')) return null;
      const flow = get('iFlowId');
      if (flow === '1083547') return {kind: 'status', activity: '576370', flow, get, f};
      if (flow === '1083576') return {kind: 'sign', activity: '576370', flow, get, f};
      return {kind: 'ams', activity: '576370', flow: '', get, f};
    }
    if (get('iActId') !== '8265' || (get('sAppId') !== undefined && get('sAppId') !== 'ULINK-AKKJ-784060')) return null;
    return {kind: 'welfare', activity: '8265', flow: '', get, f};
  }

  function cookieHeader(headers) {
    const keys = Object.keys(headers || {}).filter(k => k.toLowerCase() === 'cookie');
    if (keys.length !== 1) return '';
    const h = headers[keys[0]];
    if (!Array.isArray(h)) return h;
    if (h.length > 32 || !h.every(v => bounded(v, 8192)) || h.reduce((n, v) => n + v.length, 0) > 8192) return '';
    return h.join('; ');
  }

  function session(header) {
    if (!bounded(header, 8192) || /[\x00-\x1f\x7f]/.test(header)) return null;
    const raw = Object.create(null), decoded = Object.create(null);
    for (const pair of header.split(';')) {
      const item = pair.trim(), i = item.indexOf('='), k = i < 0 ? item : item.slice(0, i);
      if (!COOKIES.includes(k)) continue;
      if (i < 0 || owns(raw, k)) return null;
      raw[k] = item.slice(i + 1);
      if (!/^[A-Za-z0-9.%~_+/:=-]{1,2048}$/.test(raw[k])) return null;
      try { decoded[k] = decodeURIComponent(raw[k]); } catch (_) { return null; }
    }
    if (!COOKIES.every(k => owns(raw, k))) return null;
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(decoded.openid) || !/^[1-9][0-9]{9}$/.test(decoded.ieg_ams_token_time)) return null;
    const token = /^[A-Za-z0-9._~+/:=-]{1,1024}$/;
    if (!token.test(decoded.ieg_ams_token) || !token.test(decoded.ieg_ams_session_token)) return null;
    return {cookie: COOKIES.map(k => k + '=' + raw[k]).join('; '), openid: decoded.openid,
      expire: Number(decoded.ieg_ams_token_time)};
  }

  function previous() {
    const a = readJSON(AUTH, 8192);
    if (!a || typeof a !== 'object' || Object.keys(a).length !== AUTH_FIELDS.length ||
        !AUTH_FIELDS.every(k => owns(a, k)) || !bounded(a.scope, 33) || !/^g[0-9a-f]{32}$/.test(a.scope) ||
        !Number.isSafeInteger(a.updated) || a.updated < 1 || !(a.gtk === '' || gtkOK(a.gtk)) ||
        !(ROLE.every(k => a[k] === '') || ROLE.every(k => roleOK(k, a[k])))) return null;
    const s = session(a.cookie);
    return s && s.cookie === a.cookie && s.openid === a.openid && s.expire === a.expire ? a : null;
  }

  // Equality tag only, not a secret, credential hash, timestamp or account ID.
  function generation() {
    let id = 'g';
    for (let n = 0; n < 4; n++) id += ('00000000' + Math.floor(Math.random() * 0x100000000).toString(16)).slice(-8);
    return id;
  }

  function capture(req, t, at) {
    const s = session(cookieHeader(req.headers));
    if (!s || s.expire <= Math.floor(at / 1000)) return;
    if (['sOpenid', 'openId', 'openid'].some(k => t.get(k) !== undefined && t.get(k) !== s.openid)) return;
    const old = previous();
    // Expiry orders tickets only within one identity. A different identity must
    // be corroborated by its own complete welfare role form, not delayed AMS traffic.
    if (old && old.openid === s.openid && old.expire > s.expire) return;
    const same = old && old.cookie === s.cookie;
    const gtk = t.get('g_tk');
    const supplied = ROLE.filter(k => t.get(k) !== undefined);
    const full = t.kind === 'welfare' && ROLE.every(k => owns(t.f, k) && roleOK(k, t.get(k)));
    if (old && old.openid !== s.openid && !full) return;
    const matches = same && supplied.every(k => roleOK(k, t.get(k)) && t.get(k) === old[k]);
    const stable = matches && (gtk === undefined || gtk === old.gtk);

    // A welfare role tuple is atomic and comes only from the form. Unknown roles
    // never get defaults or pieces from other messages. A role-free request can
    // prove the base AMS session but cannot bind a changed g_tk to an old role.
    const a = s;
    for (const k of ROLE) a[k] = full ? t.f[k] : stable ? old[k] : '';
    const sameRole = old && ROLE.every(k => a[k] === old[k]);
    a.gtk = gtkOK(gtk) && (a.roleId || !supplied.length) ? gtk :
      gtk === undefined && same && sameRole ? old.gtk : '';
    if (same && sameRole && a.gtk === old.gtk) return; // polling is not a refresh
    const ready = !!a.gtk; // base check-in; welfare additionally requires the tuple
    a.scope = old && a.openid === old.openid && sameRole && !(old.gtk && !a.gtk)
      ? old.scope : generation();
    a.updated = at;
    // Write auth first. Never consume/ack pending here. Consumers must check
    // current scope, updated === pending.at, completeness and expiry before use.
    if ($persistentStore.write(JSON.stringify(a), AUTH) && ready) {
      $persistentStore.write(JSON.stringify({scope: a.scope, at}), PENDING);
    }
  }

  const HTTP = [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504];
  const CODES = [-1, 0, 101, 2026, 4150, 4411];
  function enumerated(value, list) {
    for (const n of list) if (value === n || value === String(n)) return n;
    return null;
  }
  function object(value) {
    if (bounded(value, 32768)) {
      try { value = JSON.parse(value); } catch (_) { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }
  function responseCode(body) {
    const j = bounded(body, 32768) && object(body);
    if (!j) return null;
    let code = null;
    for (const part of [j, object(j.flowRet), object(j.modRet)]) {
      if (!part) continue;
      for (const k of ['ret', 'iRet']) {
        if (!owns(part, k)) continue;
        code = enumerated(part[k], CODES);
        if (code !== 0) return code;
      }
    }
    return code;
  }

  function observe(t, isResponse, at) {
    const prev = readJSON(CAPTURE, 512);
    const last = k => prev && Number.isSafeInteger(prev[k]) && prev[k] > 0 && prev[k] <= at ? prev[k] : 0;
    const d = {at, phase: isResponse ? 'resp' : 'req', kind: t.kind, activity: t.activity, flow: t.flow,
      http: isResponse ? enumerated($response.status, HTTP) : null,
      code: isResponse ? responseCode($response.body) : null,
      reqAt: isResponse ? last('reqAt') : at, respAt: isResponse ? at : last('respAt')};
    $persistentStore.write(JSON.stringify(d), CAPTURE);
  }

  try {
    const t = target($request);
    if (t) {
      const at = Date.now(), isResponse = typeof $response !== 'undefined';
      observe(t, isResponse, at);
      if (!isResponse && $request.method === 'POST') capture($request, t, at);
    }
  } catch (_) {
    // Malformed/oversize input and storage failures are never reasons to log or block.
  } finally {
    $done({});
  }
})();
