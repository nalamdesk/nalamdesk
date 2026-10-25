# Security Policy

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
