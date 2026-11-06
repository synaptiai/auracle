# Changelog

This file records each release.
Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-06

This release updates dependencies only. It changes no behavior.

### Changed

- The image runs on Node 22.23.4. The base image names that exact release.
- The mailbox adapter uses imapflow 2.10.0 and nodemailer 10.3.1.
- The FreeScout example stack uses FreeScout 2.2.23.
- The test mail server is GreenMail 2.1.15.

### Security

- The runtime image carries ip-address 10.7.4 or later, which fixes
  GHSA-rxp7-6hxx-x8q5.
- The development tools carry patched vite, minimatch and glob. These
  packages do not reach the runtime image.

## [0.1.0] - 2026-10-09

The first public release.

### Added

- The core runs a ticket from intake to an approved reply under two
  independent evidence gates.
- Intake reads a webhook and an IMAP mailbox. Adapters reach FreeScout and a
  mailbox over IMAP and SMTP.
- The operator console lets reviewers clear the queue of cases that need a
  person.
- Synapti licenses the repository under the Apache License 2.0.

[0.1.1]: https://github.com/synaptiai/auracle/releases/tag/v0.1.1

[0.1.0]: https://github.com/synaptiai/auracle/releases/tag/v0.1.0
