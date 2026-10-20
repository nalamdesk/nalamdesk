# NalamDesk User Guide 📖

Welcome to **NalamDesk**, your secure, offline-first Clinic Management System. This guide will help you set up and use the application effectively.

## 🚀 Getting Started

### 1. Installation
*   **Windows:** Download the installer (`.exe`) and follow the on-screen prompts.
*   **macOS:** Download the `.dmg`, open it, and drag NalamDesk into Applications.
*   **Linux (clinic install):** Download the `.deb` package and install it. Do not extract an AppImage.
    ```bash
    sudo apt install ./nalamdesk-desktop_*_amd64.deb
    ```
    If `apt` is unavailable:
    ```bash
    sudo dpkg -i nalamdesk-desktop_*_amd64.deb
    sudo apt-get install -f
    ```
    Then launch **NalamDesk** from the applications menu.
*   An AppImage may be published as a secondary artifact. It requires FUSE 2 (`libfuse.so.2`). If it fails to start, install the `.deb` — do not extract the squashfs.

### 2. First Run & Security
*   **Create administrator password:** On first launch, the setup wizard creates the encrypted vault on this device and an administrator login.
*   **Linux keyring:** Vault encryption uses the system keyring (`gnome-libsecret`). Install `libsecret-1-0` and `gnome-keyring` if setup reports `ENCRYPTION_UNAVAILABLE`. Do not use `--password-store=basic`.
*   **Recovery code:** Save the recovery code shown at the end of setup. It is required to recover the device.
*   **Login:** Sign in with your username and password. Logout clears the main-process session so the previous role cannot be reused.

---

## 🩺 Features Overview

### 1. Patient Management
*   **Search:** Use the search bar to find patients by Name or Mobile Number.
*   **Registration:** Click **"New Patient"** to register a walk-in patient. All standard fields (Name, DOB, Mobile, etc.) are available.
*   **Edit:** You can update patient details at any time from their profile.

### 2. Queue & Triage Management
*   **Live Queue & Triage Urgency:** The dashboard displays patients ordered by actionable clinical urgency:
    *   🔴 **Immediate (Red):** Life-threatening conditions requiring emergency consultation.
    *   🟠 **Urgent (Orange):** Serious illness or pain needing prompt assessment.
    *   🔵 **Priority (Blue):** Non-urgent but requiring prioritized consultation.
    *   ⚪ **Routine (Green):** Standard walk-in or follow-up visits.
*   **Triage Reassessment:** Clinicians and intake staff can reassess queue urgency at any time by selecting the urgency badge and entering a mandatory clinical rationale. An immutable audit trail of all triage changes is maintained.
*   **Abnormal Vitals Alerts:** Out-of-range vital signs (severe hypertension, fever, hypoxia <92% SpO2, tachycardia/bradycardia) are highlighted directly on the queue badge.
*   **Status Indicators:**
    *   🟢 **Waiting:** Patient is in the lobby.
    *   🟡 **In-Consult:** Patient is currently seeing the doctor.
    *   ✅ **Completed:** Consultation finished.

### 3. Doctor's Workbench & Clinical Safety
*   **Practitioner Provenance & Licensing:** Every consultation is strictly bound to an active, licensed medical practitioner whose registration and council credentials appear on final prescriptions and encounters.
*   **Longitudinal Patient Safety Profile:**
    *   **Allergies:** Recorded with substance, criticality, and reaction details.
    *   **Conditions (Problem List):** Active and chronic conditions tracked with onset date and ICD-10 coding.
    *   **Medication Reconciliation:** Patient medications automatically sync upon consultation completion, avoiding duplicate active entries.
*   **Real-Time Prescribing Safety Checks:**
    *   When adding or saving medicines conflicting with a patient's active allergies, the system flags the conflict and blocks submission unless the doctor provides an explicit clinical override rationale.
*   **Timeline:** View a patient's entire medical history (previous visits, prescriptions) in a chronological timeline.
*   **Prescription Pad:**
    *   **Diagnosis:** Typeahead against the clinic condition catalog. Use **Add new** if the term is missing — the visit is never blocked.
    *   **Presets:** Choosing a condition can fill a clinic-configured medicine set. Edit or remove lines before save.
    *   **Medicines:** Typeahead against the medicine catalog, with **Add new** on the go.
    *   **Print:** Click "Print" to generate a professional PDF prescription instantly.

### 4. Online Booking (Cloud Sync) ☁️
*   **Overview:** NalamDesk allows patients to book appointments online via a public link. These appointments automatically appear in your Desktop App.
*   **How to Enable:**
    1.  Go to **Settings > Cloud Sync**.
    2.  Toggle **"Enable Online Booking"**.
    3.  Enter your **Clinic Name** and **City**.
    4.  Click **"Save"**.
