// Reproduce a Generic run window that discards $done's payload and only shows console.log.
'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
const js=fs.readFileSync(require.resolve('../hyrz-sign.js'),'utf8');
async function exercise({arg='read:diagnosis',req,withAuth=false,name='hyrz-sign.js',omitConsole=false,mode='ok'}={}) {
  const lines=[],requests=[],notices=[],db={}; const secret='MOCK-PRIVATE-DO-NOT-PRINT';
  if(withAuth) db.hyrz_v916_auth=JSON.stringify({cookie:secret,openid:secret,gtk:secret,scope:'fixture',expire:Math.floor(Date.now()/1000)+3000});
  await new Promise((resolve,reject)=>{const ctx={$argument:arg,$script:{name},$persistentStore:{read:k=>db[k],write:(v,k)=>{db[k]=v;return true}},$notification:{post:()=>notices.push(true)},setTimeout,clearTimeout,console:omitConsole?{log(){throw Error('unavailable')}}:{log:t=>lines.push(t)},$done:()=>{lines.push('Script done');resolve()},$httpClient:{post(o,cb){requests.push(o);cb(null,{status:200},JSON.stringify({modRet:{iRet:mode==='ok'?0:101,sMsg:secret,jData:{openid_jf_everyDay:1}}}))}}};if(req!==undefined)ctx.$request=req;try{vm.runInNewContext(js,ctx)}catch(e){reject(e)}});
  assert.equal(lines.at(-1),'Script done');assert.ok(lines.every(x=>typeof x==='string'&&!x.includes(secret)));assert.deepEqual(notices,[]);return {text:lines.join('\n'),lines,requests};
}
test('unbound tag, no credentials: window still shows diagnosis and why, no network',async()=>{const x=await exercise();assert.match(x.lines[0],/v9\.16\.2.*只读诊断开始/);assert.match(x.text,/结论：未取得本版会话/);assert.equal(x.requests.length,0)});
test('null or empty request placeholder: literal read mode can only query status',async()=>{for(const req of [null,{}]){const x=await exercise({req,withAuth:true,name:'火影·每日签到'});assert.match(x.text,/查状态.*HTTP=200/);assert.equal(x.requests.length,1);assert.equal(new URLSearchParams(x.requests[0].body).get('iFlowId'),'1083547')}});
test('upstream reports login requirement: summary logged instead of raw error',async()=>{const x=await exercise({withAuth:true,mode:'login'});assert.match(x.text,/未认可插件本次登录态/);assert.match(x.text,/业务=101/)});
test('real HTTP hook is always silent/pass-through; ignore a read-mode argument',async()=>{const x=await exercise({req:{url:'https://example.invalid/'},withAuth:true});assert.deepEqual(x.lines,['Script done']);assert.equal(x.requests.length,0)});
test('local history literal is read-only and does not use game or ntfy',async()=>{const x=await exercise({arg:'read:history',withAuth:true});assert.match(x.text,/读取本机运行记录/);assert.match(x.text,/最近运行/);assert.equal(x.requests.length,0)});
test('optional console failure cannot suppress $done',async()=>{assert.deepEqual((await exercise({omitConsole:true})).lines,['Script done'])});
