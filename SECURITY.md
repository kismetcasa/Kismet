# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue or
pull request, and do not disclose the issue publicly until it has been resolved.

Use GitHub's private reporting: go to the
[**Security**](https://github.com/kismetcasa/Kismet/security) tab →
**Report a vulnerability**. This opens a private advisory visible only to the
maintainers.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (a proof of concept if possible),
- the affected surface (URL, endpoint, or file).

## Scope

**In scope:** the Kismet web app and its API (https://kismet.art) and the code in this
repository.

**Out of scope** (report elsewhere, or not applicable):

- Third-party dependencies — report to the upstream project. We track advisories via
  `npm audit` + Dependabot; see `SCALING.md` §7 for our current posture.
- The underlying Base / Zora / Arweave protocols and the smart contracts we build on.
- Volumetric issues (DoS/DDoS, rate-limit exhaustion), spam, and social engineering.

## Guidelines for good-faith research

- Do not access, modify, or delete data that isn't yours — use test accounts.
- Do not run automated scans or generate load that degrades service for other users.
- Give us reasonable time to remediate before any public disclosure.

Research conducted in good faith under this policy is welcome, and we will not pursue
action against researchers who follow it.

## Supported versions

Only the currently deployed `main` branch is supported. Kismet deploys continuously;
there are no tagged releases or backports.
