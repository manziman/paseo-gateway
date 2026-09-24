# Repository governance

The JSON files are the desired GitHub rulesets. They are not applied by CI.
After the named checks and CodeQL baseline exist, an administrator can review
and apply them using:

```sh
python3 scripts/repository-settings.py
python3 scripts/repository-settings.py --apply
```

The script updates only matching named rulesets and verifies the saved policy.
Check names must match actual check-run contexts, associated with the GitHub
Actions integration. `main` and `alpha` require PRs with all checks passing,
resolved review threads and a linear squash history. There are no normal bypass
actors. Zero required approvals permits the single maintainer to merge their own
PR after validation; CODEOWNERS still supplies review routing. Tag rules permit
initial creation by the release token, but prohibit updating or deleting `v*` tags.

Also configured through the repository API:

- Squash-only merging with `PR_TITLE` and `PR_BODY`; delete merged branches.
- Vulnerability alerts, automated security fixes and private reporting enabled.
- Actions full-SHA pinning enforced; default token read-only and PR approval disabled.
- Secret scanning and push protection enabled.

Release jobs explicitly grant only needed write scopes. The metadata-only
`pull_request_target` title workflow uses trusted default-branch code and a
read-only token; all contribution builds run on `pull_request` without secrets.
No standing branch-protection bypass is needed for generated version commits,
because publication does not commit them.

First bootstrap is necessarily ordered: land and run the workflows, verify their
actual check names and baseline scans, then enable the rules and verify them on
a disposable PR. After bootstrap, require the same PR path for all changes.
