---
sidebar_position: 1
---

# User Guide

Welcome to the NalamDesk User Guide. This section is designed to help Doctors, Receptionists, and Administrators effectively use the application.

## Getting Started

- **Install**: Windows `.exe`, macOS `.dmg`, or Linux **`.deb`** (`sudo apt install ./nalamdesk-desktop_*_amd64.deb`). The AppImage is secondary and needs FUSE 2; do not extract it.
- **[Initial Setup](./initial-setup.md)**: Step-by-step guide to initializing your secure Vault.
- **[Admin Management](./admin-management.md)**: Learn how to set up the clinic, manage users, and configure backups.
- **[Clinic Operations](./clinic-operations.md)**: A guide to daily workflows like patient registration, queue management, and consultations.
- **[Daily Collection](./daily-collection.md)**: Receipts, the review queue, and the ledger-derived day close.
- **[Merging Duplicate Charts](./patient-merge.md)**: Preview-first merge with rollback for duplicate patient records.
- **[Data & Backups](../backups.md)**: Local backup schedule, retention, restore, and Google Drive redundancy.

## Roles & Responsibilities

| Role | Key Responsibilities |
| :--- | :--- |
| **Admin** | System configuration, User creation, Custom roles, Data backups. |
| **Doctor** | Consulting patients, Creating prescriptions, Viewing history, Merging duplicate charts. |
| **Receptionist** | Registering patients, Managing the waiting queue, Recording payments, Archiving charts. |
| **Nurse** | Recording vitals, Monitoring the triage queue. |

Only doctors finalize encounters; only doctors and admins merge charts
or edit safety data. Admins can compose custom roles, but clinical
finalization and merges stay gated regardless.
