# Project Euler Workbench Roadmap

This document gives a single high-level view of the Project Euler Workbench release history, the current development line, and future work that has actually been agreed.

For detailed implementation requirements, see the version-specific milestone documents under `docs/`.

## Status legend

- **Released** — published as a tagged upstream release.
- **Completed on `develop`** — implemented and merged into the current integration branch, but not yet part of a new stable release.
- **Planned** — explicitly included in an existing development milestone.
- **Unscheduled** — a known direction or compatibility rule without a committed release version.

## History and provenance

This repository continues the original Project Euler Workbench developed in `AuroraLilja8514/test-tmp-3344552`.

The current fork does not contain the historical release tags, so the v0.1–v0.3 entries below are reconstructed from the original upstream tags, release notes, and versioned README files. Current v0.4 work is tracked in this fork on `develop`.

---

## v0.1.0 — Core self-contained Workbench

**Status:** Released — 2026-08-11

The first release established the architecture that still defines the product:

- Electron desktop application with Project Euler in the left pane and JupyterLab in the right pane.
- Exact `https://projecteuler.net/problem=N` URLs bind to one local `problems/NNNN/solution.ipynb` notebook.
- Save-before-navigation, save-before-problem-switch, and save-before-exit guarantees.
- Previous Jupyter sessions are shut down when switching problems instead of accumulating kernels.
- Self-contained bundled CPython 3.13 + JupyterLab environment; packaged builds do not fall back to host Python, Conda, or user site-packages.
- Loopback-only Jupyter server with a random launch token, disabled terminals, locked extensions/plugins, sandboxed Electron renderers, and external links opened in the system browser.
- CI, packaged-runtime verification, and GitHub Release publishing were established for verified desktop builds.
- Initial release artifacts covered Windows, macOS, and Linux formats.

The original design intended the persistent Electron partition to preserve Project Euler login state between launches. A later-discovered limitation with true session cookies meant that this did not work reliably; the missing behavior is addressed on the v0.4 development line.

---

## v0.2.0 — True portable-folder distribution

**Status:** Released — 2026-08-11

v0.2 shifted distribution toward a predictable portable application layout:

- Windows and Linux portable releases became complete extracted application folders rather than a single executable-style portable target.
- Portable persistent state moved under a neighboring `data/` directory so notebooks, Electron profile/session state, Jupyter state, temporary files, and runtime state move together with the portable folder.
- Portable package layout and path behavior gained dedicated verification, including a Windows path-test fix.
- GitHub Actions dependencies were updated to current Node 24-compatible majors.

This version established the core rule that replaceable program/runtime files and persistent user data must remain separate.

---

## v0.2.1 — Installer + portable distribution model

**Status:** Released — 2026-08-11

v0.2.1 finalized the distribution model later retained by v0.3:

- Windows x64 NSIS installer.
- Windows x64 portable ZIP.
- Linux x64 portable `tar.gz`.
- Installed-mode notebooks live outside the application installation directory.
- Portable-mode data stays in the neighboring `data/` tree.
- Installed and portable profiles remain intentionally separate.
- Uninstall keeps application data rather than deleting user notebooks/state.
- macOS builds were removed from the active release matrix.

---

## v0.3.0 — Daily workflow, knowledge, packages, and AI

**Status:** Released — 2026-08-11

v0.3 turned the two-pane Workbench into a broader local Project Euler working environment.

### Problem workflow

- `Not Started` / `In Progress` / `Solved` problem status.
- Local dashboard.
- `Run All + Save` with elapsed-time recording.
- Global kernel-side `submit(value)` helper using a tokenized localhost bridge; Electron fills the Project Euler answer field but never clicks the site's submit button.
- Existing notebooks are preserved during upgrades and are not rewritten merely because the Workbench version changes.

### Solutions and personal knowledge

- `solution.ipynb` remains the editable draft/working notebook.
- Explicit `Save as Solution` snapshots under stable solution IDs.
- User-created code snippets only; the Workbench ships no bundled solution/algorithm snippets.
- Full-text search across working notebooks, saved solutions, snippets, and generated articles.
- Local statistics derived from workspace metadata.

### Managed Python packages