*   **The Flow:**
    1.  **Patient Books:** Uses your public link to book a slot.
    2.  **Sync:** The appointment appears on your **Dashboard** under "Today's Appointments" in ~30 seconds.
    3.  **Check-In:** 
        *   When the patient arrives, click **"Check In"** on the Dashboard card.
        *   **Validation:** If it's a new patient, you will be prompted to verify/fill missing details (Age/Gender).
        *   **Queue:** Once validated, the patient is added to the **Live Queue** and status updates to "Checked In".

### 5. ABDM Integration (India)
*   **One-time setup (Settings → ABDM):** Enter the facility IDs issued to the clinic — HIP ID, counter ID, HFR (facility) ID and the doctors' HPR (practitioner) IDs. Each doctor keeps their own HPR ID even when other profile fields are edited. Until credentials are configured the gateway stays in mock mode and everything keeps working offline.
*   **Scan & Share counter:** The ABDM tab shows a counter QR encoding the clinic identity (no patient data). Print it and display it at reception. When a patient scans it at the counter, their token appears in the **Incoming Scans** dock on the Queue page — press Space or tap the token for 1-click check-in. If details are incomplete the patient chart opens to finish them and the token stays pending.
*   **Care contexts:** Every completed encounter automatically gets a yearly reference like `OP-2026-0001`, visible on the visit. References never repeat, even if an encounter is deleted.
*   **Callback inbox:** Messages from the ABDM gateway reach this computer through NalamDesk Cloud once this computer is paired (Settings → General), land in the inbox, and are acknowledged exactly once. A patient's scan shows in the Incoming Scans dock within seconds.
*   **Secure transfer:** From the patient chart you can push an encrypted bundle to the configured hospital endpoint (Fidelius end-to-end encryption). With no endpoint configured the transfer runs as a local loopback receipt for testing.
*   **Outside records (consent-based):** From the patient chart, open the **External** tab and request records from another facility — pick the record types and date range, and the patient approves the request in their own health app. Once granted, fetch the records into the clinic vault: diagnoses, medications, observations, and allergies noted outside appear on the tab. A medication can be imported into the active list with one tap; conflicting imports are blocked unless the doctor records an explicit override, exactly like prescribing. Cached outside records expire after 30 days and can be cleared at any time.

---

## ⚙️ Settings

### General
*   **Theme:** Switch between Light, Dark, and High-Contrast modes.
*   **Clinic Details:** Update your clinic's name and address (appears on prescriptions).
*   **Application version:** The Settings footer shows the packaged application version from Electron (`app.getVersion()`), plus a short commit when the build embeds one. Development builds are labeled `(development)`.
*   **Updates:** Packaged desktops check for a newer approved build on launch and from **Settings → Check for updates**. If one is available you see the current and new version, optional notes, and **Update now** / **Later**. Later keeps the running app. A failed check or download shows a plain error and does not touch the vault. Unsigned or checksum-only feeds do **not** claim full signature verification.
*   **Catalogs:** Administrators maintain diagnosis and medicine inventories (and condition→medicine presets) under **Settings → Catalogs**. Soft-retire hides a term from typeahead; past visit text is unchanged.

### Data Management
*   **Backup:** Automated daily backups are saved locally (Settings → Data & Backup). Retention is 30 days.
*   **Restore (after first run):** Settings → **Data & Backup** → **Restore from Backup File**. Choose a `.ndbackup`, enter the Recovery Code and the current administrator password. This is the same gated restore as the Welcome screen; the app restarts after a successful restore.
*   **Google Drive:** Link your Google Account to enable **Automated Daily Backups** (runs every day at 10 PM if the app is open).
*   **Crash Reporting:** If the application closes unexpectedly, you will see a popup asking to "Save Crash Report". Please save this file and email it to support for analysis. Your data remains private; the report only contains error details, not patient records.

---

## ❓ FAQ

**Q: Is my data safe?**
A: Yes. Your data is stored **locally** on your device and encrypted with your password. Even if you use Cloud Sync, only appointment details are temporarily synchronized; your core medical records remain offline and encrypted.

**Q: Can I use NalamDesk without internet?**
A: **Yes!** NalamDesk is "Offline-First". You can do everything (Queue, Consult, Print) without internet. You only need internet if you want to receive Online Bookings.

**Q: I forgot my password.**
A: Unfortunately, there is no reset. Since we don't store your password, we cannot recover it. Please keep it safe.
