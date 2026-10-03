---
sidebar_position: 3
---

# Clinic Operations

This guide covers the daily workflows for Receptionists and Doctors.

## Patient Registration (Receptionist)
1. Navigate to **Patients**.
2. Click **+ New Patient**.
3. Enter details: **Name**, **Age/Gender**, **Mobile Number**.
4. The form warns about possible existing records (matched by name, mobile,
   or MRN) without blocking you. Open the candidate chart first if unsure.
5. Click **Save**.

If a duplicate slips through, merge the charts later instead of deleting
one. See [Merging Duplicate Charts](./patient-merge.md).

## Managing the Queue
The **Queue** is the heart of the clinic's flow, supporting actionable urgency triage and abnormal vitals indicators.

### 4-Tier Urgency Levels
Patients in the queue are categorized into 4 clinical urgency levels:
- 🔴 **Immediate** (Priority 4): Critical conditions requiring instant physician attention (e.g., severe chest pain, acute respiratory distress, severe trauma).
- 🟠 **Urgent** (Priority 3): Serious conditions requiring prompt care (e.g., high fever, severe asthma exacerbation).
- 🟡 **Priority** (Priority 2): Elevated concern, scheduled next before routine visits (e.g., persistent vomiting, uncontrolled hypertension).
- ⚪ **Routine** (Priority 1): Standard consultations and general follow-ups.

### Adding Patient to Queue
1. From the **Patient List**, click the **Add to Queue** icon next to a patient.
2. Select the Urgency tier: **Immediate**, **Urgent**, **Priority**, or **Routine**.
3. The patient will appear in the **Waiting** list sorted strictly by clinical urgency first, then arrival time.

### Reassessing Urgency & Triage Audit Trail
If a waiting patient's condition changes:
1. Click the **Triage Badge** or **Reassess** button on the queue entry card.
2. Select the revised urgency level.
3. Enter the mandatory clinical justification (e.g., "Patient reports worsening dizziness while waiting").
4. Click **Update Triage Urgency**. The change is recorded in the permanent triage history audit trail.

### Recording Vitals (Dual-Unit Vitals Engine)
Staff (nurse, receptionist, or doctor) can record vitals for any patient waiting in the queue or during consultation:
1. Click the **Record Vitals** (heartbeat) icon on the patient card in the Queue or consultation chart.
2. Enter clinical observations:
   - **Blood Pressure**: Both Systolic and Diastolic must be entered together, with Systolic strictly greater than Diastolic (e.g., 120/80 mmHg).
   - **Pulse**: Heart rate in beats per minute (30–250 bpm).
   - **Temperature**: Toggle between **°F** and **°C**. Input values are automatically converted and canonically standardized.
   - **Weight**: Toggle between **kg** and **lbs**.
   - **Height**: In cm; BMI is automatically calculated dynamically.
   - **Oxygen Saturation (SpO2)**: In percentage (50–100%).
   - **Respiratory Rate**: In breaths per minute.
3. **Abnormal Vitals Alerts**: The system automatically analyzes vitals against standard ranges. Abnormal readings trigger an orange alert badge directly on the Queue card to signal urgent attention.
4. Click **Save Vitals**.

## Patient Longitudinal Clinical Profile (Receptionist & Doctor)
From **Patients -> Patient Details**, clinicians can manage the patient's complete longitudinal clinical history across tabs:
- **Visits**: Historical consultation notes, diagnoses, and prescriptions.
- **Allergies / Intolerances**: Document drug, food, or environmental allergies with substance name, criticality (Low/High/Life Threatening), severity, and reaction manifestation (e.g., Anaphylaxis, Urticaria).
- **Active Problem List (Conditions)**: Track chronic and active conditions with ICD-10 codes, onset dates, and clinical status.
- **Current Medications**: Maintain active prescriptions and long-term regimens. Prescriptions written in consultations automatically sync to this active list.

## Consultation (Doctor)
1. Go to **Queue** or **Dashboard**.
2. Click on a patient in the **Waiting** or **In-Consult** list.
3. **Patient Safety Context Banner**:
   - Displays prominent safety indicators at the top of the chart: active allergy count, active problem list, and current medications.
   - Displays a green "✓ No Known Allergies" badge if clear, or a high-visibility red alert if allergies exist.
4. **Vitals**:
   - Vitals recorded during queue triage automatically appear in the patient snapshot pill and can be auto-filled into Objective notes.
   - Click **Edit Vitals** to amend measurements with audit history.
5. **Diagnosis & SOAP Notes**: Enter subjective complaints, objective exam, and assessment diagnosis.
6. **Prescription & Allergy Conflict Interceptor**: 
   - Add medicines (Name, Dosage, Frequency, Duration).
   - **Allergy Conflict Alert**: If a prescribed medication matches a patient's documented active allergy, the system intercepts the save and displays a critical warning dialog with the conflicting substance and risk level.
   - The doctor must either modify the prescription or acknowledge the alert by entering an explicit **Clinical Override Reason** (e.g., "Graded dose, patient tolerated previously") to proceed.
7. **Complete Consultation**:
   - Signing the encounter stamps the responsible doctor's license snapshot and marks the visit completed.
   - Prescriptions automatically update the patient's active medication list.
   - Only a finished encounter can be billed. See [Daily Collection](./daily-collection.md).

