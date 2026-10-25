---
sidebar_position: 4
---

# Testing Strategy 🧪

NalamDesk tests the desktop app in three layers: unit suites split by
process boundary, plus Playwright end-to-end against a throwaway
database. Spec files live next to their source (`*.spec.ts`).

## 1. Unit Suites (Vitest Workspaces)

`desktop/vitest.workspace.js` defines two projects sharing
`vitest.config.js`:

| Project | Files | Environment | Run |
| :--- | :--- | :--- | :--- |
| `renderer` | `src/renderer/**/*.spec.ts` | `jsdom` | `npm run test:renderer` (config `vitest.config.renderer.mjs`) |
| `main` | `src/main/**`, `src/shared/**`, `src/server/**` | `node` | `npm run test:main` (config `vitest.config.main.js`) |

`npm test` runs both. A `vitest.config.pure.mjs` covers dependency-free
modules.

### Component Testing Convention

Angular components are tested by **manual instantiation** with mocked
dependencies, not `TestBed`, to avoid `zone.js`/`ProxyZone`
instability in JSDOM:

```typescript
// GOOD: Stable & Fast
beforeEach(() => {
    mockService = { getData: vi.fn() };
    component = new MyComponent(mockService);
});
```

Template rendering, bindings, and user interactions are verified one
layer up, in E2E.

### Migration & Policy Specs

Schema changes ship with assertions in
`src/main/schema/migrations.spec.ts` (each migration v1–v50 applies
cleanly and newer grants hold). The shared RBAC model has a
conformance spec at `src/server/access-conformance.spec.ts`. Touching
either area means extending its spec first.

## 2. End-to-End (Playwright)

`desktop/playwright.config.ts` (`testDir: ./e2e`, run with
`npm run e2e`) drives the packaged main process plus renderer:

- `e2e/full-flow.spec.ts`: registration → queue → consult → print.
- `e2e/visual.spec.ts`, `e2e/availability.spec.ts`: rendering and
  presence checks.

E2E runs against a **transient test database** (`nalamdesk-test.db`,
selected when `NODE_ENV=test`), never the clinic vault:

```bash
# 1. Close all NalamDesk instances
# 2. Build the main process
npm run build:main

# 3. Run Playwright
npm run e2e
```

## 3. CI Expectations

Feature CI builds Angular, runs `npm test`, and (on `master` pushes)
packages all three OS targets. It fails the job when artifact names,
`latest*.yml`, `build-identity.json`, and the Settings-displayed
version disagree — so bump versions and identities together.
