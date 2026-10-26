const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
(async()=>{
 const html=fs.readFileSync(root+'/site/index.html'), password=process.env.PAGES_SMOKE_PASSWORD;
 const server=http.createServer((req,res)=>{if(req.url==='/playroom-preview/'||req.url==='/playroom-preview/index.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}else{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser; const report={checks:[], errors:[]};
 try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{}),args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:591,height:1100}});
 await ctx.addInitScript(()=>localStorage.setItem('playroom.player-profile.v1',JSON.stringify({version:1,id:'pages-test',name:'Тест',createdAt:1,updatedAt:1})));
 const page=await ctx.newPage();
 page.on('pageerror',e=>report.errors.push(e.message));
 const url=process.env.SITE_URL||`http://127.0.0.1:${server.address().port}/playroom-preview/`;
 const response=await ctx.request.get(url);assert.equal(response.status(),200);
 assert.equal(crypto.createHash('sha256').update(await response.body()).digest('hex'),crypto.createHash('sha256').update(html).digest('hex'));
 report.checks.push('Served bytes match encrypted build');
 await page.goto(url); await page.locator('#staticrypt-password').waitFor({state:'visible'});
 assert.equal(await page.locator('.game-tile').count(),0); report.checks.push('Application absent before login');
 const wrongDialog=page.waitForEvent('dialog');
 await page.locator('#staticrypt-password').fill('incorrect-password'); await page.locator('input[type=submit]').click();
 const dialog=await wrongDialog;assert.equal(dialog.message(),'Неверный пароль');await dialog.dismiss();
 assert.equal(await page.locator('.game-tile').count(),0); report.checks.push('Wrong password rejected');
 const start=Date.now();
 await page.locator('#staticrypt-password').fill(password); await page.locator('input[type=submit]').click();
 await page.locator('.game-tile').first().waitFor();
 report.unlockMs=Date.now()-start;
 assert.equal(await page.locator('.game-tile').count(),15); report.checks.push('Correct password opens all 15 games under project subpath');

 await page.locator('[data-start="battleship"]').click();
 await page.locator('[data-command="lobby-start"]').waitFor();
 report.checks.push('Battleship lobby opens');
 await page.reload();await page.locator('#staticrypt-password').waitFor({state:'visible'});
 report.checks.push('Reload requires password; remember disabled');

 await ctx.setOffline(true);
 await page.locator('#staticrypt-password').fill(password);await page.locator('input[type=submit]').click();
 await page.locator('.game-tile').first().waitFor();report.checks.push('Loaded ciphertext decrypts and opens offline');
 assert.deepEqual(report.errors,[]);
 report.status='passed';
 }finally{if(browser)await browser.close();server.close();fs.writeFileSync(root+'/'+(process.env.SITE_URL?'production':'local')+'-report.json',JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});
