# Regression coverage map — target: 100% of modules, ≥90% of critical flows

Suite: `desktop/e2e/regression/` (real local Electron + real `ng serve` renderer + transient `nalamdesk-test.db`).

## Module x spec matrix

| Module / route | Spec | What is asserted |
|---|---|---|
| First-run setup (`#/setup`, `auth:setup`) | 01 | fresh device provisions, admin sign-in works |
| Login (`#/login`, invalid creds) | 01 | wrong password stays on login; logout returns to login |
| Guards (`authGuard`, `adminGuard`) | 01 | anon deep links (`#/dashboard`, `#/settings`) -> login; nurse `#/settings` -> dashboard |
| RBAC roles (admin/doctor/receptionist/nurse) | 01 | all 4 log in; Settings nav admin-only; `db:getUsers` Forbidden for non-admin |
| Dashboard (`#/dashboard`) | 02, 04 | renders; New Visit quick action works |
| Patients list (`#/patients`) | 02, 03 | renders; register modal; search filter; empty-name validation |
| Patient details (`#/patients/:id`) | 02, 03 | chart/history render |
| Visits list (`#/visits`) | 02, 04 | renders; completed visit appears |
| Visit workspace (`#/visit/:id`) | 02, 04 | diagnosis + prescription + Save Progress + safety context |
| Queue (`#/queue`) | 02, 04 | Waiting status; Start Consult; End Consult clears entry |
| Online booking (`#/online-booking`) | 02, 06 | date picker + window; slot select/unselect classes; publish IPC wired (fails loudly without cloud backend); slot store read |
| Settings (`#/settings`, admin-only) | 02, 05 | sections render; user update; medicine catalog; audit log |
| Profile (`#/profile`) | 02 | renders |
| Public recovery (`#/recover`, `#/change-password`) | 02 | render without auth |
| Sidebar navigation (role-filtered) | 01, 02 | link visibility per role; click-through to every module |

## What "≥90%" means here

- **100%**: every Angular route and every user role is exercised by at least one
  end-to-end test (table above).
- **≥90% of critical flows**: register -> queue -> consult -> prescribe ->
  complete; login/logout; role provisioning; availability publish; catalog and
  user admin mutations; guard bypass attempts (anon + non-admin).
- Unit-level coverage (vitest `test:coverage` + Sonar) remains the complement:
  E2E proves wiring, vitest proves branches. Run both in CI.

## Explicit non-goals (documented gaps)

- Packaged-installer flows (`electron-builder` artifacts) — not launched here.
- Real cloud sync / Google Drive / ABDM network calls — IPC surface is
  exercised, remote round-trips are not.
- Visual pixel diffs — live in `e2e/visual.spec.ts`, not this suite.
