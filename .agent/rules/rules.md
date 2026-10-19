---
trigger: always_on
---

# NalamDesk Project Rules & Context 🧠

## 1. Architecture Overview (Hybrid)
NalamDesk is a **Hybrid Medical Practice Management System** that combines privacy-first local data with cloud-enabled remote access.

### 🏢 Desktop App (Hyperlocal)
- **Framework**: Electron + Angular 17.
- **Location**: `desktop/`
- **Database**: SQLite (`nalamdesk.db`) stored locally.
- **Logic**: 
  - Main Process (`src/main`): Handles OS integration, SQLite DB access, Google Drive Backups, and Cloud Sync.
  - Renderer (`src/renderer`): Angular UI.
  - Local Server (`src/server`): Fastify — API + LAN browser access (prod: serves `dist`; dev: proxies UI to ng serve).

### ☁️ Cloud Platform
- **Location**: `cloud/`
- **Host**: AWS `ap-south-1`, CDK, Lambda Web Functions behind CloudFront. Zero-knowledge: clinic data stays on the desktop.
- **Logic**:
  - `cloud/core`: Shared resources (DNS zone, certificates, device registry, ops sign-in, code bucket, budget), published to Parameter Store.
  - `cloud/relay`: ABDM relay. Holds the vendor credentials, forwards signed desktop calls, seals gateway callbacks to the clinic's key.
- **Secrets**: Parameter Store SecureString, never Secrets Manager.

## 2. Directory Structure
```
/
├── desktop/                # The Electron Application
│   ├── src/
│   │   ├── main/           # Electron Main Process (DB, Sync, Drive)
│   │   ├── renderer/       # Angular UI
│   │   └── server/         # Embedded Local Server
│   ├── package.json        # "nalamdesk-desktop"
│   └── angular.json        # Angular Build Config
├── cloud/                  # The Remote Platform
│   ├── core/               # Shared CDK stacks
│   ├── relay/              # ABDM relay app + CDK stack
│   └── documentation/      # Project Docs (MkDocs/Docusaurus)
└── .agent/                 # Agent Rules & Context
```

## 3. Critical Rules ⚠️
1.  **Process Hygiene**: Always KILL `node`, `git`, `npm` processes before performing directory operations on Windows to avoid file locks.
2.  **Stateless Cloud**: Cloud functions MUST NOT rely on local file storage. State is in SQLite (Desktop); the cloud holds only ciphertext and routing metadata.
3.  **Dev vs Prod isolation** (defaults in repo-root `.env.development`; override via `.env.local`):
    - **DB**: `userData/nalamdesk.db` — prod `NalamDesk/`, dev `NalamDesk-Dev/` (not `desktop/nalamdesk.db`).
    - **Ports**: 3000 installed API · 3001 cloud API · 3002 dev API · 4200 ng serve. Dev and installed app may run together.
4.  **Secrets**: NEVER commit `.env` or `credentials.json`.
5.  **Sync Logic**: If Cloud returns `401` or `404` (Clinic Not Found), the Desktop App MUST self-heal (reset cloud settings) to prevent orphaned states.

## 4. Commands
- **Start Desktop**: `cd desktop && npm start`
- **Build Desktop**: `cd desktop && npm run dist:win`
- **Deploy Cloud**: `cd cloud/core && npm run deploy`, then `cd cloud/relay && npm run deploy` (see each README)

## 5. Architecture Clarification (Desktop vs Cloud) 🌐
- **Distinct Applications**: The `desktop` application (Electron) and the `cloud/` services are **distinct entities**.
    - **Desktop**: Local-first, SQLite, Electron window uses IPC.
    - **LAN browser** (tablet/phone on clinic Wi‑Fi): hits Fastify on API port, JWT via `/api/auth/login` — not IPC.
- **Authentication**:
    - **Desktop (Electron)**: Unlocks local SQLite via Master Password / Key Wrapping.
    - **LAN browser**: JWT from Fastify (same port as API).
    - **Cloud relay**: Per-device signatures; ABDM callbacks verified by gateway JWT.
    - **Do NOT conflate them**.

## 6. SonarQube Code Quality Standards 🔍

### 6.1 Cognitive Complexity (S3776)
- **Max complexity per function: 15.** SonarQube will fail the Quality Gate if exceeded.
- **Strategy**: Extract helper functions to reduce nesting and branching.
- **Common offenders**: Auth handlers, DB CRUD methods with conditional SQL, data transformation pipelines.
- **Rule**: Any function with `if/else/try/catch/for/while` nesting > 3 levels MUST be refactored into smaller helpers.

