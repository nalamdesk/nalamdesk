# Known Bugs & Accepted Limitations

Clinical-safety findings from PR #68 review. KB-2 below is **resolved** (verified
against current code with passing regression tests); KB-1, KB-3, KB-4 remain
**acknowledged but deliberately deferred**. Each remaining item needs a product
or design decision before a code fix lands. New code must not make these worse;
fixes should reference the tracking issue.

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

## KB-1 — Practitioner attribution is caller-supplied (trust model)

Any caller passing `beginConsultation`/`beginNextConsultation` can name any active
doctor as `doctor_id` and is recorded as author; later checks admit author *or*
doctor, so a record (and its license snapshot) can finalize under a doctor who
never touched the patient. The admin attending-picker (modal, explicit choice,
audit-logged actor) narrows but does not close this: it is inherent to the
scribe model. Closing it needs an authorization redesign (e.g. self-only
authorship, countersignature workflow, or picker-reason audit).

## KB-2 — Queue removal hard-deletes triage audit history

`queue_triage_history` cascades from `patient_queue`, while removing a waiting
entry hard-deletes the row — erasing every recorded priority change, reason,
actor, and timestamp despite the documented permanent audit trail. Fixing needs
a schema decision: soft-delete queue episodes or detach history retention.

## KB-3 — Finite prescriptions stay active indefinitely

Completed prescriptions sync as permanently `active` with no `end_date`, even
though lines carry durations (default `3 days`). Acute courses linger as current
therapy. Fixing needs parsing rules for free-text durations (or a structured
duration field) plus an expiry job — a product call first.

## KB-4 — Doctor accounts without a license number can consult

`getPractitioner` accepts any active doctor, even with a null/empty
`license_number` (`saveUser` defaults it to null), so encounters can complete
with an empty license snapshot. Hard enforcement now would lock out existing
deployments whose doctors predate the license field. Needs a backfill UX
decision (mandatory license capture for existing accounts) before enforcing.
