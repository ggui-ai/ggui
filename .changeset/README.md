# Changesets

This directory is used by [changesets](https://github.com/changesets/changesets) to track version bumps and generate changelogs.

## Usage

When you make a change that should be released:

```bash
pnpm changeset
```

This will ask:

1. Which packages changed?
2. Semver bump (patch/minor/major)?
3. Summary of the change

A changeset file is created in `.changeset/`. Commit it with your PR.

## Releasing

When changesets accumulate on `main`, CI creates a "Version Packages" PR that:

- Bumps `package.json` versions
- Updates `CHANGELOG.md` per package
- Removes consumed changeset files

Merging that PR triggers the release.
