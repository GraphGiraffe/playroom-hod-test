"""Prepare a new private release input and rotate its Actions transport secret."""
import argparse, hashlib, json, os, pathlib, secrets, subprocess, tempfile
p=argparse.ArgumentParser();p.add_argument('html',type=pathlib.Path);p.add_argument('--version',required=True);p.add_argument('--repository',required=True);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
key=secrets.token_urlsafe(48)
with tempfile.TemporaryDirectory() as td:
    encrypted=pathlib.Path(td)/'app.enc'
    subprocess.run(['openssl','enc','-aes-256-cbc','-salt','-pbkdf2','-iter','200000','-in',str(a.html.resolve()),'-out',str(encrypted),'-pass','env:SOURCE_BUNDLE_KEY'],env={**os.environ,'SOURCE_BUNDLE_KEY':key},check=True)
    subprocess.run(['gh','secret','set','SOURCE_BUNDLE_KEY','--repo',a.repository],input=key,text=True,check=True)
    (root/'source/app.enc').write_bytes(encrypted.read_bytes())
(root/'source/provenance.json').write_text(json.dumps({'version':a.version,'artifact':a.html.name,'sha256':hashlib.sha256(a.html.read_bytes()).hexdigest()},indent=2)+'\n')
print('Encrypted release input prepared; transport secret stored in Actions')
