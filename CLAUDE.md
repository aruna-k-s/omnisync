@AGENTS.md

## Claude Code session loop

1. Start in plan mode. Read the relevant `docs/specs/*.md`; if none exists, run `/spec <feature>` first.
2. Write failing tests first (fast-check properties for invariants), then the code.
3. Keep each change under about 300 lines. Run `pnpm check` before you stop.
4. Ask before touching a protected path listed in AGENTS.md.
5. A fresh session reviews the diff with `/review`.
