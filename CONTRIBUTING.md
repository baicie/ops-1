# Contributing

1. Read `docs/blueprint/AGENTS.md`, `docs/blueprint/rules/` and the relevant ADR before changing contracts, permissions, storage or deployment semantics.
2. Contract changes go through `contracts/` and a compatibility check first. Do not hand-edit generated clients.
3. Keep Kernel trust-root responsibilities out of business plugins. Add an ADR before adding an uninstallable Kernel capability.
4. Add negative tests for authorization, signature failure, timeout, stale state and rollback behavior.
5. For UI changes, run `pnpm --filter @opsweave/ui-tests test` and attach real 390/1024/1440 light/dark screenshots.
6. Record every test as RUN or NOT_RUN. Never claim a distributed gate passed when only mocks or a single host were used.
