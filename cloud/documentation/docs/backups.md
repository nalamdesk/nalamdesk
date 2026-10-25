---
sidebar_position: 4
---

# Data & Backups

NalamDesk takes data security seriously. We employ a **Privacy-First, Local-First** architecture. This means your patient data resides on your device, encrypted, and is never sent to our servers.

## Local Backups
NalamDesk automatically creates an encrypted backup of your database every
day at the time configured under **Settings > Data & Backup > Local Backup
Schedule** (default **1:00 PM**). The app must be open at that time for the
backup to run.

![Settings, Data and Backup tab](/img/nalamdesk-settings-backup.png)
*Backup schedule, health, location, and restore live under Settings, Data and Backup.*

### Default Backup Location
Unless you configure a custom location, backups are stored in the application data folder:

- **Windows**: `C:\Users\<YourUser>\AppData\Roaming\NalamDesk\backups`
- **macOS**: `/Users/<YourUser>/Library/Application Support/NalamDesk/backups`
- **Linux**: `/home/<YourUser>/.config/nalamdesk/backups`

### Retention Policy
Local backups are retained for **30 days**. Older backups are automatically deleted to save space.

### Changing Backup Location
1. Go to **Settings** > **Data & Backup**.
2. Click **Change Location** under the Local Backups section.
3. Select your preferred folder (e.g., an external hard drive or a specific document folder for easier access).

### Backup Health
The Data & Backup screen reports backup health derived from the backup
files on disk: when the last backup ran and whether anything needs
attention. A **Run backup now** action is offered when a problem is found.

### Restoring a Local Backup
1. Go to **Settings** > **Data & Backup** > **Restore from Backup File**
   (the same picker is available on the Welcome screen before login).
2. Click **Choose Backup File…** and pick a `.ndbackup` file.
3. Enter the **Recovery Code** and the current **administrator password**.
   Both are required. There is no reset path: a lost recovery code means
   the backup cannot be restored.
4. Click **Restore Vault**. The app restarts with the restored data.
