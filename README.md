[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/bongekanjing/site-quiet-walrus/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/bongekanjing/site-quiet-walrus/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122).

# site-quiet-walrus

A drop-in faster build for **makefun-site 1.0.0**, the house site generator of the
[site-generator-speed bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`main.ts` is the baseline driver unchanged: it reads `/input/cases.json` and writes
`/output/answers.json`. `solve.js` is replaced with a reimplementation that returns the
same bytes for every page of every site, in about **1.4× less CPU**.

## Run it

    node --experimental-strip-types main.ts

with `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` standing in for `/input` and `/output`.

## What makes it faster

Three changes, none of which touch the output:

1. **Templates compiled to functions.** A site of 500 pages walks ~395,000 template nodes.
   Walking a node tree costs a switch, an object literal and a scope allocation per node;
   the compiled body is straight-line string concatenation with real `for` and `if`
   statements. Includes are expanded into the caller at compile time, so a loop variable
   in `{% for p in posts %}{% include "card" %}{% endfor %}` stays a plain local.
2. **One scope object, no chain walk.** A build's vars are flat, so each compiled render
   takes exactly one object and every other head is a direct property read.
3. **Fewer intermediate strings in Markdown.** Inline emphasis is found by one regex scan
   over the special characters, plain runs are escaped once rather than per character, and
   the word count is a single pass.

## Verified

- Byte-identical output on all 3 practice cases (1,135 files, 7,059,497 chars).
- Byte-identical on 24 generated instances across 8 seeds from the kit's own generator,
  which is also the kit scorer's `cases_passed: 3/3`.
- 3,000 randomized template-shape cases compared against the vendored reference
  (`baseline.build`), include cycles at the depth limit included: 0 mismatches.
- `makefun grade-local --driver process`: `{"cases_passed":3,"cases_total":3,"passed":1}`,
  L1 regrade reproduced byte for byte.

Measured with `process.cpuUsage` across cold process runs, which is what the `cpu_us`
ranking uses: baseline ~2,200 ms, this ~1,530 ms.
