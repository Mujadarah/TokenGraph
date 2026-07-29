# Contributing to TokenGraph

Thank you for helping improve TokenGraph. You do not need direct write access to contribute.

## Report a bug or request a feature

- Use a GitHub issue for reproducible bugs, feature proposals, documentation gaps, and questions.
- Use GitHub's private vulnerability reporting instead of a public issue for suspected security vulnerabilities. See [SECURITY.md](SECURITY.md).
- Search existing issues before opening a new one and include the TokenGraph version, host, operating system, expected behavior, actual behavior, and a minimal reproduction when relevant.

## Propose a code or documentation change

1. Fork `Mujadarah/TokenGraph` on GitHub.
2. Create a focused branch in your fork.
3. Make the change. Implementation belongs under `plugins/tokengraph/`; `release/tokengraph/` is generated output.
4. From `plugins/tokengraph/`, run:

   ```text
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm smoke -- --root . --json
   pnpm package:plugin -- --release
   pnpm validate:plugin
   ```

5. Open a pull request against `main` and explain the problem, the solution, and the verification performed.

Pull requests require review and passing checks before merge. Repository protections deliberately prevent external contributors from pushing to upstream branches, deleting branches or tags, or bypassing review; the fork-and-pull-request workflow remains fully available.

## Contribution license

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in TokenGraph is provided under the Apache License 2.0, as described in Section 5 of the license.
