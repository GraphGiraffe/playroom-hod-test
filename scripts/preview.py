"""Prepare and publish-profile builds without replacing the stable site's bytes.

No dispatch is implicit. seal is the sole command that writes a GitHub secret.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value:
        raise ValueError('Invalid relative path')
    if any(not part or part in ('.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in value.split('/')):
        raise ValueError('Invalid relative path')
    return value


def profile_at(site, name):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', name):
        raise ValueError('Invalid preview profile')
    return site / 'previews' / name


def load_profile(site, name):
    profile = profile_at(site, name)
    data = json.loads((profile / 'profile.json').read_text())
    mount = relative(data['mount'])
    if not mount.startswith('api/packs/preview/'):
        raise ValueError('Preview mount must use the existing parent-worker bypass')
    return profile, data


def baseline_at(path):
    value = json.loads(Path(path).read_text())
    base = urllib.parse.urlsplit(value['baseUrl'])
    if base.scheme != 'https' or base.query or base.fragment or not base.path.endswith('/'):
        raise ValueError('Expected an explicit HTTPS site base')
    if not value.get('files'):
        raise ValueError('Empty baseline')
    for name, sha in value['files'].items():
        relative(name)
        if not re.fullmatch('[a-f0-9]{64}', sha):
            raise ValueError('Invalid baseline hash')
    return value


def fetch_base(manifest, output):
    data = baseline_at(manifest)
    output = Path(output).resolve()
    if output == Path('/') or (output / '.git').exists():
        raise ValueError('Output must be a build directory')
    output.mkdir(parents=True, exist_ok=True)
    def fetch(item):
        name, sha = item
        url = urllib.parse.urljoin(data['baseUrl'], urllib.parse.quote(name, safe='/.-_'))
        error = None
        for attempt in range(2):
            try:
                request = urllib.request.Request(url + ('?preview-baseline=' + sha if attempt else ''), headers={'User-Agent': 'PlayRoom-preview-baseline'})
                with urllib.request.urlopen(request, timeout=40) as response:
                    raw = response.read()
                if digest(raw) != sha:
                    raise ValueError('Published baseline differs: ' + name)
                target = output / name
                if target.is_symlink():
                    raise ValueError('Symlink in build directory')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                return name
            except (OSError, ValueError) as exc:
                error = exc
        raise error
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        names = list(pool.map(fetch, data['files'].items()))
    return {'status': 'passed', 'baselineFiles': len(names), 'output': str(output)}


def verify(site, name, output):
    profile, config = load_profile(site, name)
    baseline = baseline_at(profile / 'baseline.json')
    mount = config['mount'] + '/'
    actual = {p.relative_to(output).as_posix(): digest(p.read_bytes()) for p in output.rglob('*') if p.is_file()}
    for file, sha in baseline['files'].items():
        if actual.get(file) != sha:
            raise ValueError('Stable file changed or missing: ' + file)
    if any(file not in baseline['files'] and not file.startswith(mount) for file in actual):
        raise ValueError('Unexpected output outside the selected preview')
    worker = (output / 'sw.js').read_text()
    if "url.pathname.startsWith(new URL('./api/packs/',self.location.href).pathname)" not in worker:
        raise ValueError('Parent worker bypass requires review')
    preview = output / config['mount']
    catalog = json.loads((preview / 'api/packs/catalog').read_text())['packs']
    if sorted(row['id'] for row in catalog) != sorted(config['packIds']):
        raise ValueError('Preview inventory mismatch')
    for row in catalog:
        file = relative(row['url'].removeprefix('/api/packs/'))
        raw = (preview / 'api/packs' / file).read_bytes()
        if len(raw) != row['byteSize'] or digest(raw) != row['sha256']:
            raise ValueError('Preview pack integrity mismatch')
    return {'status': 'passed', 'stableFilesUnchanged': len(baseline['files']), 'previewIds': config['packIds'], 'previewFiles': sum(file.startswith(mount) for file in actual)}


def build(site, name, output):
    profile, config = load_profile(site, name)
    output = Path(output).resolve()
    if output != site / 'site' / config['mount']:
        raise ValueError('Output must be the selected preview inside the site build directory')
    with tempfile.TemporaryDirectory(prefix='playroom-preview-') as folder:
        stage = Path(folder)
        shutil.copytree(profile / 'source', stage / 'source')
        shutil.copytree(profile / 'public', stage / 'public')
        (stage / 'scripts').mkdir()
        for file in ('build.py', 'password-template.html', 'local-shell-worker.js'):
            shutil.copyfile(site / 'scripts' / file, stage / 'scripts' / file)
        template = stage / 'scripts/password-template.html'
        bootstrap = (profile / 'storage.js').read_text()
        if '</script' in bootstrap.lower():
            raise ValueError('Invalid bootstrap')
        template.write_text(template.read_text().replace('<head>', '<head><script>' + bootstrap + '</script>', 1))
        (stage / 'node_modules').symlink_to(site / 'node_modules', target_is_directory=True)
        subprocess.run([sys.executable, str(stage / 'scripts/build.py')], cwd=stage, check=True)
        if output.exists():
            shutil.rmtree(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage / 'site', output)
    return {'status': 'built', 'output': str(output)}


def prepare(site, name, app, packs, baseline, output, app_commit, pack_commit):
    # This command runs from canonical utils; distribution builds use stdlib only.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from playroom_utils.pack_catalog import checked_assets, catalog_entry
    if any(not re.fullmatch('[a-f0-9]{40}', sha) for sha in (app_commit, pack_commit)):
        raise ValueError('Exact app and pack commit SHAs are required')
    profile = profile_at(site, name)
    if profile.exists():
        raise ValueError('Profile already exists; review its update explicitly')
    snapshot = baseline_at(baseline)
    mount = 'api/packs/preview/' + name
    path = urllib.parse.urlsplit(snapshot['baseUrl']).path + mount + '/'
    namespace = 'playroom-preview:' + name + ':v1:'
    bootstrap = Path(__file__).with_name('preview-storage.js').read_text().replace('__PREVIEW_NAMESPACE__', namespace).replace('__PREVIEW_PATH__', path)
    sums = {}
    for line in (app / 'SHA256SUMS').read_text().splitlines():
        sha, file = line.split(None, 1)
        sums[file.strip()] = sha
    contents = {}
    for file in ('playroom.html', 'playroom-pwa.zip'):
        raw = (app / file).read_bytes()
        if digest(raw) != sums.get(file):
            raise ValueError('App build checksum mismatch')
        contents[file] = raw
    assets = checked_assets(packs)
    profile.mkdir(parents=True)
    public = profile / 'public/api/packs'
    public.mkdir(parents=True)
    rows = []
    for ident, (file, manifest, sha) in assets.items():
        row = catalog_entry(manifest, sha, file.stat().st_size)
        dest = profile / 'public' / row['url'].lstrip('/')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(file.read_bytes())
        rows.append(row)
    collection = json.loads((packs / 'SOURCE-PROVENANCE.json').read_text())['version']
    (public / 'catalog').write_text(json.dumps({'format': 'playroom-catalog', 'version': 1, 'collection': collection, 'packs': rows}, ensure_ascii=False))
    source = profile / 'source'
    source.mkdir()
    (source / 'salt.txt').write_text(secrets.token_hex(16) + '\n')
    (profile / 'storage.js').write_text(bootstrap)
    shutil.copyfile(baseline, profile / 'baseline.json')
    config = {'mount': mount, 'packIds': sorted(assets), 'namespace': namespace, 'manifestId': path.rstrip('/'), 'sourceSecret': 'PREVIEW_' + name.upper().replace('-', '_') + '_SOURCE_KEY'}
    (profile / 'profile.json').write_text(json.dumps(config, indent=2) + '\n')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(contents['playroom-pwa.zip'])) as bundle, zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        document = contents['playroom.html'].decode()
        if '<head>' not in document or '__PREVIEW_' in bootstrap:
            raise ValueError('Missing preview integration point')
        version = json.JSONDecoder().raw_decode(document.split('globalThis.PlayroomAppVersion = ', 1)[1])[0]
        document = document.replace('<head>', '<head><script>' + bootstrap + '</script>', 1)
        archive.writestr('index.html', document)
        for file in bundle.namelist():
            file = file.removeprefix('playroom-pwa/')
            if file == 'manifest.webmanifest':
                manifest = json.loads(bundle.read('playroom-pwa/' + file))
                manifest.update(id=config['manifestId'], name='ХОД · ' + name + ' preview', short_name='ХОД preview')
                manifest.pop('protocol_handlers', None)
                for related in manifest.get('related_applications', []):
                    related['id'] = config['manifestId']
                archive.writestr(file, json.dumps(manifest, ensure_ascii=False))
            elif file in ('sw.js', 'LICENSE', 'LICENSING.md', 'COPYRIGHT', 'platform/web/push-worker.js') or re.fullmatch(r'(?:icons|LICENSES)/[A-Za-z0-9_.-]+', file):
                archive.writestr(file, bundle.read('playroom-pwa/' + file))
    metadata = {'version': version, 'artifact': output.name, 'sha256': digest(output.read_bytes()), 'appCommit': app_commit, 'packCommit': pack_commit, 'packIds': sorted(assets), 'ownerAccepted': False}
    (source / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return {'status': 'prepared', 'profile': str(profile), 'privateInput': str(output), 'packIds': sorted(assets)}


def seal(site, name, archive, repository, offline=False):
    profile, config = load_profile(site, name)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Explicit repository required')
    if config['sourceSecret'] != 'PREVIEW_' + name.upper().replace('-', '_') + '_SOURCE_KEY':
        raise ValueError('Only this profile-specific preview secret may be changed')
    if not offline:
        remote = subprocess.check_output(['git', 'remote', 'get-url', 'origin'], cwd=site, text=True).strip().removesuffix('.git')
        remote = remote.removeprefix('https://github.com/').removeprefix('git@github.com:')
        if remote.lower() != repository.lower():
            raise ValueError('Repository differs from the selected site origin')
    meta = json.loads((profile / 'source/provenance.json').read_text())
    if digest(archive.read_bytes()) != meta['sha256']:
        raise ValueError('Prepared input changed')
    key = os.environ.get('SOURCE_BUNDLE_KEY') if offline else secrets.token_urlsafe(48)
    if not key:
        raise ValueError('Offline sealing requires a throwaway SOURCE_BUNDLE_KEY')
    subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-in', str(archive), '-out', str(profile / 'source/app.enc'), '-pass', 'env:SOURCE_BUNDLE_KEY'], env={**os.environ, 'SOURCE_BUNDLE_KEY': key}, check=True)
    if not offline:
        subprocess.run(['gh', 'secret', 'set', config['sourceSecret'], '--repo', repository], input=key, text=True, check=True)
    return {'status': 'sealed', 'repository': repository, 'secret': config['sourceSecret'], 'offline': offline}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='command', required=True)
    for command in ('prepare', 'build', 'seal', 'verify', 'inspect'):
        sub = subs.add_parser(command)
        sub.add_argument('--site', type=Path, required=True)
        sub.add_argument('--profile', required=True)
        if command in ('prepare', 'build', 'verify'):
            sub.add_argument('--output', type=Path, required=True)
        if command == 'prepare':
            for option in ('app-build', 'pack-build', 'baseline'):
                sub.add_argument('--' + option, type=Path, required=True)
            for option in ('app-commit', 'pack-commit'):
                sub.add_argument('--' + option, required=True)
        if command == 'seal':
            sub.add_argument('--input', type=Path, required=True)
            sub.add_argument('--repository', required=True)
            sub.add_argument('--offline', action='store_true')
    sub = subs.add_parser('fetch-base')
    sub.add_argument('--baseline', type=Path, required=True)
    sub.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'fetch-base':
        result = fetch_base(args.baseline, args.output)
    else:
        site = args.site.resolve()
        if args.command == 'prepare':
            result = prepare(site, args.profile, args.app_build.resolve(), args.pack_build.resolve(), args.baseline.resolve(), args.output.resolve(), args.app_commit, args.pack_commit)
        elif args.command == 'seal':
            result = seal(site, args.profile, args.input.resolve(), args.repository, args.offline)
        elif args.command == 'build':
            result = build(site, args.profile, args.output)
        elif args.command == 'verify':
            result = verify(site, args.profile, args.output.resolve())
        else:
            profile, config = load_profile(site, args.profile)
            result = {'status': 'inspected', **config, 'source': json.loads((profile / 'source/provenance.json').read_text())}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
