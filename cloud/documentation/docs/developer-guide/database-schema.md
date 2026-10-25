---
sidebar_position: 2
---

# Database Schema

NalamDesk uses a relational SQLite database (SQLCipher-encrypted via
`better-sqlite3-multiple-ciphers`). Schema evolves through ordered
migrations in `desktop/src/main/schema/migrations.ts` (currently **v50**,
with a spec asserting each step in `migrations.spec.ts`). Below is the
schema definition for core tables.

## Users Table
Stores credentials and profile information for all system users (Doctors, Staff, Admin).

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Auto-incrementing ID. |
| `username` | TEXT UNIQUE | Login username. |
| `password` | TEXT | Argon2 Hash of the password. |
| `role` | TEXT | `admin`, `doctor`, `receptionist`, `nurse`. |
| `name` | TEXT | Display name. |
| `specialty` | TEXT | Doctor's specialty (e.g., General Physician). |
| `license_number` | TEXT | Medical license number. |
| `active` | INTEGER | `1` for active, `0` for soft-delete. |
| `mobile`, `email` | TEXT | Contact details (mobile is 10 digits in the UI). |
| `abdm_hpr_id` | TEXT | Doctor's ABDM Health Professional Registry ID (optional). |

Custom roles live in `roles`; per-user permission grants/forbids in
`user_permission_overrides` (Migrations v32–v33 seed the grant tables;
v31 adds the overrides table).

## Patients Table
Core patient registry.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Unique Patient ID. |
| `uuid` | TEXT UNIQUE | System-generated UUID for syncing. |
| `name` | TEXT | Patient Name. |
| `mobile` | TEXT | Contact Number. |
| `date_of_birth` | DATE | Date of Birth (ISO format YYYY-MM-DD). Age is calculated dynamically. |
| `gender` | TEXT | `Male`, `Female`, `Other` (`Unknown` also accepted in the UI). |
| `address` | TEXT | Residential address. |
| `mrn` | TEXT UNIQUE | Auto-assigned medical record number (`ND-000001` style; prefix configurable via `settings.mrn_prefix`). Added in Migration v35. |
| `dob_estimated` | INTEGER | `1` when age was typed directly instead of picked from a birth date. Added in Migration v35. |
| `merged_into` | INTEGER NULL | Points at the surviving chart after a merge; cleared on unmerge. Added in Migration v35. |
| `active` | INTEGER | `1` normally, `0` for archived charts. Added in Migration v38. |
| `archive_reason` | TEXT | Recorded reason for archiving. Added in Migration v38. |

## Visits Table
Records clinical encounters.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Visit ID. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `doctor_id` | INTEGER FK | Responsible licensed practitioner (`users.id`). |
| `author_id` | INTEGER FK | Links to `users.id` (Author/scribe recording encounter). |
| `practitioner_license_snapshot` | TEXT | Snapshot of responsible doctor's license at signing. |
| `allergy_override_reason` | TEXT | Clinical justification if prescribed medicine conflicts with allergy. |
| `date` | DATETIME | Timestamp of the visit. |
| `diagnosis` | TEXT | Medical diagnosis notes. |
| `prescription_json` | TEXT | JSON string array of medicines. |
| `amount_paid` | NUMERIC(12,2) | Consultation fee collected. |

