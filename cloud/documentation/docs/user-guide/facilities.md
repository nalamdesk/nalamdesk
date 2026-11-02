---
sidebar_position: 7
---

# Facilities, Departments & Staff Access

One NalamDesk vault holds an **organisation**: a single clinic, a hospital,
or a group of branches. Each branch is a **facility**. A clinic with one
location works in its one facility and never needs this page.

Records are kept per facility: each facility has its own queue, visits,
invoices and receipts, letterhead, Cloud pairing and ABDM identity.

## Managing Facilities (Settings > Facilities)

Only **organisation admins** can manage facilities.

1. Click **Add facility**.
2. Enter a short **Code** (it prefixes the facility's invoice numbers, for
   example `ANN`), a **Name**, and the **Type**: **Clinic** or **Hospital
   (departments)**.
3. Enter the letterhead details printed on prescriptions and receipts:
   **Letterhead doctor name**, **Letterhead address**, **Phone**.
4. Optional, for ABDM: the facility's own **ABDM HFR ID** and **ABDM HIP ID**.
5. Click **Save facility**.

**Close** a facility to stop anyone signing in or working there. Its
records are kept and it can be reopened. At least one facility always stays
open, and codes, HFR IDs and HIP IDs must be unique.

## Departments

A clinic works as a single **General OPD**. Set a facility's type to
**Hospital (departments)** to add departments such as Orthopaedics or
Emergency with **Add department**. Departments can be edited, closed and
reopened; each facility keeps at least one open department.

## Staff Access

The **Staff access** table sets each staff member's role at each open
facility: Admin, Doctor, Nurse, Receptionist, a custom role, or **No access**.
The same person can be a doctor at one branch and have no access at another.

- **Organisation admin** makes someone an admin at every facility, with
  the right to manage facilities. At least one organisation admin always
  remains, and admins cannot demote themselves.
- A new user gets their role at the facility they were created in. Editing
  a user's role in **Settings > Users** changes it at the current facility.

## Signing In and Switching

- Staff who work at one facility sign in as usual.
- Staff with access to several facilities pick one after entering their
  password. The facility last used on that computer is preselected.
- The **facility switcher** in the top bar changes facility at any time.
  NalamDesk reloads on the dashboard with the role held at the new
  facility.
- Someone with no role at any open facility cannot sign in and is told to
  ask an administrator.

## Numbering per Facility

Invoices, receipts and refunds are numbered per facility, so each branch has
its own unbroken series:

| Facility | Invoice | Receipt | Refund |
| :--- | :--- | :--- | :--- |
| Main facility | `INV-100001` | `RCP-100001` | on the receipt series |
| A branch with code `ANN` | `ANN-INV-2026-000001` | `ANN-RCP-2026-000001` | `ANN-RFD-2026-000001` |

Branch numbers restart each year. The main facility keeps the numbering
already on its printed bills. Numbers never skip or repeat, even with
several computers billing at once.

## Cloud and ABDM per Facility

Each facility pairs with NalamDesk Cloud on its own HFR facility ID and
works with ABDM as itself, with its own online-booking listing. See
[NalamDesk Cloud](./admin-management.md#nalamdesk-cloud-general-tab-optional).
