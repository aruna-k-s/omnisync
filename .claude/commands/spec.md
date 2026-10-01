---
description: Write a one-page feature spec in docs/specs before any code
argument-hint: <feature-name>
---

Write `docs/specs/$ARGUMENTS.md` for the feature "$ARGUMENTS". Read AGENTS.md and the existing specs first so names and formats match.

Use exactly these sections, one page total:

1. **Purpose**: one sentence on what it does and who needs it.
2. **Inputs and outputs**: types, wire formats, limits (sizes, rates).
3. **Invariants**: each one phrased so it can become a fast-check property.
4. **Failure modes**: what hostile or broken input looks like and the exact behaviour (typed error, counter, close).
5. **Security notes**: what it trusts, what it verifies, protected paths it touches.
6. **Out of scope**: what waits for a later phase.

Then critique the spec as a hostile reviewer would and list open questions at the end. Do not write code.