## Vitals (Observations) Table
Stores structured clinical observations (FHIR Observation aligned) linked durably to patients, encounters, and pre-consultation queues. Supports dual-unit entry (°F/°C, kg/lbs), LOINC and UCUM standardized representation, and non-destructive amendment history.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Auto-incrementing Observation ID. |
| `visit_id` | INTEGER FK | Links to `visits.id` (Encounter linkage). NULL if recorded pre-consultation. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `systolic_bp` | INTEGER | Systolic blood pressure (mmHg, 50–300; LOINC `8480-6`). |
| `diastolic_bp` | INTEGER | Diastolic blood pressure (mmHg, 30–200; LOINC `8462-4`). |
| `pulse` | INTEGER | Heart rate (bpm, 30–250; LOINC `8867-4`). |
| `temperature` | REAL | Body temperature (50–115 °F canonical; LOINC `8310-5`). |
| `weight` | REAL | Patient weight (0.5–500 kg canonical; LOINC `29463-7`). |
| `height` | REAL | Patient height (20–300 cm; LOINC `8302-2`). |
| `bmi` | REAL | Body Mass Index (auto-calculated; LOINC `39156-5`). |
| `spo2` | REAL | Oxygen saturation (50–100 %; LOINC `59408-5`). |
| `respiratory_rate`| REAL | Respiratory rate (4–80 bpm; LOINC `9279-1`). |
| `created_at` | DATETIME | Timestamp row was created. |
| `effective_time` | DATETIME | Clinical observation timestamp. |
| `recorded_at` | DATETIME | System entry timestamp. |
| `performer_id` | INTEGER FK | Links to `users.id` (clinician who measured vitals). |
| `status` | TEXT | FHIR status: `preliminary`, `final`, `amended`, `corrected`, `entered-in-error`. |
| `units_json` | TEXT | JSON object specifying display units and UCUM standard codes. |
| `queue_entry_id` | INTEGER FK | Links to `patient_queue.id` for queue-side vitals persistence. |
| `replaces_id` | INTEGER FK | Self-reference to previous vitals ID when amended/corrected. |
| `amendment_reason`| TEXT | Clinical justification for amendment. |
| `client_request_id`| TEXT | Idempotency key to prevent duplicate submissions. |

## Patient Allergies Table (Migration v11)
Longitudinal record of patient allergies, adverse reactions, and drug intolerances.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Allergy record ID. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `substance` | TEXT | Allergen name (e.g. Penicillin, Sulfa, Peanuts). |
| `verification_status` | TEXT | `confirmed`, `unconfirmed`, `refuted`. |
| `criticality` | TEXT | `low`, `high` (life-threatening), `unable-to-assess`. |
| `severity` | TEXT | `mild`, `moderate`, `severe`. |
| `reaction` | TEXT | Manifestation description (e.g. Anaphylaxis, Urticaria). |
| `status` | TEXT | `active`, `inactive`, `resolved`. |
| `notes` | TEXT | Free-text clinical notes. |
| `recorder_id` | INTEGER FK | Links to `users.id` (Clinician who logged allergy). |
| `recorded_at` | DATETIME | Timestamp when recorded. |

## Patient Conditions Table (Migration v11)
Longitudinal problem list and chronic condition registry.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Condition record ID. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `condition_name` | TEXT | Condition / problem description. |
| `code` | TEXT | ICD-10 diagnostic code (optional). |
| `category` | TEXT | `problem-list-item`, `encounter-diagnosis`, `chronic-condition`. |
| `clinical_status` | TEXT | `active`, `recurrence`, `relapse`, `inactive`, `remission`, `resolved`. |
| `onset_date` | DATE | Approximate or exact onset date. |
| `notes` | TEXT | Clinical notes and severity observations. |
| `recorder_id` | INTEGER FK | Links to `users.id`. |
| `recorded_at` | DATETIME | Timestamp when recorded. |

## Patient Medications Table (Migration v11)
Longitudinal active medication list, updated manually or automatically synchronized upon encounter completion.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Medication record ID. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `medicine_name` | TEXT | Brand or generic medicine name. |
| `dosage` | TEXT | Dose specification (e.g., 500mg). |
| `frequency` | TEXT | Dosage schedule (e.g., 1-0-1 After Food). |
| `status` | TEXT | `active`, `completed`, `stopped`, `on-hold`. |
| `start_date` | DATE | Start date of prescription/regimen. |
| `end_date` | DATE | Expected or actual completion date. |
| `notes` | TEXT | Indication or compliance remarks. |
| `recorder_id` | INTEGER FK | Links to `users.id`. |
| `recorded_at` | DATETIME | Timestamp when recorded. |

## Condition catalog
Clinic-local diagnoses for Plan & Rx typeahead. Unique `name` among **active** rows. Soft-retire sets `active = 0` and does not rewrite historical visit text.

## Medicine catalog
Clinic-local medicines with optional default Rx fields (`form`, `dosage`, `route`, `frequency`, `duration`, `instruction`) matching the visit prescription snapshot.

## Condition medicine presets
Ordered default Rx lines for a condition (`condition_id`, `sort_order`, optional `medicine_id`, plus snapshot columns matching `PrescriptionItem`). Applied into the editable Rx list on diagnosis pick.