### 6.2 Angular Lifecycle & Outputs
- **S7655**: Always add `implements OnInit` (or `OnDestroy`, etc.) when using `ngOnInit()` or other lifecycle hooks. Import the interface from `@angular/core`.
- **S7651**: NEVER name `@Output()` EventEmitters with standard DOM event names (`close`, `cancel`, `confirm`, `submit`, `change`, `click`, `focus`, `blur`, `scroll`, `load`, `error`, `input`, `select`, `reset`). Use descriptive names like `closeDialog`, `cancelAction`, `confirmAction`, `submitForm`.
- **S7059**: Do NOT perform async operations inside class constructors. Use `ngOnInit()` or a dedicated `init()` method instead.

### 6.3 TypeScript Best Practices
- **S4123**: Do NOT `await` synchronous (non-Promise) return values. Check function signatures before adding `await`.
- **S3735**: Do NOT use the `void` operator. If injecting a service for side effects, use `_` prefix convention: `constructor(private _myService: MyService) {}`.
- **S7761**: Use `element.dataset.myAttr = value` instead of `element.setAttribute('data-my-attr', value)`.
- **S1186**: Do NOT leave empty methods without a comment explaining why they're empty.
- **S2871**: Always provide a comparator function to `Array.sort()` to avoid alphabetical sorting surprises.

### 6.4 Security Rules (Hotspots)
- **S2068 (HIGH)**: NEVER hard-code passwords, secrets, or API keys in source code. Always use environment variables or secure vaults.
- **S5852 (MEDIUM)**: Avoid regex patterns vulnerable to catastrophic backtracking (ReDoS). Test regex with worst-case inputs. Prefer atomic groups or possessive quantifiers.
- **S5725 (LOW)**: External CDN resources (scripts, stylesheets) SHOULD include `integrity` and `crossorigin` attributes for Subresource Integrity (SRI).
- **JWT_SECRET**: Must be set via `process.env['JWT_SECRET']` in production. NEVER use fallback random secrets in production.
- **Admin IP restriction**: Admin login from non-localhost MUST be restricted in production (`STRICT_ADMIN_IP=true`).

### 6.5 Coverage & Quality Gate
- **Coverage target**: 80% on new code (SonarCloud "Sonar way" default).
- **All new features MUST include unit tests** covering happy path + error cases.
- **Test files**: Name as `*.spec.ts` or `*.test.ts`. These are excluded from SonarQube analysis.
- **Coverage exclusions** (not counted): `*.spec.ts`, `*.test.ts`, `app.config.ts`, `app.routes.ts`, `polyfills.ts`, `main.ts` (bootstrap), `environments/`, `*.d.ts`.
- **Run coverage locally**: `cd desktop && npm run test:coverage` (generates `coverage/main/lcov.info` and `coverage/renderer/lcov.info`).

### 6.6 Code Duplication
- **Max duplication**: 3% on new code.
- **Do NOT copy-paste SQL queries** — use template builders or shared constants for common column lists.
- **Do NOT duplicate service initialization logic** — extract into shared helper functions.

### 6.7 Global Scope Access
- **Prefer `globalThis`** over `window` when accessing Electron APIs in the renderer process (e.g., `globalThis.electron` instead of `window.electron`). This improves testability and avoids issues in non-browser environments.
- Use `node:` prefix for Node.js built-in imports (e.g., `import fs from 'node:fs'` instead of `import fs from 'fs'`).

### 6.8 Regression Gate (Desktop E2E)
- **After ANY desktop change** (feature, fix, or refactor touching renderer, main process, IPC, routes, or guards), run the full regression locally before considering the work done: `cd desktop && npm run e2e:regression` (real Electron + local renderer + isolated test DB).
- **Red means stop and triage — do NOT jump to fixing tests.** A failing run means one of three things; determine which BEFORE touching anything: (1) an existing functionality broke (product regression — fix the product, not the test); (2) the product intentionally changed (update the spec + `COVERAGE.md` to the new intended behavior); (3) the spec is stale (selector/markup drift — re-verify against the template). Read the failure snapshot/trace first; never weaken an assertion to make red go away.
- **New code brings new coverage**: adding any component, module, route, guard, role, or feature MUST extend `desktop/e2e/regression/` in the SAME change (new or updated spec) AND the module matrix in `desktop/e2e/regression/COVERAGE.md`. Untested new UI is incomplete work.
- **Verify selectors against templates**: E2E locators must match the current component markup (AG Grid rows, reactive-form placeholders, live button labels) — read the template, don't guess.
- **CI is manual-only** (`.github/workflows/regression-e2e.yml`, `workflow_dispatch`): it never runs on PRs by design, so the local run IS the gate.
