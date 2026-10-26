import hashlib, json, os, pathlib, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
os.chdir(root)
password = os.environ.get('PAGES_SMOKE_PASSWORD', '')
assert password, 'Missing PAGES_SMOKE_PASSWORD'
assert os.environ.get('SOURCE_BUNDLE_KEY'), 'Missing SOURCE_BUNDLE_KEY'
meta = json.loads((root/'source/provenance.json').read_text())
site = root/'site'
site.mkdir(exist_ok=True)
assert set(p.name for p in site.iterdir()) <= {'index.html', '.nojekyll'}, 'Unexpected public files'
with tempfile.TemporaryDirectory() as td:
    source = pathlib.Path(td)/'index.html'
    subprocess.run(['openssl','enc','-d','-aes-256-cbc','-pbkdf2','-iter','200000','-in','source/app.enc','-out',str(source),'-pass','env:SOURCE_BUNDLE_KEY'],check=True)
    assert hashlib.sha256(source.read_bytes()).hexdigest()==meta['sha256'], 'Source integrity mismatch'
    subprocess.run([str(root/'node_modules/.bin/staticrypt'),str(source),'-d',str(site),'-c','false','--remember','false','--template-title','PlayRoom','--template-button','Войти','--template-placeholder','Пароль','--template-error','Неверный пароль','--template-instructions','Введите пароль, который вам передал владелец сайта.','--template-color-primary','#366653','--template-color-secondary','#f4f0e5'],env={**os.environ,'STATICRYPT_PASSWORD':password},check=True,stdout=subprocess.DEVNULL)
(site/'.nojekyll').touch()
html=(site/'index.html').read_text()
assert password not in html and 'class="game-tile' not in html
print('Encrypted app',meta['version'],'ready; plaintext was removed')
