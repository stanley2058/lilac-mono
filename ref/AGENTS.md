# ref/ (Reference Repos)

This folder contains upstream/reference repos as git submodules.

- These repos are for reading/research only. Do not import/link code from `ref/*`.
- On a fresh clone, submodules are usually not checked out.

## Load On Demand

From the repo root:

```bash
git submodule update --init --recursive ref
```

To load just one repo:

```bash
git submodule update --init --recursive ref/ai
```

## Update To Latest Upstream

This repo pins specific commits in the superproject. To update the pins:

```bash
git submodule update --remote --recursive ref
git add ref
```
