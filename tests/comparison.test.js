// Offline UI + passive-hook contract. Never use real accounts or make HTTP requests.
'use strict';
const test = require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
const sniff=fs.readFileSync(require.resolve('../hyrz-sniff.js'),'utf8');
const runner=fs.readFileSync(require.resolve('../hyrz-sign.js'),'utf8');
const base='hyrz_v916_', S='1083547', A='1083576';
const wx='https://x8m8.ams.game.qq.com/ams/ame/amesvr?game=hyrz&iActivityId=576370';
const welfare='https://ulinkact.game.qq.com/app/7335/99200e6deafa8a6a/index.php?iActId=8265';
const raw='PRIVATE-TEST-STRING', ok={ret:0,flowRet:{iRet:0},modRet:{iRet:0}};
function fixture(){
 const mem={}, posts=[], now=Date.now(); let at=now;
 const store={read:k=>mem[k],write:(v,k)=>{mem[k]=v;return true}};
 const clock=class extends Date {static now(){return at}};
 function hook(id,obj,url=wx){const req={url,method:'POST',headers:{},body:id?'iFlowId='+id:''};let n=0;
   const ctx={Date:clock,$request:req,$persistentStore:store,$done(){n++}};
   if(obj!==undefined)ctx.$response={status:200,body:JSON.stringify(obj)};
   vm.runInNewContext(sniff,ctx);assert.equal(n,1);at+=1;
 }
 async function run(arg='read:history'){return new Promise((resolve,reject)=>{
  const ctx={Date:clock,$persistentStore:store,$argument:arg,$script:{name:'mock'},setTimeout,clearTimeout,console:{log(){}},$done:r=>resolve(r.content),$httpClient:{post:(o,cb)=>{posts.push(o);hook(S);hook(S,{...ok,modRet:{iRet:101}});cb(null,{status:200},JSON.stringify({...ok,modRet:{iRet:101}}))}}};
  try{vm.runInNewContext(runner,ctx)}catch(e){reject(e)}
 })}
 return {hook,run,mem,posts,at:()=>at,advance:n=>at+=n};
}
test('status response survives later welfare response, sign flow and a second request without response',async()=>{
 const h=fixture();h.hook(S);h.hook(S,ok);h.hook(A);h.hook(S);h.hook('',{iRet:0},welfare);
 const text=await h.run();assert.match(text,/状态1083547：响应 .* HTTP=200 顶层=0 流程=0 业务=0，另见请求/);
 assert.match(text,/动作1083576：另见请求/);assert.match(text,/最近捕获（采集 v9.16.2）：.*福利站/);assert.equal(h.posts.length,0);
});
test('never borrow a missing flow id, treat a missing business code as unknown, do not store arbitrary upstream fields',async()=>{
 const h=fixture();h.hook(S);h.hook('',{ret:0,sMsg:raw,arbitrary:raw});h.hook(S,{ret:0,flowRet:{iRet:0},modRet:{iRet:raw}});
 const text=await h.run();assert.match(text,/未归类AMS：响应/);assert.match(text,/状态1083547：响应 [^；]*业务=-/);assert.ok(!JSON.stringify(h.mem).includes(raw));assert.ok(!text.includes(raw));
});
test('an actual diagnostic overlapping the hook is not counted as independent status evidence',async()=>{
 const h=fixture();h.hook(S,ok);const before=h.mem[base+'cmp_status_resp'];h.mem[base+'auth']=JSON.stringify({scope:'synthetic',gtk:'test',cookie:'demo',openid:'fixture',expire:Math.floor(h.at()/1000)+600});
 const result=await h.run('read:diagnosis');assert.match(result,/业务=101/);assert.equal(h.posts.length,1);assert.equal(h.mem[base+'cmp_status_resp'],before);
 const local=await h.run();assert.match(local,/与插件请求时间重叠/);assert.equal(h.posts.length,1);h.advance(16000);h.hook(S,ok);assert.notEqual(h.mem[base+'cmp_status_resp'],before);
});
test('previous-day observations and welfare-only metadata are never shown as AMS success',async()=>{
 const h=fixture();h.hook(S,ok);h.advance(86400000);h.hook('',{iRet:0},welfare);assert.match(await h.run(),/签到页观察（今日被动记录）：暂无 AMS 记录/);assert.equal(h.posts.length,0);
});
test('look at logs does not label older v9.16.1 captures as v9.16.2 or infer official calls from old diagnostics',async()=>{
 const h=fixture();h.mem[base+'capture']=JSON.stringify({kind:'welfare',at:h.at(),http:200,code:0});h.mem[base+'events']=JSON.stringify([{at:h.at(),mode:'diag',state:'login',steps:['查状态 1083547：HTTP=200 顶层=0 流程=0 业务=101']}]);let text=await h.run();assert.match(text,/暂无 AMS 记录/);assert.match(text,/尚无新版采集/);assert.match(text,/诊断：接口未认可插件本次登录态/);assert.equal(h.posts.length,0);
});
test('signed bit only when HTTP and business status permit it, and only for explicit 0 or 1',async()=>{
 const h=fixture(), data=v=>({openid_jf_everyDay:v});
 for(const [mod,expected] of [[{iRet:0,jData:data('1')},'已签'],[{iRet:0,jData:data(0)},'未签'],[{iRet:101,jData:data(1)},''],[{jData:data(1)},''],[{iRet:0,jData:data(raw)},'']]) {
   h.hook(S,{...ok,modRet:mod});const line=(await h.run()).split('\n').find(s=>s.startsWith('签到页观察'));
   assert.ok(!line.includes(raw));if(expected)assert.ok(line.endsWith(expected));else assert.ok(!/已签|未签/.test(line));
 }
});
