# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rismzz/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rismzz/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text files, matching lines at the first of three tiers (exact, trailing-whitespace-insensitive, fully-trimmed with re-indentation) and writing every change or none. Node 22, standard library only, no dependencies.

Practice set: **100/100 checks, score 1000** (`node check.ts <kit>/program/generator/practice.json`: 30 unified, 20 search_replace, 20 v4a, 15 json, 15 cli). 53 additional hand-built edge cases from SPEC.md's sentences (no-newline markers, moves with `R` lines, anchors and cursors, EOF chunks, unsafe paths, atomicity, `--check`/`--strict`/usage errors) also pass. The house baseline is a strict tier-0-only applier, so full three-tier matching is what beats it.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Reads the patch from `PATCH` (or standard input when absent or `-`), prints one line per changed path plus `ok: <n> files`, or the failure lines and `failed: <k> of <n> edits` with exit 1 — and nothing is written when any edit fails. `SPEC.md` is the whole contract; `runner.ts` is the kit's trial runner (`MAKEFUN_ENV_URL`), kept as shipped.

---

<sub>Entered on [make.fun](https://make.fun/?ref=aa4mcy45&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
