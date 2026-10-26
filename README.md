# PlayRoom — encrypted GitHub Pages mirror

Site: https://graphgiraffe.github.io/playroom-hod-test/

This is the standalone PlayRoom 0.19.5 build with 15 bundled games. The application is encrypted with StatiCrypt 3.5.4; the visitor enters the shared password to decrypt it in the browser. Refresh requires the password again. Existing Cloudflare deployment is unchanged.

## Publish

Run **Actions → Publish encrypted PlayRoom → Run workflow**, branch `main`.
The workflow decrypts the transport bundle in a temporary directory, verifies its SHA-256, encrypts the entire HTML with `PAGES_SMOKE_PASSWORD`, tests it, and uploads only `site/` to Pages. The temporary plaintext is removed before upload. After deployment the test verifies exact served bytes, wrong-password rejection, correct login, 15 game tiles, Battleship lobby, reload protection and decryption of the already-loaded page while offline. Reports contain no passwords or screenshots of the application.

Secrets:
- `PAGES_SMOKE_PASSWORD`: shared visitor password, maintained by owner. Changing it requires running the workflow again. Prefer a unique randomly generated password of 20+ characters.
- `SOURCE_BUNDLE_KEY`: machine-generated transport key for `source/app.enc`. It is independent of the visitor password. Never put either key in Git or logs.

To update the app, from a trusted local checkout with authenticated `gh`:

```sh
npm ci --ignore-scripts
python3 scripts/seal-source.py /path/to/playroom-all-games.html --version 0.19.5
```

This rotates the transport secret; do not run it while publication is active. Review and commit `source/app.enc` and `source/provenance.json`, push to `main`, then run the workflow. The source bundle must be an approved standalone release. Never add the plaintext HTML to this public repository. Old source commits need their matching transport key, so rollback is performed by resealing the desired original release, not by rerunning old commits after key rotation.

## Scope and limits

This is an encrypted standalone mirror, not full parity with the Cloudflare PWA. Automatic remote pack catalog updates, PWA installation/offline reload and network play on this new origin still need integration/acceptance. Loaded HTML can decrypt offline, which does not mean a fresh offline navigation will work. Game saves/settings belong to this origin and are not automatically imported from Cloudflare.

Encryption prevents opening the app without its password, but a password holder can save or share the decrypted app; downloaded copies cannot be revoked. Ciphertext is public and permits offline password guessing. The published Pages artifact is encrypted; source HTML, keys, browser storage and decrypted pages must never be uploaded as CI artifacts.

## Repository policy

This repository is a distribution mirror. Initial bootstrap is on `main`; subsequent code/tooling changes use task branches and reviewed PRs into `main`. Publication is manual only, with one workflow and one Pages concurrency group. No automatic push/PR deploys. Focused checks: Python syntax, Node syntax, `git diff --check`, artifact browser smoke, then published-site smoke. Failed verification must be investigated; do not report a successful site solely because the deployment step passed.

[StatiCrypt](https://github.com/robinmoisson/staticrypt) · [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
