---
description: Second-pass security and quality review of the current diff
---

Review the current branch against `main` (`git diff main...HEAD`) as a skeptical senior reviewer who did not write it. Read AGENTS.md first.

Check, and cite file:line for every finding:

- Authorization and verification on every route and frame type; nothing unsigned reaches a document.
- Replay, size and rate limits on every input path.
- No secrets, keys or payloads in logs or error messages.
- Hostile input never throws past a boundary; every failure is typed and counted.
- Constant-time comparison wherever secrets or MACs are compared.
- Tests: does a property test cover each invariant in the spec? Is anything only tested on the happy path?
- Protected paths touched? Flag them for human review after a 24-hour gap.
- Diff size over ~300 lines? Suggest how to split.

Output a ranked list: blocking, should-fix, nit. Do not edit files.
