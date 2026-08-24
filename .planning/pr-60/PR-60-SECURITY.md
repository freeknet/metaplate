---
phase: PR-60
slug: release-v0.5.0
status: verified
threats_open: 0
asvs_level: 1
block_on: high
created: 2026-08-24
---

# PR #60 / v0.5.0 — Security Verification

## Trust Boundaries

| Boundary | Description | Data crossing |
|----------|-------------|---------------|
| Public API | Consumer-supplied routes, origins, dimensions, font declarations, encoders | Configuration and local paths |
| Image verifier | Untrusted PNG, JPEG, and WebP bytes | Binary container data |
| Optional peers | Dynamically loaded renderer/framework packages | Executable dependency code |
| Release pipeline | Repository source to verified npm tarball | Build artifacts and provenance credentials |

## Threat Register

| ID | STRIDE | Severity | Component | Mitigation | Status |
|----|--------|----------|-----------|------------|--------|
| S-01 | Spoofing | high | Metadata origin | HTTP(S)-only URL parsing; credentials and non-origin components rejected | closed |
| S-02 | Tampering | high | Route/path composition | Reject query, fragment, slash confusion, controls, and literal/encoded dot segments | closed |
| S-03 | Information disclosure / elevation | high | Package font loader | Validate npm package names and contain resolved font files within the package directory | closed |
| S-04 | Denial of service | high | Image parsers | Container length, marker, chunk, scan, and terminator bounds checks | closed |
| S-05 | Tampering | medium | Custom encoder | Require Uint8Array and match known byte signatures to declared formats | closed |
| S-06 | Information disclosure / tampering | medium | Web Response headers | Normalize with Headers and set authoritative Content-Type last | closed |
| S-07 | Elevation / tampering | high | Optional peer loading | Literal import targets and exact missing-peer error attribution | closed |
| S-08 | Denial of service / integrity | medium | CLI verification | Validate dimensions and isolate/aggregate every target failure | closed |
| S-09 | Tampering / elevation | high | Package smoke process execution | Random temporary directories and argument-array child processes | closed |
| S-10 | Tampering / elevation | critical | Release dependency smokes | Install only the local tarball offline; link exact npm-ci-installed dependencies after lockfile version checks | closed |
| S-11 | Tampering / elevation | high | npm publish workflow | SHA-pinned actions; verification and packing separated from credentialed publish job | closed |
| S-12 | Repudiation / supply-chain integrity | medium | npm publication | Provenance plus existing-version integrity comparison | closed |

## Accepted Risks

No accepted risks.

## Security Audit Trail

| Date | Threats | Closed | Open | Result |
|------|---------|--------|------|--------|
| 2026-08-24 | 12 | 12 | 0 | SECURED — retroactive STRIDE, ASVS L1 |

## Sign-Off

- [x] All threats have a disposition.
- [x] No accepted risks require documentation.
- [x] `threats_open: 0` confirmed after mitigation re-audit.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-08-24
