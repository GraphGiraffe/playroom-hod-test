'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');const root=path.resolve(__dirname,'..'),site=path.join(root,'site');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const password=process.env.PAGES_SMOKE_PASSWORD;assert(password);let revision='',slowDocuments=false,documentRequests=0;let servedSite=site;
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!pathname.startsWith('/playroom-preview/')){res.writeHead(404);return res.end();}
  const relative=pathname.slice('/playroom-preview/'.length)||'index.html',file=path.resolve(servedSite,relative);
  if(!file.startsWith(servedSite+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  if(relative==='index.html'){documentRequests++;if(slowDocuments)return;}
  res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.html')?'text/html; charset=utf-8':relative.endsWith('.webmanifest')?'application/manifest+json':'application/octet-stream');
  res.end(relative==='sw.js'?fs.readFileSync(file,'utf8')+revision:fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 const report={checks:[],errors:[]};
 try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{}),args:['--no-sandbox']});
  const ctx=await browser.newContext();await ctx.addInitScript(()=>{if(!localStorage.getItem('playroom.player-profile.v1'))localStorage.setItem('playroom.player-profile.v1',JSON.stringify({version:1,id:'pages-test',name:'Тест',createdAt:1,updatedAt:1}));});
  const decryptCounts=new WeakMap();
  await ctx.exposeBinding('__recordDecrypt',({page})=>decryptCounts.set(page,(decryptCounts.get(page)||0)+1));
  await ctx.addInitScript(()=>{const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);crypto.subtle.decrypt=async(...args)=>{await window.__recordDecrypt();return decrypt(...args);};});
  const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  const url=process.env.SITE_URL||`http://127.0.0.1:${server.address().port}/playroom-preview/`;
  const response=await ctx.request.get(url);assert.equal(response.status(),200);assert.equal(digest(await response.body()),digest(fs.readFileSync(site+'/index.html')));
  report.checks.push('Published encrypted bytes match build');
  await page.goto(url);await page.locator('#staticrypt-password').waitFor({state:'visible'});
  assert.equal(await page.locator('.game-tile').count(),0);
  await page.locator('#staticrypt-password').fill('wrong-'+crypto.randomUUID());await page.locator('input[type=submit]').click();await page.getByText('Неверный пароль',{exact:true}).waitFor();
  report.checks.push('Wrong password rejected; app absent before login');
  await page.locator('#staticrypt-password').fill(password);await page.locator('input[type=submit]').click();await page.locator('.game-tile').first().waitFor();
  assert.equal((decryptCounts.get(page)||0),1);
  const expected=JSON.parse(fs.readFileSync(site+'/api/packs/catalog')).packs;
  const ids=await page.locator('.game-tile').evaluateAll(nodes=>nodes.map(n=>n.dataset.game).sort());assert.deepEqual(ids,expected.map(p=>p.id).sort());
  report.checks.push('Inventory matches catalog');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const catalog=await page.evaluate(async()=>await PlayroomRemotePacks.refresh());assert.deepEqual(catalog.packs,expected);
  for(const item of expected){const r=await ctx.request.get(new URL('./api/packs/'+item.url.slice('/api/packs/'.length),url).href);assert.equal(r.status(),200);assert.equal(digest(await r.body()),item.sha256);}
  await page.evaluate(async()=>{const c=PlayroomRemotePacks.current.packs[0];await PlayroomPacks.remove(c.id,c.version);await PlayroomRemotePacks.install(c.id,{activate:true});});
  report.checks.push('Catalog refresh, all file hashes, actual pack removal and reinstall');
  decryptCounts.set(page,0);
  await page.reload();await page.locator('.game-tile').first().waitFor();assert.equal(await page.locator('#staticrypt-password').count(),0);assert.equal((decryptCounts.get(page)||0),0);
  report.checks.push('Reload launches verified plaintext without decryption');
  const forged=await page.evaluate(()=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data.ok);};navigator.serviceWorker.controller.postMessage({kind:'playroom-store-local-shell',html:'<script>invalid</script>'},[channel.port2]);}));assert.equal(forged,false);
  report.checks.push('Worker rejects HTML that does not match build hash');
  const state=await ctx.storageState();assert(state.origins.some(o=>o.localStorage.some(i=>i.name.endsWith(':key')&&i.value!==password)));
  const resumed=await browser.newContext({storageState:state}),again=await resumed.newPage();await again.goto(url);await again.locator('.game-tile').first().waitFor();await resumed.close();
  report.checks.push('Remembered key survives reload and new browser context');
  if(!process.env.SITE_URL){
   const requestsBefore=documentRequests;slowDocuments=true;
   await page.reload({waitUntil:'domcontentloaded',timeout:5000});await page.locator('.game-tile').first().waitFor({timeout:5000});
   assert.equal(documentRequests,requestsBefore);assert.equal((decryptCounts.get(page)||0),0);slowDocuments=false;
   report.checks.push('Slow document network does not delay local launch or request HTML');
   revision='\n// smoke update revision\n';
   await page.evaluate(async()=>{await (await navigator.serviceWorker.ready).update();});
   await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
   await page.locator('.updates-modal').waitFor({state:'visible'});
   await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('[data-command=update-app]').click()]);
   await page.locator('.game-tile').first().waitFor();
   assert.equal((decryptCounts.get(page)||0),0);
   report.checks.push('Same-build worker activation preserves plaintext and remembered key');
   if(process.env.SMOKE_NEXT_SITE){
    servedSite=path.resolve(process.env.SMOKE_NEXT_SITE);revision='';
    await page.evaluate(async()=>{await(await navigator.serviceWorker.ready).update();});
    await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
    await page.locator('[data-command=show-updates]').click();
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('[data-command=update-app]').click()]);
    await page.locator('.game-tile').first().waitFor();
    const expectedHash=JSON.parse(fs.readFileSync(servedSite+'/build-info.json')).localShell.sha256;
    await page.waitForFunction(async hash=>{for(const key of await caches.keys()){const r=await(await caches.open(key)).match('./index.html');if(r?.headers.get('X-Playroom-Local-Shell')===hash)return true;}return false;},expectedHash);
    assert.equal((decryptCounts.get(page)||0),1);
    decryptCounts.set(page,0);
    await page.reload();await page.locator('.game-tile').first().waitFor();assert.equal((decryptCounts.get(page)||0),0);
    report.checks.push('Changed build decrypts once, replaces old shell, then launches without decryption');
   }
  }
  await ctx.setOffline(true);await page.reload();await page.locator('.game-tile').first().waitFor();
  assert.equal((decryptCounts.get(page)||0),0);
  report.checks.push('Offline navigation loads local plaintext without decryption or prompting');
  const cacheAudit=await page.evaluate(async()=>{const entries=[];for(const key of await caches.keys())for(const req of await(await caches.open(key)).keys()){const r=await(await caches.open(key)).match(req);if((r.headers.get('content-type')||'').includes('text/html'))entries.push({key,url:req.url,hash:r.headers.get('X-Playroom-Local-Shell'),bytes:(await r.arrayBuffer()).byteLength});}return entries;});
  const localShell=JSON.parse(fs.readFileSync(servedSite+'/build-info.json')).localShell;
  assert.equal(cacheAudit.length,1);assert.equal(cacheAudit[0].hash,localShell.sha256);assert.equal(cacheAudit[0].bytes,localShell.bytes);
  report.localShellBytes=localShell.bytes;report.encryptedHtmlBytes=fs.statSync(servedSite+'/index.html').size;
  report.checks.push('Exactly one HTML cache entry: verified plaintext replaces ciphertext');
  assert.deepEqual(report.errors,[]);report.status='passed';
 }finally{if(browser)await browser.close();server.close();fs.writeFileSync(root+'/'+(process.env.SITE_URL?'production':'local')+'-report.json',JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});
