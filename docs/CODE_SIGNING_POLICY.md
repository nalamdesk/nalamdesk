# Code Signing Policy — NalamDesk

**Status:** Prepared, not yet active.
**Last updated:** 2026-10-25

## Current state

NalamDesk desktop installers and update artifacts are currently
**unsigned**. Builds are produced by GitHub Actions on GitHub-hosted
runners and published to the public `nalamdesk/releases` repository
without a code-signing step. Windows users may see SmartScreen /
Windows Defender warnings ("unknown publisher", "potentially unwanted
software") when installing or updating; this is expected for the beta
and is disclosed on the download page and in release notes.

## Why unsigned

- NalamDesk is an open-source (AGPL-3.0) beta project with no
  commercial revenue; purchasing an OV/EV code-signing certificate is
  not currently funded.
- An application to the **SignPath Foundation** (free code signing for
  open-source projects) is in preparation. Until it is approved and
  integrated, releases remain unsigned and are disclosed as such.

## Build integrity (current)

- All release builds run on **GitHub-hosted runners only**
  (`windows-latest`, `ubuntu-latest`, `macos-latest`).
- The workflow (`.github/workflows/build.yml`) checks out the tagged
  commit, installs dependencies, builds the Angular + Electron bundle,
  and packages via `electron-builder`.
- No secrets beyond the release-publishing token are used; CI never
  prints secrets.
- Source and build provenance are available via GitHub's audit log and
  the published release artifacts.

## Planned signing (target)

Once a signing provider is available (SignPath Foundation or a
purchased certificate):

1. Build produces an unsigned installer as a GitHub Actions artifact.
2. The artifact is submitted to the signing provider via its GitHub
   Action (`signpath/github-action-submit-signing-request` or
   `electron-builder` with `WIN_CSC_LINK`).
3. The signed artifact is downloaded and published in place of the
   unsigned one.
4. Release notes state the publisher identity and signing status.
5. `desktop/package.json` `win.forceCodeSigning` is set to `true` and
   the `signatureClaim()` in `desktop/src/main/updates/updateFeed.ts`
   is updated to reflect verified signatures.

## Disclosure policy

- Every release is marked with its signing status (signed/unsigned) in
  the release notes.
- The download page states that Windows/macOS beta builds are unsigned
  until signing lands.
- Users are given instructions to allow unsigned installers through
  Windows Defender / SmartScreen where applicable.

## Contact

Code-signing and supply-chain questions: `hello@nalamdesk.com`.
