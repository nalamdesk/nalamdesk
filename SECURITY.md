# Security Policy

## Supported versions

NalamDesk is in beta. Security fixes are applied to the latest release
on the `master` branch and published via the automated release pipeline.
Older releases are not patched; users are expected to update to the
latest version.

## Reporting a vulnerability

Do **not** open a public issue. Report privately via GitHub
**Security → Report a vulnerability** (private vulnerability reporting),
or email `hello@nalamdesk.com`.

Include: affected version/commit, steps to reproduce, and impact.
We will acknowledge within 72 hours and coordinate a fix before any
public disclosure.

## Scope notes

* NalamDesk stores real patient data offline on clinic devices. Never
  include patient data, credentials, keys, or device backups in any
  report, issue, or PR.
* Secret scanning and push protection are enabled on this repository;
  CI never prints secrets.

## Code signing and supply chain

* Release artifacts are currently **unsigned**; see
  `docs/CODE_SIGNING_POLICY.md`.
* All release builds run on GitHub-hosted runners only. Source and
  build provenance are available via GitHub's audit log and the
  published release artifacts.
* The desktop app verifies update feed integrity via SHA-512 checksums;
  it does not claim full code-signature verification (see
  `desktop/src/main/updates/updateFeed.ts`).

## Privacy

See `docs/PRIVACY.md` for the full privacy policy. In summary:
clinical data stays on the clinic device, encrypted at rest; there is no
telemetry or analytics.
