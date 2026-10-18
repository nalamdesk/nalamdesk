# Known Bugs & Accepted Limitations

Clinical-safety findings from PR #68 review. All four items below are **resolved**
and verified against current code with passing regression tests (closed
2026-10-18; tracking issue #69 checkboxes ticked). Each keeps its original
finding text for the audit trail. New code must not regress these fixes.

## KB-2 — RESOLVED: Queue removal preserves triage audit history

Previously removal hard-deleted the queue row. Current code uses a terminal
`status = 'removed'` (`DatabaseService.removeFromQueue`, no `DELETE`), and
`queue_triage_history.queue_id` has no `ON DELETE CASCADE`, so history survives
removal and stays readable via `getQueueTriageHistory`. Proven by
`ClinicalSafety.spec.ts` ("preserves triage history audit records when queue
entries are removed", "removes queue entries as terminal rows preserving
triage history"). Closed 2026-10-18; tracking issue #69 checkbox ticked.
Original text retained below for the audit trail:

> `queue_triage_history` cascaded from `patient_queue`, while removing a waiting
> entry hard-deleted the row — erasing every recorded priority change, reason,
> actor, and timestamp despite the documented permanent audit trail.

## KB-1 — RESOLVED: self-only authorship, admin attribution with reason

Previously any caller could name any active doctor. Service now enforces
(`DatabaseService.resolveAttendingPractitioner`): non-admin cross-attribution
is rejected; admin cross-attribution requires a non-empty reason recorded in
the `ENCOUNTER_START` audit. Renderer collects the reason in the attending
picker (single-doctor fast path uses a standing reason), and the silent
first-doctor pick in patient details now goes through the same explicit path.
Proven by `ClinicalSafety.spec.ts` ("rejects cross-attribution by non-admins;
admin attribution needs a reason"). Closed 2026-10-18; tracking issue #69
checkbox ticked. Original text retained below for the audit trail:

Any caller passing `beginConsultation`/`beginNextConsultation` can name any active
doctor as `doctor_id` and is recorded as author; later checks admit author *or*
doctor, so a record (and its license snapshot) can finalize under a doctor who
never touched the patient. The admin attending-picker (modal, explicit choice,
audit-logged actor) narrows but does not close this: it is inherent to the
scribe model. Closing it needs an authorization redesign (e.g. self-only
authorship, countersignature workflow, or picker-reason audit).

## KB-3 — RESOLVED: finite courses expire, export stays honest

Previously completed prescriptions synced as permanently `active` with no end
date. Now `parseDurationDays`/`durationEndDate` (`shared/clinical-timing.ts`)
derive course ends from duration lines; `syncEncounterMedications` stores
`end_date`, `sweepExpiredMedications` marks past-due courses `completed`
(on every sync, on medication save, and on the daily sweep in `main.ts`),
and the FHIR export carries `validityPeriod` with `completed` status for
finished courses. Open-ended courses are never touched. Proven by
`clinical-timing.spec.ts`, `ClinicalSafety.spec.ts` ("derives course end dates
from durations and completes past-due courses"), and `serializer.spec.ts`.
Closed 2026-10-18; tracking issue #69 checkbox ticked. Original text retained
below for the audit trail:

## KB-3 — Finite prescriptions stay active indefinitely

Completed prescriptions sync as permanently `active` with no `end_date`, even
though lines carry durations (default `3 days`). Acute courses linger as current
therapy. Fixing needs parsing rules for free-text durations (or a structured
duration field) plus an expiry job — a product call first.

## KB-4 — RESOLVED (new accounts enforced, legacy backfill in progress)

Previously any doctor account — even with a null license — could consult, and
the admin UI could not even capture a license. Now: new doctor accounts are
rejected without a license number (service + settings validation); the admin
form has a license field with a backfill prompt for existing license-less
doctors (blocking only while the account stays active, never blocking
deactivation); and the users list flags active doctors with no license.
Existing license-less doctors can still consult — hard-blocking them would
lock out current deployments, so their records keep working while the badge
and edit-time prompt drive the backfill. Proven by `DatabaseService.spec.ts`
("requires a license number for new doctor accounts") and
`settings.component.spec.ts`. Closed 2026-10-18; tracking issue #69 checkbox
ticked. Original text retained below for the audit trail:

`getPractitioner` accepts any active doctor, even with a null/empty
`license_number` (`saveUser` defaults it to null), so encounters can complete
with an empty license snapshot. Hard enforcement now would lock out existing
deployments whose doctors predate the license field. Needs a backfill UX
decision (mandatory license capture for existing accounts) before enforcing.