- User package install/list operations run through the bundled Python.
- User packages live in a persistent `python-packages/` layer rather than modifying the bundled base runtime.
- Only the Euler kernel receives that package layer; the Jupyter Server itself remains isolated from it.
- Managed uninstall is constrained to files recorded by the matching distribution inside the managed package root.

### AI / Articles

- User-configured OpenAI-compatible endpoint and model.
- Explicit source selection: notebook/saved-solution content is sent only when chosen by the user.
- Project Euler pages are not scraped for AI generation.
- Generated analysis is stored as independent editable Markdown articles.
- API keys remain session-only by default; remembered keys use Electron secure storage.

### Release / upgrade model

- Windows x64 installer + portable ZIP.
- Linux x64 portable `tar.gz`.
- macOS not built.
- Installed and portable upgrade paths preserve notebooks, settings, user packages, and other persistent data outside replaceable application files.

Detailed v0.3 requirements: [`docs/V0.3_MILESTONES.md`](docs/V0.3_MILESTONES.md).

---

## v0.4.0 — Hardening, recovery, and continued development

**Status:** In development on `develop`

v0.4 keeps the v0.3 Electron + JupyterLab architecture and concentrates first on security boundaries, failure recovery, and maintainability before further product expansion.

### Completed on `develop`

- Reject pip option-style package specifications and terminate pip option parsing before user requirements.
- Prevent privileged local BrowserWindows from navigating to remote content while retaining Workbench preload privileges.
- Accept privileged `tools:*` IPC only from the active Tools window.
- Add a restrictive Content Security Policy to the Tools renderer.
- Add a bounded timeout for OpenAI-compatible AI requests.
- Add timeouts to managed package operations so stalled `pip list` / `pip install` processes cannot hang indefinitely.
- Securely persist Project Euler **session cookies** across application restarts using Electron `safeStorage`, restoring them before the first left-pane navigation.
- Preserve normal Chromium ownership of persistent cookies and DOM storage instead of duplicating them.
- Ensure explicit Project Euler logout removes the encrypted session snapshot and cannot be undone by a stale asynchronous cookie write.

### Planned for v0.4

#### JavaScript build repeatability

- Add and maintain an npm lockfile for Electron/build tooling.
- Change CI/release dependency installation to `npm ci` after the lockfile exists.
- Keep this separate from Python dependency policy.

#### CI and release discipline

- Keep `develop` as the integration branch and `main` as the stable/release branch.
- Require unit and real Jupyter smoke CI before development PRs enter `develop`.
- Before v0.4.0 release, run packaged-runtime, portable-layout, and final release-asset verification on the release candidate.
- Retain the existing Windows x64 installer + portable ZIP and Linux x64 portable `tar.gz` unless a future explicit milestone changes the matrix.

#### Product development

Further v0.4 product work will build on the existing `WorkbenchService` / `JupyterManager` boundaries. New features must preserve:

- explicit user control over saved solutions, snippets, and AI source selection;
- local-first workspace storage;
- save-before-navigation/exit guarantees;
- separation between Project Euler content, Jupyter content, and privileged Electron APIs;
- no automatic answer submission to Project Euler.

No additional v0.4 product feature is treated as committed until it is added to a milestone or accepted development PR.

Detailed v0.4 requirements: [`docs/V0.4_MILESTONES.md`](docs/V0.4_MILESTONES.md).

---

## Beyond v0.4

**Status:** Unscheduled unless explicitly noted below.

There is currently **no committed v0.5 feature set**. Future entries should be added here only after a concrete development decision is made.

The following long-term rules are already established:

- v0.4.x remains on the **CPython 3.13 series**.
- Within Python 3.13, builds should prefer the latest stable supported patch release and the highest stable compatible Python library versions.
- A Python minor-series move such as 3.13 → 3.14 is a separate compatibility decision and must not happen silently during routine dependency refreshes.
- macOS is not currently in the active distribution matrix; adding it back requires an explicit platform milestone.
- Persistent user data must continue to survive normal application upgrades and remain separate from replaceable application/runtime files.

## Maintaining this roadmap

When a release is published:

1. Move its development section from "In development" to "Released" and record the release date.
2. Keep the high-level outcome here; detailed acceptance criteria should remain in version milestone documents.
3. Add future versions only when scope is actually agreed.
4. Do not rewrite historical entries to hide bugs or changed decisions; record the later fix in the version where it was addressed.
