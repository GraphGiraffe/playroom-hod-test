# PlayRoom — encrypted GitHub Pages mirror

Site: https://graphgiraffe.github.io/playroom-hod-test/

This is the standalone PlayRoom 0.19.10 build with bundled games and a static update catalog. The application is encrypted with StatiCrypt 3.5.4; the visitor enters the shared password to decrypt it in the browser. Successful login is remembered automatically with no expiry, across reloads, browser restarts and site updates. Keep source/salt.txt unchanged. Existing Cloudflare deployment is unchanged.

## Publish

Run **Actions → Publish encrypted PlayRoom → Run workflow**, branch `main`.
The workflow only builds and publishes: it decrypts the transport bundle in a temporary directory, verifies its input SHA-256, encrypts HTML with `PAGES_SMOKE_PASSWORD` and the stable salt, and uploads only `site/` to Pages. Temporary plaintext is removed before upload. GitHub Actions runs no tests and installs no browser while CI quotas are constrained. Run browser smoke locally with throwaway test secrets; verify public deployment metadata locally after publication. Never retrieve production secrets for testing.

Secrets:
- `PAGES_SMOKE_PASSWORD`: shared visitor password, maintained by owner. Changing it requires running the workflow again. Prefer a unique randomly generated password of 20+ characters.
- `SOURCE_BUNDLE_KEY`: machine-generated transport key for `source/app.enc`. It is independent of the visitor password. Never put either key in Git or logs.

To update the app, from a trusted local checkout with authenticated `gh`:

```sh
npm ci --ignore-scripts
python3 scripts/seal-source.py /path/to/input.zip --version 0.19.10 --repository GraphGiraffe/playroom-hod-test
```

This rotates the transport secret; do not run it while publication is active. Review and commit `source/app.enc` and `source/provenance.json`, push to `main`, then run the workflow. The private source ZIP contains index.html (standalone app), source sw.js, manifest.webmanifest and icons/*. The app URL-mapping port is derived from the GitHub Pages runtime change; original 0.19.10 release artifacts are not replaced. Never add the plaintext HTML to this public repository. Old source commits need their matching transport key, so rollback is performed by resealing the desired original release, not by rerunning old commits after key rotation.

## Scope and limits

PWA manifest/install support, local offline reload without repeated decryption, remembered login and static pack updates are included. Mobile installation and real cross-device RTC on this origin require user acceptance; they are not proven by desktop smoke. Saves/settings belong to this origin and are not automatically imported from Cloudflare.

Canonical build/test/login helpers live in [utils](https://github.com/GraphGiraffe/boardgame-playroom-utils/tree/main/tools/github-pages). Export with `sync.py SITE`; check with `--check`. Do not edit exported helpers independently. Tool hashes are recorded in scripts/tool-provenance.json. Catalog updates use utils import-packs.py with verified release SHA256SUMS. Existing hashed files remain available. One Pages snapshot includes both shell and catalog; pack-only updates do not require a new app source bundle.

Encryption prevents opening the app without its password, but a password holder can save or share the decrypted app; downloaded copies cannot be revoked. Ciphertext is public and permits offline password guessing. The published Pages artifact is encrypted; source HTML, keys, browser storage and decrypted pages must never be uploaded as CI artifacts.

## Repository policy

This repository is a distribution mirror. Initial bootstrap is on `main`; subsequent code/tooling changes use task branches and reviewed PRs into `main`. Publication is manual only, with one workflow and one Pages concurrency group. No automatic push/PR deploys. Local-only checks: Python syntax, Node syntax, `git diff --check`, artifact browser smoke, then published-site smoke. Failed verification must be investigated; do not report a successful site solely because the deployment step passed.

[StatiCrypt](https://github.com/robinmoisson/staticrypt) · [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

After first login, the worker verifies the decrypted HTML against the build SHA-256 and replaces the encrypted HTML cache entry under the same key. Installed navigation is cache-first and does not wait for the network. The public deployment remains encrypted; the browser-local copy is intentionally unencrypted. New builds decrypt once using the remembered key. If persistence fails, login still works and later visits can retry.


## License / Лицензирование

Собственный код — **PolyForm Noncommercial 1.0.0**; собственные обычные арты, звуки и документация — **CC BY-NC-SA 4.0**. Стихийная потасовка имеет отдельные **PolyForm Strict / CC BY-NC-ND** условия. Сторонние материалы сохраняют свои лицензии. Области действия и исключения: [LICENSING.md](LICENSING.md); стандартные тексты: [LICENSE](LICENSE), [LICENSES](LICENSES/).


PlayRoom 0.19.10 uses the stable PWA manifest identity `/playroom`; the gate preserves a real Chrome installation invitation received before login. Existing shared-ID installations are not automatically migrated by this release. User data is not cleared. Standard license files from the release input are published alongside the encrypted shell.
