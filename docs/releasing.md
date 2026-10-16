# 0.3.1 patch release 

For `--citation-base` behavior and usage, see [Check a claim](reference.md#check-a-claim).

Installed usage:

```sh
npx --package done-done-axi@0.3.1 done-done check --citation-base /path/to/evidence --from checks.md
npx --package done-done-axi@0.3.1 done-done receipt --citation-base /path/to/evidence --from checks.md
```

Do not publish an unmerged candidate. The existing `release` workflow on main tests and publishes an unpublished package version using npm trusted publishing. After merge, inspect that workflow and `npm view done-done-axi@0.3.1 version dist.integrity` before attempting any manual release. If automation has not published and the release owner explicitly authorizes it, from the exact clean merged candidate run the project tests, `npm run build:skill -- --check`, `npm pack`, then `npm publish --provenance --access public` in the trusted release environment. Inspect any ambiguous result before retrying; do not change npm login.
