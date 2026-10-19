---
sidebar_position: 2
---

# Setup Guide

This guide describes how to set up the NalamDesk development environment.

## Prerequisites

- **Node.js**: Version 22.5 or higher (`engines` in `desktop/package.json`).
- **npm**: Included with Node.js.
- **Git**: For version control.

## Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/sankara-sabapathy/nalamdesk.git
    cd nalamdesk
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Install Application Dependencies:**
    
    The application uses Electron, Angular, and native modules (`better-sqlite3-multiple-ciphers`, `argon2`). The UI stack is Angular 17 with TailwindCSS and daisyUI.
    
    *   **Windows**: Requires [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop development with C++) and Python 3.
    *   **macOS**: Requires Xcode Command Line Tools (`xcode-select --install`) and Python 3.
    *   **Linux**: Requires `build-essential` and Python 3.

    `npm install` inside `desktop/` triggers `electron-builder install-app-deps` (`postinstall`) to recompile native modules for Electron. `npm run postinstall` can be run manually if automatic scripts are disabled.
    ```bash
    npm run postinstall
    ```

## Local development ports

Default ports are defined in the repo-root [`.env.development`](https://github.com/sankara-sabapathy/nalamdesk/blob/main/.env.development). Override locally with `.env.local` (gitignored).

| Port | Service |
|------|---------|
| 3000 | Installed desktop local API (production Electron app) |
| 3001 | Cloud sync API (desktop cloud sync) |
| 3002 | Desktop dev local API (`cd desktop && npm start`) |
| 4200 | Desktop Angular dev server |

Dev and installed apps use separate data directories (`NalamDesk-Dev` vs `NalamDesk`) and can run alongside each other.

## Running the Application

To start the desktop application in development mode:

```bash
cd desktop
npm start
```

This command will:
- Start the Angular development server.
- Compile the Electron main process.
- Launch the Electron application window.

## Building for Production

To build the application for your OS:

- **Windows:** `npm run dist:win`
- **Linux:** `npm run dist:linux` — clinic artifact is the `.deb` in `desktop/release/` (`sudo apt install ./nalamdesk-desktop_*_amd64.deb`). The AppImage is secondary and requires FUSE 2; do not extract it.
- **Mac:** `npm run dist:mac`

Packaged Settings version comes from `app:getVersion` (`app.getVersion()` plus optional embedded commit). Feature CI fails the job if artifact names, `latest*.yml`, `build-identity.json`, and the displayed version disagree.
