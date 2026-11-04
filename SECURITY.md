# Security Policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/freeknet/metaplate/security/advisories/new)
so the report, discussion, and any coordinated fix remain private.

Include the affected Metaplate version or commit, Node.js version, runtime or
framework, a minimal reproduction, and the impact you believe is possible. Do
not include credentials, proprietary fonts, or sensitive generated images.

## Supported versions

Only the latest published version is supported. Security fixes ship in a new
release rather than being backported to older minor versions.

## Scope

Examples of issues that are in scope include:

- path traversal or unintended file access during package font loading;
- unsafe handling of malformed or attacker-controlled image data;
- generated markup or headers that allow injection beyond the documented API;
- package or release-pipeline compromise affecting published npm artifacts.

Ordinary rendering bugs, unsupported Satori CSS, framework integration
questions, and feature requests belong on the public issue tracker.
