# Benchmark targets

| Metric | Target | Conditions | Measured by |
| --- | --- | --- | --- |
| Keystroke to remote render, p99 | under 100 ms | In-VPC, 100 editors on one document | `bench` end-to-end table (`BENCH_EDITORS=100`) |
| Gateway memory per active document | under 50 MB | 100,000 operations of history | `bench` engine table (`BENCH_OPS=100000`) |
| Cold document load, p95 | under 500 ms | 10 MB snapshot | `bench` engine table (Phase 1: dedicated 10 MB dataset) |
| Reconnect storm | 200 clients back within 60 s, no live-edit stall | After a 30-minute partition | Phase 1, k6 |
