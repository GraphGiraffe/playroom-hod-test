'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium,devices}=require('playwright-core');
const previewPath='/playroom-hod-test/api/packs/preview/kalyakodil/',mount='api/packs/preview/kalyakodil';
const root=path.resolve(__dirname,'..'),prefix='playroom-preview:kalyakodil:v1:',checks=[],errors=[];
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const password=process.env.PAGES_SMOKE_PASSWORD;assert(password,'PAGES_SMOKE_PASSWORD is required');
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/production/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><title>Storage sentinel</title>');}
  if(url.pathname===previewPath+'storage-check.html'){res.setHeader('content-type','text/html');return res.end('<!doctype html><head><script>'+fs.readFileSync(root+'/previews/kalyakodil/storage.js','utf8')+'</script></head>');}
  if(!url.pathname.startsWith('/playroom-hod-test/')){res.writeHead(404);return res.end();}
  const relative=url.pathname.slice('/playroom-hod-test/'.length)+(url.pathname.endsWith('/')?'index.html':''),file=path.resolve(root,'site',relative);
  if(!file.startsWith(root+'/site/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.png')?'image/png':file.endsWith('catalog')?'application/json':'application/octet-stream');res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
  const context=await browser.newContext(process.env.PREVIEW_PHONE?devices['Pixel 7']:{viewport:{width:1000,height:850}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const base=`http://127.0.0.1:${server.address().port}`,local=base+previewPath;
  await page.goto(base+'/production/');await page.evaluate(async()=>{
   localStorage.setItem('preview-sentinel','keep');sessionStorage.setItem('preview-sentinel','keep');
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('playroom.data.v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('sentinel');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const t=db.transaction('sentinel','readwrite');t.objectStore('sentinel').put('keep','key');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
   await(await caches.open('playroom-pages-/production/-sentinel')).put('/production/sentinel',new Response('keep'));
  });
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.register('/playroom-hod-test/sw.js',{scope:'/playroom-hod-test/'});if(!registration.active)await new Promise((resolve,reject)=>{const worker=registration.installing||registration.waiting;const check=()=>worker.state==='activated'?resolve():worker.state==='redundant'?reject(Error('PARENT_WORKER_FAILED')):null;worker.addEventListener('statechange',check);check();});});
  await page.goto(base+'/playroom-hod-test/probe.html');await page.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL.endsWith('/playroom-hod-test/sw.js'));checks.push('Actual existing production worker is installed and controls the parent site');
  await page.goto(local+'storage-check.html');await page.evaluate(async()=>{
   if(localStorage.getItem('preview-sentinel')!==null||sessionStorage.getItem('preview-sentinel')!==null)throw Error('STORAGE_LEAK');
   localStorage.setItem('preview-own','remove');localStorage.clear();sessionStorage.clear();
   const r=indexedDB.open('playroom.data.v1',1);await new Promise((resolve,reject)=>{r.onupgradeneeded=()=>r.result.createObjectStore('preview');r.onsuccess=()=>{if(!r.result.objectStoreNames.contains('preview'))return reject(Error('IDB_LEAK'));r.result.close();resolve();};r.onerror=()=>reject(r.error);});
   await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('playroom.data.v1');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});
   if((await caches.keys()).some(k=>k.includes('/production/')))throw Error('CACHE_LEAK');await caches.delete('playroom-pages-/production/-sentinel');
  });
  await page.goto(base+'/production/');assert.deepEqual(await page.evaluate(async()=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open('playroom.data.v1');r.onsuccess=()=>resolve(r.result);});const record=await new Promise(resolve=>{db.transaction('sentinel').objectStore('sentinel').get('key').onsuccess=e=>resolve(e.target.result);});db.close();
   return [localStorage.getItem('preview-sentinel'),sessionStorage.getItem('preview-sentinel'),record,await(await(await caches.open('playroom-pages-/production/-sentinel')).match('/production/sentinel')).text()];
  }),['keep','keep','keep','keep']);checks.push('Preview storage clear/delete leaves same-origin production local/session/IDB/cache sentinels unchanged');
  await context.addInitScript(()=>{let Constructor;window.__previewDataStarts=0;Object.defineProperty(window,'PlayroomDataStorage',{configurable:true,get:()=>Constructor,set:value=>{Constructor=class extends value{constructor(...args){super(...args);window.__previewDataStarts++;}};}});});
  await context.addInitScript(({prefix})=>{localStorage.setItem(prefix+'playroom.player-profile.v1',JSON.stringify({version:1,id:'preview-check',name:'Тест',createdAt:1,updatedAt:1}));},{prefix});
  const url=process.env.SITE_URL||local;
  await page.goto(url);await page.locator('#staticrypt-password').waitFor();await page.locator('#staticrypt-password').fill('wrong-password');await page.locator('input[type=submit]').click();await page.getByText('Неверный пароль',{exact:true}).waitFor();
  await page.locator('#staticrypt-password').fill(password);await page.evaluate(()=>{const form=document.querySelector('form');form.requestSubmit();form.requestSubmit();});await page.waitForFunction(()=>!!globalThis.PlayroomAppBridge);
  assert.equal(await page.evaluate(()=>window.__previewDataStarts),1,'one login must initialize the application once');checks.push('Repeated password submit initializes only one application/data store');
  checks.push('Password gate rejects wrong password and opens the normal isolated SDK app');
  if(await page.locator('.packs-empty-hub').count()){
   await page.locator('.packs-empty-hub [data-command=packs]').click();await page.locator('[data-pack-install-all]').click();await page.locator('[data-pack-install-all]').filter({hasText:'Все игры установлены'}).waitFor({timeout:90000});await page.locator('.pack-manager-modal .modal-head [data-command=close-modal]').click();
  }
  const expected=JSON.parse(fs.readFileSync(root+'/site/'+mount+'/api/packs/catalog')).packs;assert.deepEqual(expected.map(p=>p.id).sort(),['kalyakodil-a','kalyakodil-b','kalyakodil-c']);
  await page.locator('.game-tile').first().waitFor();assert.deepEqual(await page.locator('.game-tile').evaluateAll(nodes=>nodes.map(n=>n.dataset.game).sort()),expected.map(p=>p.id).sort());
  for(const item of expected){const response=await context.request.get(new URL('./api/packs/'+item.url.slice('/api/packs/'.length),url).href);assert.equal(response.status(),200);assert.equal(digest(await response.body()),item.sha256);}
  checks.push('All three candidates install through the native catalog; IDs and published pack SHA256 match');
  for(const item of expected){await page.evaluate(()=>PlayroomAppBridge.showHub());await page.locator('[data-start="'+item.id+'"]').click();await page.locator('[data-game-mode=hotseat]').click();await page.locator('.room-v021').waitFor();assert.equal(await page.evaluate(()=>PlayroomAppBridge.room().game.id),item.id);await page.locator('[data-command=lobby-start]').click();await page.waitForFunction(()=>!!PlayroomAppBridge.activity(),null,{timeout:15000});checks.push(item.id+' native local lobby and game start');}
  const restores=await page.evaluate(()=>{const library=new PlayroomLibrary(()=>PlayroomData,TabletopCore,TabletopSession,PlayroomPacks);return library.list().map(row=>{const session=library.open(row.id);return {id:session.game,mode:session.options.mode};});});assert.deepEqual(restores.map(s=>s.id).sort(),expected.map(s=>s.id).sort());assert(restores.every(s=>s.mode==='pass'));checks.push('All three saved native parties restore with their original transport mode');
  await page.evaluate(()=>PlayroomAppBridge.showHub());await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller.scriptURL),url+'sw.js');
  await page.reload();await page.locator('.game-tile').first().waitFor();assert.equal(await page.locator('#staticrypt-password').count(),0);assert.equal(await page.locator('.recovery-note').count(),0,'restore must not show a recovery warning');
  await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.locator('.game-tile').first().waitFor();assert.equal(await page.locator('.game-tile').count(),3);checks.push('Unlocked PWA reload and offline startup retain all three candidates');await context.setOffline(false);
  const manifest=await(await context.request.get(new URL('./manifest.webmanifest',url).href)).json();assert.equal(manifest.id,previewPath.slice(0,-1));assert(!manifest.protocol_handlers?.length);checks.push('Separate PWA identity and no replacement production protocol handler');
  assert.deepEqual(errors,[]);const out=root+'/.private/preview-checks';fs.mkdirSync(out,{recursive:true});await page.screenshot({path:out+'/catalog.png',fullPage:true});fs.writeFileSync(out+'/result.json',JSON.stringify({status:'passed',checks},null,2));console.log(JSON.stringify({status:'passed',checks}));await context.close();
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