## Patient Identifiers Registry (Migration v39)

One chart can carry several identifiers at once: clinic MRN, ABHA
number / address, insurance, and free-form ids. `patients.mrn` and
`abha_address` stay as fast-path columns; `patient_identifiers` is the
extensible registry (`system`, `type_code`, `value`, `is_primary`),
unique per (`system`, `value`). `patients.abha_number` holds the
nationally-unique ABHA number (unique where present). Registry reads
and writes are granted to doctors, receptionists, and admins.

## Billing Ledger (Migration v37)

Immutable money trail: invoices with charge lines, payments as append-only
rows, corrections through reversals — never edits.

- **`invoices`**: unique `number`, `visit_id`, `patient_id`, `total`
  (computed from lines), `status`, plus discount/tax. Created only for
  finished visits; the clinic `consultation_fee` setting prepends the
  first line when non-zero.
- **`invoice_items`**: one row per charge line (`description`,
  `quantity`, `rate`, `amount`).
- **`payments`**: unique `receipt_no`, `invoice_id`, `kind`
  (`payment` or `reversal`), `amount`, `method` (`cash`, `upi`,
  `card`), `reference`, `reason`, idempotency key. Refunds insert
  reversal rows; voids cancel invoices with a reason and are blocked
  while payments are outstanding.

The day-close report (`getDailyClose`) derives collected totals,
by-method breakdowns, and the review queue purely from these rows.

## Patient Merge Ledger (Migration v36)

- **`patient_merges`**: one row per merge (`survivor_id`,
  `duplicate_id`, audited `reason`), reversible via unmerge.
- **`patient_merge_items`**: every moved row (`table`, id column, row
  id) so unmerge restores exact placement. Hard stops: active
  in-progress encounters on either chart, or conflicting health IDs.

## Record Lifecycle (Migration v38)

Charts archive instead of deleting: `patients.active` plus
`archive_reason`, with `archivePatient` / `unarchivePatient` flows.
Visit corrections record `correction_reason` rather than rewriting
history.

## Settings Keys

Beyond clinic details, `settings` carries the backup schedule
(`backup_schedule`, default `13:00`), the receipt/invoice consultation fee
(`consultation_fee`, default `0`), and the MRN prefix (`mrn_prefix`,
default `ND`).

## Patient Queue Table
Manages the daily patient flow with actionable triage urgency levels.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Queue entry ID. |
| `patient_id` | INTEGER FK | Links to `patients.id`. |
| `status` | TEXT | `waiting`, `in-consult`, `completed`. |
| `priority` | INTEGER | Internal priority sort order (1–4). |
| `urgency_label` | TEXT | 4-tier urgency: `immediate`, `urgent`, `priority`, `routine`. |
| `triage_notes` | TEXT | Clinical justification for urgency assignment. |
| `triaged_by` | INTEGER FK | Links to `users.id` (Staff member who triaged). |
| `triaged_at` | DATETIME | Timestamp of triage assessment. |
| `created_at` | DATETIME | Timestamp when patient joined queue. |
| `completed_at` | DATETIME | Timestamp when status changed to `completed`. |

## Queue Triage History Table (Migration v11)
Audit log tracking every triage priority reassessment with clinical reason and actor attribution.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | History entry ID. |
| `queue_id` | INTEGER | Queue entry ID (preserved as an immutable audit record even after queue removal). |
| `previous_priority` | INTEGER | Priority value prior to change. |
| `new_priority` | INTEGER | New priority value after reassessment. |
| `urgency_label` | TEXT | New urgency label (`immediate`, `urgent`, `priority`, `routine`). |
| `reason` | TEXT | Mandatory clinical justification for reassessment. |
| `changed_by` | INTEGER FK | Links to `users.id` (Staff performing reassessment). |
| `changed_at` | DATETIME | Timestamp of change. |

## Audit Logs Table
Tracks critical system actions for security and compliance.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INTEGER PK | Unique Log ID. |
| `action` | TEXT | `INSERT`, `UPDATE`, `DELETE`. |
| `table_name` | TEXT | Target table (e.g., `patient_queue`). |
| `user_id` | INTEGER | ID of the user who performed the action. |
| `timestamp` | DATETIME | Time of action (Default: Current Time). |
| `details` | TEXT | Description of the change. |

