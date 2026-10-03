---
sidebar_position: 2
---

# Admin Management

The Admin Dashboard allows you to configure your clinic settings and manage staff access.

## Accessing Settings
1. Click on the **Settings** icon in the main navigation bar.
2. Ensure you are logged in as an **Admin**.

The Settings footer shows the packaged application version (and a short commit when the build embeds one). Use that string when reporting defects. Development builds are labeled `(development)`.

Logout from the user menu clears the main-process session. The previous user's role cannot be reused after logout or a window reload.

## Clinic Details
In the **General** tab:
- **Clinic Name**: Enter the name of your practice. This will appear on reports and the dashboard.
- **Save Details**: Click to apply changes.

## User Management
In the **Users** tab (Admin only):

### Adding a New User
1. Click the **+ Add User** button.
2. Fill in the details:
    - **Username**: Unique login ID (e.g., `dr_smith`).
    - **Name**: Full display name.
    - **Role**: Select `Doctor`, `Receptionist`, or `Nurse`.
    - **Specialty/License**: Required for Doctors.
    - **Password**: Set a temporary password.
3. Click **Save**.

### Managing Existing Users
- **Edit**: Click to update details or reset passwords.
- **Delete**: Remove a user from the system (Soft delete).

## Data & Backup
Local backups, restore, and Google Drive live under **Settings > Data &
Backup**. See [Data & Backups](../backups.md) for the full guide.

### Connecting Google Drive
1. Go to **Settings > Data & Backup > Google Drive Backup**.
2. Paste your own **Client ID** and **Client Secret** (Bring Your Own Key:
   NalamDesk never sees your Drive credentials). See
   [Google Drive Setup](../google-drive-setup.md) for creating them.
3. Click **Connect Drive** and approve the permissions in the browser window.
4. Once connected, the daily encrypted backup uploads to a hidden
   `appDataFolder` in your Drive. The upload schedule is configurable;
   it runs while the app is open.

### Creating a Backup
- Local backups run automatically every day at the configured time.
- Click **Create Snapshot Now** (Google Drive section) to immediately
  upload a snapshot of your encrypted database.

### Restoring from Backup
> [!WARNING]
> Restoring replaces the current vault. Proceed with caution.

Local restore (Settings > Data & Backup > Restore from Backup File,
or the same picker on the Welcome screen):
1. Click **Choose Backup File…** and pick a `.ndbackup` file.
2. Enter the **Recovery Code** and the current **administrator password**.
3. Click **Restore Vault**. The app restarts with the restored data.

Drive snapshots restore from the backup list in the Google Drive section.
