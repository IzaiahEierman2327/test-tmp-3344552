# Project Euler Workbench

A self-contained desktop Project Euler workspace with the Project Euler website on the left and JupyterLab/Python on the right.

> This is an unofficial tool and is not affiliated with Project Euler.

## Project roadmap

See [`ROADMAP.md`](ROADMAP.md) for the release history from v0.1.0 through v0.4.0, plus future work that has been explicitly agreed.

## v0.4.0 distributions

- Windows x64 installer: `euler-workbench-0.4.0-win-x64-setup.exe`
- Windows x64 portable: `euler-workbench-0.4.0-win-x64.zip`
- Linux x64 portable: `euler-workbench-0.4.0-linux-x64.tar.gz`
- macOS is not built.

Every distribution includes its own Python, JupyterLab, IPython kernel and scientific packages. The target machine does not need Python, Conda, Jupyter or Node.js installed.

See [`docs/V0.4_RELEASE_NOTES.md`](docs/V0.4_RELEASE_NOTES.md) for the complete v0.4.0 release notes.

## v0.4.0 hardening

v0.4.0 keeps the v0.3 workflow while strengthening security, recovery and build discipline:

- Project Euler session cookies are encrypted with Electron `safeStorage` and restored before the first left-pane navigation, so login state can survive application restarts even when the site uses session cookies.
- Explicit Project Euler logout removes the encrypted session snapshot and is protected against stale asynchronous cookie writes.
- Managed package specifications reject pip option injection; `pip list` and `pip install` operations have bounded lifetimes.
- Privileged local BrowserWindows cannot navigate to remote content while retaining Workbench preload capabilities, and `tools:*` IPC is restricted to the active Tools window.
- OpenAI-compatible requests have a bounded timeout.
- The Electron/build toolchain is locked with `package-lock.json`; CI and release builds use `npm ci`.

The Python runtime policy is intentionally different from the JavaScript lockfile policy: v0.4.x remains on CPython 3.13 and prefers the latest stable supported 3.13 patch plus the highest stable compatible Python libraries.

## Upgrading without losing work

### Installed Windows edition

Close Project Euler Workbench and run the newer `...-setup.exe` normally. The application keeps the same stable Electron Builder `appId`, so the NSIS package is an upgrade of the same application. Replaceable application files and the bundled base Python runtime live in the installation directory, while user content lives elsewhere:

```text
Documents/
└── Project Euler Workspace/       # notebooks, saved solutions, articles, snippets

per-user application data/
├── python-packages/               # GUI-managed pip packages
├── settings/                      # AI configuration
├── runtime-state/
└── Electron profile/session data
```

The installer has `deleteAppDataOnUninstall: false`. Normal upgrades therefore do not target notebooks, application data, AI settings or the managed pip package layer.

### Portable edition

Close the application and extract the new portable archive over the program files while **keeping the existing `data/` directory**. Release archives contain no `data/` directory. Do not delete the old portable folder before copying `data/` somewhere safe.

Portable persistent layout:

```text
Project Euler Workbench/
├── euler-workbench.exe            # Linux: euler-workbench
├── resources/runtime/python/      # replaceable bundled base runtime
└── data/
    ├── workspace/
    ├── python-packages/
    ├── settings/
    ├── electron-user-data/
    ├── electron-session-data/
    ├── runtime-state/
    ├── crash-dumps/
    ├── tmp/
    └── state.json
```

Moving the complete portable folder while the app is closed carries the workspace and login/session state with it. A remembered AI key uses OS secure storage and may need to be entered again after moving the portable folder to another computer/user account.

## Core problem workflow

The application opens maximized with Project Euler on the left and JupyterLab on the right. Only an exact `https://projecteuler.net/problem=N` URL binds a problem to a notebook.

`solution.ipynb` is always the editable working/draft notebook. New notebooks start with one empty Python code cell; Workbench identity is stored in notebook metadata instead of user-visible template cells. Existing notebooks are never rewritten merely because Workbench is upgraded.

The top toolbar shows:

- current Project Euler problem/page;
- current notebook problem number;
- `Not Started` / `In Progress` / `Solved` status;
- number of explicitly saved solutions;
- latest `Run All + Save` duration;
- save state;
- actions for Dashboard, Solutions, Snippets, Search, Statistics, Packages and AI/Articles.

Navigation away from a problem still waits for JupyterLab `docmanager:save-all`. Switching problems also shuts down the old Jupyter session/kernel.

## Run All + Save

`Run All + Save` invokes JupyterLab's `notebook:run-all-cells` command, waits for it to complete, saves the notebook and records the elapsed time in local problem metadata. This is a run-time record, not a benchmark/regression framework.

## `submit(value)` pseudo-submission

