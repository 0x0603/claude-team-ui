<!-- Coding standards. Every step can read them as plans/coding-standards.md; the Standards step fixes the diff to them and the
reviews check against them. The retro edits that copy and you adopt it at "You approve the standards change". Edit per
project from the console (⋯ → Edit coding standards). -->
# Coding standards

The repo's own CLAUDE.md, AGENTS.md and CONTRIBUTING come first; this file adds what reviews keep finding.
A rule earns its place by catching something a linter, a type or a test cannot. Each rule says why.

## Rules
1. Reuse before writing: a helper, type or constant the repo already has replaces new code that does the same.
   Spot it: search the repo for the new code's core call or literal.
2. Only what the task needs: no abstraction with one user, no option for a case that does not exist, no new
   dependency where the repo already has one that does the job.
3. Comments say why, in one or two lines, and only when the code cannot. No comments that narrate the change or the issue.
4. Errors are handled where something can be done about them: no empty catch, no catch that logs and carries on as if
   the call worked.
5. No secrets, keys, tokens, URLs with keys or raw upstream error text in logs, in errors sent to clients, or in tests.

## Tests
- Through the public interface: tests call what a caller uses (the exported class, function, route, hook), not private
  helpers, so they survive a refactor that keeps the behaviour.
- Not tautological: a test that sets a value and asserts the same value, or copies the implementation's formula into
  the expectation, proves nothing. Assert a result known independently of the code.
- Not structure-sensitive: no assertions on file layout, private calls, call order or snapshots of internals, unless
  that is the contract.
- Not unfailable: mock only the edges the repo does not own (network, chain, clock, randomness). When every collaborator
  is mocked, the test passes while the real code breaks. Break the code under test once: the test must fail.

## Merge danger
One-way doors, hard to undo (read every line): data schemas and migrations, published package APIs and versions,
anything that moves funds or signs transactions, mass messages, auth and permissions, deploy and secrets configuration.
Two-way doors, easy to undo (a skim is enough): docs, tests, internal refactors behind a tested interface, UI copy.
