---
description: Run the benchmark harness and compare against the spec targets
argument-hint: [BENCH_OPS=n BENCH_ENGINES=a,b]
---

Run `pnpm build` then `$ARGUMENTS pnpm bench`. Read the newest file in `bench/results/`.

Compare against the targets in `docs/specs/benchmarks.md` and report a table: metric, target, measured per engine, pass or fail. Call out regressions against the previous results file if one exists. Do not change code; if a target fails, propose the next experiment in one paragraph.
