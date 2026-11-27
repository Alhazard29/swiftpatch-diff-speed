# swiftpatch-diff-speed

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Alhazard29/swiftpatch-diff-speed/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Alhazard29/swiftpatch-diff-speed/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

Swiftpatch is a drop-in for makefun-diff 1.0.0's `diffPatch({ old, new })`: `solve.js` exports `run(input)` and returns the same patch string, edit for edit, in a fraction of the time. Lines become integers, the Myers search keeps its frontier in one typed array with one byte per step, and cells that provably lie on no shortest script are skipped, which leaves the script makefun-diff picks untouched. `main.ts` reads `cases.json` and writes `answers.json`. Node 22, standard library only, no dependencies, no network.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4zhb3zrh&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