Every Euler Python kernel receives a global `submit(value)` helper automatically:

```python
answer = 123456
submit(answer)
```

The helper sends the string value through a random-token localhost-only bridge to Electron. Electron requires the left pane to be on a Project Euler problem page and fills that page's answer input. It **never clicks the site's submit button**. The user reviews the value and submits it manually.

## Multiple solutions

`solution.ipynb` remains the working notebook. Workbench creates saved alternatives only when the user explicitly chooses **Save current notebook as solution**:

```text
problems/NNNN/
├── solution.ipynb
├── problem.json
├── solutions.json
├── solutions/
│   ├── s001.ipynb
│   ├── s002.ipynb
│   └── ...
└── articles/
```

Saved solutions have stable IDs plus user names, descriptions and tags. Workbench does not create automatic solution-version spam.

## User-only code snippets

Workbench ships **no algorithm or solution snippets**. A snippet can only be created by explicitly saving the active Jupyter cell written by the user. Snippets remember local provenance (for example the source problem), can be searched, inserted as a new code cell and deleted.

## Search and statistics

Workspace search covers source text in:

- working `solution.ipynb` files;
- explicit saved solution notebooks;
- user snippets;
- generated Markdown articles.

Statistics are derived from local data and include started/solved/in-progress problems, saved solutions, problems with multiple solutions, snippets, generated articles, Run All count and latest-run timing aggregates.

## Managed Python packages

The Packages UI uses the **bundled Python**, not system Python. Installs/upgrades use a persistent Workbench user layer (`python-packages/`) rather than modifying `resources/runtime/python`:

- install/upgrade: bundled `python -m pip install --target <python-packages> -- <requirement>`;
- list: bundled `python -m pip list --path <python-packages>`;
- uninstall: Workbench deletes only files listed by a matching distribution inside that managed directory and refuses paths outside it.

User-supplied package specifications that begin with `-` are rejected so they cannot be interpreted as additional pip command-line options. Package list/install subprocesses also have timeouts so a stalled package index or child process cannot leave the Tools workflow pending forever.

Jupyter Server itself never receives the managed package directory on `PYTHONPATH`; only the **Euler Python kernel** does. This prevents a user-installed package from shadowing JupyterLab's own bundled dependencies. Restart the kernel after package changes when a module was already imported.

## AI / Articles

The user configures:

- a full OpenAI-compatible completion endpoint URL;
- a custom model;
- temperature;
- optional API key.

Keys are session-only by default. If **Remember key** is enabled, Workbench uses Electron OS secure storage and never writes the plaintext key into `ai.json`.

AI is opt-in per generation. The user chooses whether to send the current working notebook and which saved solutions to include. Workbench sends user Markdown/code cell source from those selected notebooks; it does not scrape the Project Euler page for AI. Multiple selected sources request a comparison analysis.

Generated text becomes an independent editable local Markdown artifact:

```text
articles/a001/
├── article.md
└── article.json
```

The generation prompt requires the model to stay grounded in supplied user material and identify missing reasoning instead of inventing algorithms, measurements or results. AI requests have a bounded timeout if the configured endpoint stops responding.

## Runtime isolation

Production builds never resolve Python from the host PATH. The bundled runtime is under `resources/runtime/python`.

- Host `PYTHONPATH`, virtualenv and Conda settings are not inherited.
- Jupyter Server imports only from the bundled runtime.
- Only the `python3` kernelspec is available and displayed as **Euler Python**.
- The Euler Python kernel additionally receives the Workbench-managed user package path.
- Python user-site packages are disabled.
- Jupyter terminals are disabled.
- JupyterLab extension installation is read-only and plugins are locked.
- Jupyter and the `submit()` bridge listen only on `127.0.0.1` with fresh random tokens.

The bundled base environment includes JupyterLab/IPython, NumPy, SymPy, SciPy, mpmath, Matplotlib and NetworkX.

## Development and tests

```bash
npm ci
npm run prepare:runtime
npm run verify:runtime
npm test
npm run test:jupyter
npm start
```

Packaging/verification:

```bash
npm run dist
npm run verify:package
npm run verify:portable
```

CI covers workspace migration/preservation, solution snapshots, user snippets, search/statistics, mock OpenAI-compatible calls, API-key-at-rest behavior, Project Euler session-cookie persistence/logout behavior, managed-package path safety/timeouts, installer/portable upgrade guards and a real Jupyter/IPython smoke test for the tokenized `submit()` bridge.

See [`docs/V0.4_MILESTONES.md`](docs/V0.4_MILESTONES.md), [`docs/V0.4_RELEASE_NOTES.md`](docs/V0.4_RELEASE_NOTES.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for implementation and release details.
