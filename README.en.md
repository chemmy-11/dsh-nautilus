# dsh-nautilus

English | [中文](./README.md)

An observation plugin for DeepSeek Harness (`dsh`, package `@dsh-external/dsh-nautilus`): **session-level quantitative observation** — per-turn telemetry (tokens / cache / duration / TPS + self-review) and curve-shape analysis, plus an OS/GPU collection layer (pulse). All observation data is stored privately (`~/.dsh/nautilus/`) and survives restarts and reloads without loss or double-counting.

> ⚠️ **The vault-observation leg was retired on 2026-09-27**: the plugin no longer reads or writes any vault (the old "Vault observation" panel and the `/api/nautilus/{state,vault,action}` routes are gone). For note search / move / rename, use the `/obsidian` skill on the **session side** (it resolves the active vault from Obsidian's `obsidian.json` and handles multiple vaults).

## ① Vault observation (retired)

Since 2026-09-27 the plugin **does not observe vaults**: full scan, `fs.watch` edit watching, the vault dashboard and pointing switches were all removed (vault-side work belongs to the session-side `/obsidian` skill, which handles multiple vaults naturally).
The legacy tables `vault_meta` / `edit_event` / `vault_config` are **kept, not dropped** (red line: never destroy existing data), but no code reads or writes them.

## ② Session telemetry (L-field readings)

Turning "how far a conversation moved the knowledge base" into numbers — **session-level LLM observability + quantified self-review + curve-shape analysis**:

- **Metric definitions**: tokens (input/output/cache-hit), cache hit & miss rates (miss rate = the A projection), TPS & decode time, and a per-turn subjective clarity self-rating (0–1) — **objective and subjective tracks cross-validate each other, bounding each side's bias** (the objective curve is confounded by cache warm-up and novel topics; self-reports by reporting bias);
- **Direct official-event capture**: subscribes to the host's `session/event` (**zero host-source modifications, no third-party plugin dependencies**), with data isolated in a private directory (`~/.dsh/nautilus/`, SQLite);
- **Five-view workbench** (global panel: overview / curves / hypotheses / prophecies / report) plus a per-turn drawer; curves support **time tiers (1 week / 1 month), metric switching (miss rate / cumulative input / TPS / duration), a turn axis, proportional zoom, panning, fullscreen, hover summaries and click-through to the full transcript**;
- **Repeatable analysis pipeline**: shape classification (sigmoid / rising / falling / inverse-sigmoid) · characteristic-time (τ_e) detection · bucketed comparison — first run: **sessions in the pointed workspace showed a 13.7% miss rate vs 5.6% elsewhere** (grouped by vault pointing at the time), consistent with knowledge work's higher exploration density;
- **Self-review coverage**: per-session coverage badge (assessed / total turns + missing turn numbers), warning below 80%;
- **Hypothesis board**: P1–P9 annotations (pending / investigating / verified) with analysis conclusions written back.

> "L-field" is the author's personal research framing (L-theory); external readers can treat this panel simply as a **session-level LLM observability dashboard** — the metrics themselves (tokens / cache / TPS / self-review) are standard observability quantities.

## Pointing & views

- The plugin keeps a single pointing: the **L-field pointing** (the workspace root a session belongs to), switched inside the workbench's **"L-field readings (independent pointing)"** panel (history never deleted); the vault pointing was retired with the vault-observation leg;
- **Two view modes** live in the same panel: `global` (all workspaces) / `pointed` (the pointed workspace) — switching it changes the data scope for curves, hypotheses and the report;
- Session attribution rule: **the workspace a session was initiated in** — sessions started inside the pointed workspace form the pointed view; everything else appears only in the global view; historical sessions are back-filled by the same rule;
- Two dashboard views: **global** (all workspaces) / **〈pointed short name〉** (sessions initiated in the pointed workspace) — comparative analysis is a view switch.

## Compatibility

- **Host support matrix**: `dsh` **0.1.5-rc.2** (stable, in use, verified) + **0.1.6-alpha.2** (side-by-side install via `dsh-next`, verified — see the adaptation run below); peer range `@deepseek-ai/dsh-host-webserver` = `^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1` — **every branch must carry a prerelease tag**: by semver's prerelease rule `0.1.6-alpha.2` can only be matched by a comparator with the same `[major,minor,patch]` and a prerelease, so a bare `^0.1.6` would silently exclude the alpha line (`check:deps` R4 blocks that); a tagged branch covers both the alpha and the eventual stable;
- **Contract surface**: the host half consumes only official `session/event`, `ctx.webServer.register` and `ctx.tools.register`; the client half consumes only `ctx.slots` (`conversation.view`). No host implementation is imported, so prerelease upgrades need no code change;
- **Runtime deps**: only in-box packages shipped by the dsh installation are imported — `@deepseek-ai/cordis` (types), `@deepseek-ai/schemastery` (config schema), `@deepseek-ai/dsh-host-webserver` (route types). The unscoped `cordis`/`schemastery` are not part of the installation closure and have been migrated away;
- **Client entry**: a client plugin is an ordinary Cordis plugin (`Context` from `@deepseek-ai/cordis`; `@deepseek-ai/dsh-client-runtime` was removed in 0.1.5); the UI registry `ctx.slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`; cross-plugin imports are type-only and the runtime requires only the baseline `react`;
- **Adaptation run (2026-09-13, dsh 0.1.5-rc.2)**: the contract surface was diffed first — the rc.1 → rc.2 artifacts of `dsh-host-webserver` / `dsh-session` / `dsh-tools` / `dsh-client-ui-renderer` / `dsh-client-ui-conversation` are byte-identical apart from the version field (no interface change, hence no code change); the devDep is pinned exactly to `0.1.5-rc.2` (cordis 4.0.2 / schemastery 3.18.2 match rc.2's own dependencies); `typecheck` / `build` / `test` (12/12) / `check:deps` / `check-meta` / the client shim all pass; the isolated-`DSH_HOME` entry smoke passes (Standard Schema defaults and invalid-value rejection + 8 routes + 1 tool + 2 event subscriptions + 6 disposers + fresh DB at schema v3 / 9 tables). The previous 0.1.5-rc.1 run (2026-09-10) was equally green.

- **Adaptation run (2026-09-20, dsh 0.1.6-alpha.2 via the side-by-side `dsh-next` install)**: the contract surface was checked item by item against the type declarations under `C:\Users\15266\dsh-next\node_modules\@deepseek-ai\*` — slot registration options (`keyed -> options.key` / `list -> options.id|order|label`, label still accepting a thunk, plus a new optional `priority`), `ctx.layout.selectPanel(MainPanelId|null)`, `sidebar.panellist` and `SidebarPanelMetadata`, `WebRoute{kind,path,handler}`, `ctx.subprocess` (`spawn(graceMs/maxBytes/signal)` + `exitCode/signal/readFrom`) and the `dsh.client` manifest fields (`platform/inject/immediately?/external?`) are all unchanged, hence **no code change**; a `^0.1.6-alpha.1` peer branch was added (devDep still pinned to `0.1.5-rc.2`, both hosts coexist); `check:deps` gained R4 (every host peer branch must carry a prerelease tag) with a negative test (a bare `^0.1.6` is rejected with the offending branch named). **On-host verification**: 0.1.6 was booted with `dsh-next --profile web --patch <temp overlay>` on port 3099 (the overlay is process-local, **the profile is untouched**): the startup log shows `[nautilus] Pulse OS/GPU layer mounted (sub-plugin)` and `[pulse] mode=auto interval=5000ms exec=ctx.subprocess db=...\.dsh-next\nautilus\nautilus.db`; the boot graph contains our row (rev `a05f2c1db892a264-51`) and the served bundle carries the workbench and heartbeat-control markers; `/api/nautilus/{state,vault,lfield,m2/state,m2/analysis,m2/annotations,pulse/state}` all return **200** (note: `state`/`vault` were retired on 2026-09-27 with the vault-observation leg) (pulse: 15 metrics, `shell=powershell`, `gpuOk=true`); `POST /pulse/control` switches to 1s -> `{mode:auto,intervalMs:1000}`, `{mode:manual,sample:true}` -> ticks 5 -> 6, and an out-of-range tier -> **400**; all six gates pass (`test` 22/22).

## Installation

```sh
# If the repository is not renamed yet (still dsh-nexus), replace dsh-nautilus with dsh-nexus;
# after the rename GitHub redirects the old name automatically.
dsh plugin --profile <name> add github:chemmy-11/dsh-nautilus
```

This repository does not commit `lib/`, so a **git-form install builds in place at install time** (`prepare` / `prepack` → `scripts/prepare.mjs`). pnpm ≥10 **requires allowing `allowBuilds` in the profile's `pnpm-workspace.yaml`** (key like `@dsh-external/dsh-nautilus@git+…#<sha>`) — measured: without it pnpm fails loudly and prints the exact key (the quieter failure mode is worse: an installed package with no `lib/`, which only breaks at load time); allowing it authorizes running the package's build code at install time, so **pin a commit SHA**. The build probes `$DSH_CHECKOUT` / `~/dsh-harness` and falls back to npm-devDeps mode (devDependencies are installed by the package manager for git installs). A local `npm install` / `npm ci` never builds implicitly (use `npm run build`).

Config example (in the profile's `cordis.patch.yml`; every field has a default, so configuration is usually unnecessary):

```yaml
- id: nautilus
  config:
    lField:
      enabled: true
      historyDays: 30
    pulse:            # OS/GPU collection sub-plugin
      intervalMs: 5000
      enableCounters: true
      enableGpu: true
```

## API (same-origin)

| Endpoint | Description |
|---|---|
| `GET /api/nautilus/m2/state` | session readings (latest / totals / curve / selfcheck coverage; `?root=all` switches to the global view) |
| `GET/POST /api/nautilus/m2/annotations` | hypothesis annotations read/write |
| `GET /api/nautilus/m2/turn-text` | full Q&A transcript of a turn |
| `GET /api/nautilus/m2/analysis` | white-box analysis (sigmoid / bursts / τ_e) |
| `GET/POST /api/nautilus/lfield` | L-field pointing status / switch |

## Build

```sh
DSH_CHECKOUT=<dsh-checkout> bash scripts/build.sh   # = node scripts/prepare.mjs (host tsc + client esbuild)
```

The build chain is pure Node (`scripts/prepare.mjs` + `scripts/build-client.mjs`), independent of bash environment differences.

**Two build modes** (auto-selected by `scripts/prepare.mjs`):
- **checkout mode** (local dev): probes `$DSH_CHECKOUT` / `~/dsh-harness` → junction-links `cordis`/`schemastery`/`dsh-host-webserver` from the checkout and reuses its tsc/esbuild;
- **npm-devDeps mode** (CI / no checkout): `npm install` the devDependencies, then build from local deps — no dsh source needed.

## CI

`.github/workflows/ci.yml` runs `typecheck` + `build` (npm-devDeps mode) + tests + metadata checks (bundle patch / client halves / files manifest) on every push/PR; `.github/workflows/release.yml` builds a tgz and creates a GitHub Release on `v*` tags.

## Design principles

- **Independently installable**: depends only on official `cordis`/`schemastery`/`dsh-host-webserver`, coupled to no other plugin;
- **Observation leaves traces**: edit events and session readings accumulate forward from deployment (SQLite persistence — no loss, no double-counting across restarts/reloads);
- **Boundary awareness**: **never touches a vault** (that leg is retired); data kept private under `~/.dsh/nautilus/`, never mixed with other data sources;
- **Attribution never mixes**: sessions are attributed by their initiating workspace; pointed-workspace sessions and other workspaces are analyzed separately (one classification rule, no time-based epochs).

## Security note

Installing a plugin means running third-party code with your own permissions. Read the source before installing; this plugin **does not access any vault** and only writes its own data directory `~/.dsh/nautilus/`.
