# Repository rulesets

This directory contains [GitHub repository ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets) definitions for `jcjc-dev/copillm`. They are version-controlled so the policy is reviewable, diff-able, and recreatable.

## Files

| File | Protects | What it enforces |
|---|---|---|
| `main.json` | `~DEFAULT_BRANCH` (i.e. `main`) | Direct pushes to `main` blocked. Force-pushes blocked. Branch deletion blocked. All changes must go through a PR. Required approvals: 0 (solo workflow), but PR is mandatory so merges are explicit. |

## Apply a ruleset

Requires either:
- A public repo, **or**
- GitHub Pro (or higher) for a private repo, **or**
- A repo owned by a GitHub organization (free orgs get rulesets on private repos)

Once one of those is true:

```bash
gh api --method POST /repos/jcjc-dev/copillm/rulesets \
  --input .github/rulesets/main.json
```

To update an existing ruleset (find its id via `gh api /repos/jcjc-dev/copillm/rulesets`):

```bash
gh api --method PUT /repos/jcjc-dev/copillm/rulesets/<RULESET_ID> \
  --input .github/rulesets/main.json
```

To list active rulesets:

```bash
gh api /repos/jcjc-dev/copillm/rulesets
```

## Why ruleset and not classic branch protection

Classic branch protection (`/repos/{owner}/{repo}/branches/{branch}/protection`) and rulesets (`/repos/{owner}/{repo}/rulesets`) cover the same ground for our needs. Rulesets are GitHub's newer, recommended system and have a single API surface that works for both branches and tags. We use them here for forward-compatibility.

## Bypass

`bypass_actors` is intentionally empty. The repo owner can still bypass via the GitHub UI ("Bypass merge requirements") but only by clicking through an explicit confirmation. To allow specific users/teams/apps to bypass without confirmation, add entries to `bypass_actors`.
