'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');const root=path.resolve(__dirname,'..'),site=path.join(root,'site');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const password=process.env.PAGES_SMOKE_PASSWORD;assert(password);let revision='';
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!pathname.startsWith('/playroom-preview/')){res.writeHead(404);return res.end();}
  const relative=pathname.slice('/playroom-preview/'.length)||'index.html',file=path.resolve(site,relative);
  if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.html')?'text/html; charset=utf-8':relative.endsWith('.webmanifest')?'application/manifest+json':'application/octet-stream');
  res.end(relative==='sw.js'?fs.readFileSync(file,'utf8')+revision:fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 const report={checks:[],errors:[]};
 try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{}),args:['--no-sandbox']});
  const ctx=await browser.newContext();await ctx.addInitScript(()=>{if(!localStorage.getItem('playroom.player-profile.v1'))localStorage.setItem('playroom.player-profile.v1',JSON.stringify({version:1,id:'pages-test',name:'Тест',createdAt:1,updatedAt:1}));});
  const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  const url=process.env.SITE_URL||`http://127.0.0.1:${server.address().port}/playroom-preview/`;
  const response=await ctx.request.get(url);assert.equal(response.status(),200);assert.equal(digest(await response.body()),digest(fs.readFileSync(site+'/index.html')));
  report.checks.push('Published encrypted bytes match build');
  await page.goto(url);await page.locator('#staticrypt-password').waitFor({state:'visible'});
  assert.equal(await page.locator('.game-tile').count(),0);
  await page.locator('#staticrypt-password').fill('wrong-'+crypto.randomUUID());await page.locator('input[type=submit]').click();await page.getByText('Неверный пароль',{exact:true}).waitFor();
  report.checks.push('Wrong password rejected; app absent before login');
  await page.locator('#staticrypt-password').fill(password);await page.locator('input[type=submit]').click();await page.locator('.game-tile').first().waitFor();
  const expected=JSON.parse(fs.readFileSync(site+'/api/packs/catalog')).packs;
  const ids=await page.locator('.game-tile').evaluateAll(nodes=>nodes.map(n=>n.dataset.game).sort());assert.deepEqual(ids,expected.map(p=>p.id).sort());
  report.checks.push('Inventory matches catalog');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const catalog=await page.evaluate(async()=>await PlayroomRemotePacks.refresh());assert.deepEqual(catalog.packs,expected);
  for(const item of expected){const r=await ctx.request.get(new URL('./api/packs/'+item.url.slice('/api/packs/'.length),url).href);assert.equal(r.status(),200);assert.equal(digest(await r.body()),item.sha256);}
  await page.evaluate(async()=>{const c=PlayroomRemotePacks.current.packs[0];PlayroomPacks.remove(c.id,c.version);await PlayroomRemotePacks.install(c.id,{activate:true});});
  report.checks.push('Catalog refresh, all file hashes, actual pack removal and reinstall');
  await page.reload();await page.locator('.game-tile').first().waitFor();assert.equal(await page.locator('#staticrypt-password').count(),0);
  const state=await ctx.storageState();assert(state.origins.some(o=>o.localStorage.some(i=>i.name.endsWith(':key')&&i.value!==password)));
  const resumed=await browser.newContext({storageState:state}),again=await resumed.newPage();await again.goto(url);await again.locator('.game-tile').first().waitFor();await resumed.close();
  report.checks.push('Remembered key survives reload and new browser context');
  if(!process.env.SITE_URL){
   revision='\n// smoke update revision\n';
   await page.evaluate(async()=>{await (await navigator.serviceWorker.ready).update();});
   await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
   await page.locator('#update-banner').waitFor({state:'visible'});
   await page.evaluate(()=>PlayroomPWA.activateUpdate());
   await page.waitForFunction(async()=>!(await navigator.serviceWorker.getRegistration()).waiting);
   await page.reload();await page.locator('.game-tile').first().waitFor();
   report.checks.push('Waiting worker activated through app coordinator; key retained');
  }
  await ctx.setOffline(true);await page.reload();await page.locator('.game-tile').first().waitFor();
  report.checks.push('Offline navigation decrypts cached encrypted shell without prompting');
  const cacheAudit=await page.evaluate(async()=>{const entries=[];for(const key of await caches.keys())for(const req of await(await caches.open(key)).keys()){const r=await(await caches.open(key)).match(req);if((r.headers.get('content-type')||'').includes('text/html'))entries.push((await r.text()).includes('class="game-tile'));}return entries;});
  assert(cacheAudit.length);assert(cacheAudit.every(x=>!x));assert.deepEqual(report.errors,[]);report.status='passed';
 }finally{if(browser)await browser.close();server.close();fs.writeFileSync(root+'/'+(process.env.SITE_URL?'production':'local')+'-report.json',JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});
