"""Build an encrypted static PWA; publish ciphertext, cache unlocked HTML only on the user device."""
import hashlib, json, os, pathlib, re, shutil, subprocess, tempfile, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
os.chdir(root)
password = os.environ.get('PAGES_SMOKE_PASSWORD', '')
assert password and os.environ.get('SOURCE_BUNDLE_KEY'), 'Missing build secret'
meta = json.loads((root/'source/provenance.json').read_text())
site = root/'site'
if site.exists(): shutil.rmtree(site)
site.mkdir()
with tempfile.TemporaryDirectory() as td:
    archive = pathlib.Path(td)/'input.zip'
    subprocess.run(['openssl','enc','-d','-aes-256-cbc','-pbkdf2','-iter','200000','-in','source/app.enc','-out',str(archive),'-pass','env:SOURCE_BUNDLE_KEY'],check=True)
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==meta['sha256'], 'Source integrity mismatch'
    with zipfile.ZipFile(archive) as z:
        document=z.read('index.html').decode()
        worker=z.read('sw.js').decode()
        for name in z.namelist():
            if name in {'manifest.webmanifest','LICENSE','LICENSING.md','COPYRIGHT'} or re.fullmatch(r'(?:icons/[A-Za-z0-9_.-]+|LICENSES/[A-Za-z0-9_.-]+)',name):
                dest=site/name;dest.parent.mkdir(exist_ok=True);dest.write_bytes(z.read(name))
    deployment='<script>globalThis.PlayroomDeployment={catalogBasePath:new URL("./api/packs/",location.href).pathname};</script>'
    document=document.replace('<head>','<head>'+deployment+'<link rel="manifest" href="./manifest.webmanifest">',1)
    plain_hash=hashlib.sha256(document.encode()).hexdigest()
    plain_size=len(document.encode())
    source=pathlib.Path(td)/'index.html';source.write_text(document)
    subprocess.run([str(root/'node_modules/.bin/staticrypt'),str(source),'-d',str(site),'-c','false','--salt',(root/'source/salt.txt').read_text().strip(),'--remember','0','--template',str(root/'scripts/password-template.html'),'--template-title','ХОД','--template-button','Войти','--template-placeholder','Пароль','--template-error','Неверный пароль','--template-instructions','Настольные игры для своей компании. Введите пароль — на этом устройстве вход сохранится.'],env={**os.environ,'STATICRYPT_PASSWORD':password},check=True,stdout=subprocess.DEVNULL)
shutil.copytree(root/'public',site,dirs_exist_ok=True)
(site/'.nojekyll').touch()
html=(site/'index.html').read_text()
assert password not in html and 'class="game-tile' not in html
# The existing worker owns update coordination. Only shell inventory and scope change.
paths=['./index.html','./manifest.webmanifest']+['./'+p.relative_to(site).as_posix() for p in sorted((site/'icons').iterdir())]
hashes={p:hashlib.sha256((site/p[2:]).read_bytes()).hexdigest() for p in paths}
identity=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()[:16]
worker=re.sub(r"const CACHE='[^']+';", "const CACHE='playroom-pages-'+new URL('./',self.location.href).pathname+'-"+identity+"';",worker,count=1)
worker=worker.replace('const INTEGRITY=null;', 'const INTEGRITY='+json.dumps(hashes)+';')
worker=re.sub(r'const CORE=\[.*?\];','const CORE='+json.dumps(paths)+';',worker,count=1,flags=re.S)
worker=worker.replace("key.startsWith('playroom-pwa-')", "key.startsWith('playroom-pages-'+new URL('./',self.location.href).pathname+'-')")
worker=worker.replace("url.pathname.startsWith('/api/packs/')", "url.pathname.startsWith(new URL('./api/packs/',self.location.href).pathname)")
# Do not retain random same-origin URLs in the shell cache.
worker=worker.replace("  if(event.request.mode==='navigate'){", "  if(event.request.mode!=='navigate'&&!CORE.some(p=>new URL(p,self.location.href).href===url.href))return;\n  if(event.request.mode==='navigate'){")
# Prefer the installed shell immediately, even if the network hangs. Worker update
# discovery remains independent; a waiting build never serves over the active one.
needle="      try{const response=await fetch(event.request);"
assert needle in worker, 'Navigation integration point changed'
if "if(local)return local;" not in worker: worker=worker.replace(needle,"      const local=await (await caches.open(CACHE)).match('./index.html');if(local)return local;\n"+needle,1)
needle="    await Promise.all(entries.map(([path,response])=>cache.put(path,response)));"
assert needle in worker, 'Install integration point changed'
worker=worker.replace(needle,"    await Promise.all(entries.map(async([path,response])=>{if(path==='./index.html'&&isUnlockedShell(await cache.match(path)))return;await cache.put(path,response);}));",1)
worker+='\n'+(root/'scripts/local-shell-worker.js').read_text().replace('__LOCAL_SHELL_HASH__',plain_hash)
(site/'sw.js').write_text(worker)
(site/'build-info.json').write_text(json.dumps({'app':meta,'shell':identity,'localShell':{'sha256':plain_hash,'bytes':plain_size},'packs':json.loads((site/'api/packs/catalog').read_text())},ensure_ascii=False))
print('Encrypted PWA ready:',meta['version'],identity)
