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
- **Six-view workbench** (global panel: overview / alignments / sessions / alerts / curves / report) plus a per-turn drawer; curves support **time tiers (1 week / 1 month), metric switching (miss rate / cumulative input / TPS / duration), a turn axis, proportional zoom, panning, fullscreen, hover summaries and click-through to the full transcript**;
- **Repeatable analysis pipeline**: shape classification (sigmoid / rising / falling / inverse-sigmoid) · characteristic-time (τ_e) detection · bucketed comparison — first run: **sessions in the pointed workspace showed a 13.7% miss rate vs 5.6% elsewhere** (grouped by vault pointing at the time), consistent with knowledge work's higher exploration density;
- **Self-review coverage**: per-session coverage badge (assessed / total turns + missing turn numbers), warning below 80%;
- **Alignment ledger + sessions panel**: human "alignment 1–5" and self-assessment 1–5 are listed **turn by turn** (Δ = self − human).
  The **sessions view** lists past sessions (workspace · session name / turn count / time range / totals / **human coverage**);
  expand one to see per-turn details and **score past sessions retroactively** — re-submitting the same turn **overwrites** it
  (server-side upsert, no extra row); turns without source text have their scoring entry disabled with a visible reason.

> "L-field" is the author's personal research framing (L-theory); external readers can treat this panel simply as a **session-level LLM observability dashboard** — the metrics themselves (tokens / cache / TPS / self-review) are standard observability quantities.

## Views

Six views in the global panel: **overview / alignments / sessions / alerts / curves / report**.

- **Overview**: session reading totals, collector heartbeat, per-session list and per-turn drawer. Session attribution follows **the workspace a session was initiated in**
  (the workspace-pointing abstraction was removed in AL.4a; the panel is read-only, with no write path).
- **Alignments**: the **two-track ledger** of human "alignment 1–5" vs self-assessment 1–5 (paired per turn · Δ = self − human), boundary distribution,
  sample consistency and version surface. Turn naming is unified as **workspace name · session name · T\<turn\>**.
- **Sessions**: the list of past sessions — each row shows the server-derived `label` (**workspace name · session name**) plus turn count, time range,
  reading totals (in/out · cache · duration · average tps) and **human coverage** (scored / union of turns, so you can see how much is left without expanding).
  Expanding a row shows per-turn details (turn · time · question summary · in/out · cache · duration · tps · self · human · quote) with **one scoring entry per turn**:
  - **score past sessions retroactively**, adding or re-doing a judgement: tiers 1–5 plus an N/A exemption (no judgeable object); **tiers 4/5 require a quote** (server-side hard gate);
  - the scoring widget **names its target** (workspace name · session name · T\<turn\> plus source-text availability) and states whether submitting will **add** or **overwrite**;
    for already-scored turns it is **pre-filled with the current value** — pick another tier and submit to overwrite (server-side upsert, no extra row);
  - turns **without source text have the entry disabled** with a visible reason (the server rejects them with `no-turn-text`) — no fake buttons;
  - turns that have source text but **no readings** (metrics show `—`) are **still scorable** and are marked "text only";
  - after scoring, only that session's detail and its counters are refreshed (no full page reload).
- **Alerts**: OS-layer red-line alerting (threshold detection / evidence freezing / three-stage report / ledger / human adjudication).
- **Curves / report**: session reading curves (time tiers, metric switch, turn axis, fullscreen, hover drill-down) and the repeatable analysis report (sigmoid · τ_e · bucketed comparison).

## Compatibility

- **Host support matrix**: `dsh` **0.1.7-rc.1** (current, verified — see the adaptation run below) + **0.1.5-rc.2** (stable line, verified) + **0.1.6-alpha.2** (side-by-side install via `dsh-next`, verified); peer range `@deepseek-ai/dsh-host-webserver` = `^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1` — **every branch must carry a prerelease tag**: by semver's prerelease rule `0.1.6-alpha.2` can only be matched by a comparator with the same `[major,minor,patch]` and a prerelease, so a bare `^0.1.6` would silently exclude the alpha line (`check:deps` R4 blocks that); a tagged branch covers both the alpha and the eventual stable;
- **Contract surface**: the host half consumes only official `session/event`, `ctx.webServer.register` and `ctx.tools.register`; the client half consumes only `ctx.slots` (`conversation.view`). No host implementation is imported, so prerelease upgrades need no code change;
- **Runtime deps**: only in-box packages shipped by the dsh installation are imported — `@deepseek-ai/cordis` (types), `@deepseek-ai/schemastery` (config schema), `@deepseek-ai/dsh-host-webserver` (route types). The unscoped `cordis`/`schemastery` are not part of the installation closure and have been migrated away;
- **Client entry**: a client plugin is an ordinary Cordis plugin (`Context` from `@deepseek-ai/cordis`; `@deepseek-ai/dsh-client-runtime` was removed in 0.1.5); the UI registry `ctx.slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`; cross-plugin imports are type-only and the runtime requires only the baseline `react`;
- **Adaptation run (2026-09-13, dsh 0.1.5-rc.2)**: the contract surface was diffed first — the rc.1 → rc.2 artifacts of `dsh-host-webserver` / `dsh-session` / `dsh-tools` / `dsh-client-ui-renderer` / `dsh-client-ui-conversation` are byte-identical apart from the version field (no interface change, hence no code change); the devDep is pinned exactly to `0.1.5-rc.2` (cordis 4.0.2 / schemastery 3.18.2 match rc.2's own dependencies); `typecheck` / `build` / `test` (12/12) / `check:deps` / `check-meta` / the client shim all pass; the isolated-`DSH_HOME` entry smoke passes (Standard Schema defaults and invalid-value rejection + 8 routes + 1 tool + 2 event subscriptions + 6 disposers + fresh DB at schema v3 / 9 tables). The previous 0.1.5-rc.1 run (2026-09-10) was equally green.

- **Adaptation run (2026-09-20, dsh 0.1.6-alpha.2 via the side-by-side `dsh-next` install)**: the contract surface was checked item by item against the type declarations under `C:\Users\15266\dsh-next\node_modules\@deepseek-ai\*` — slot registration options (`keyed -> options.key` / `list -> options.id|order|label`, label still accepting a thunk, plus a new optional `priority`), `ctx.layout.selectPanel(MainPanelId|null)`, `sidebar.panellist` and `SidebarPanelMetadata`, `WebRoute{kind,path,handler}`, `ctx.subprocess` (`spawn(graceMs/maxBytes/signal)` + `exitCode/signal/readFrom`) and the `dsh.client` manifest fields (`platform/inject/immediately?/external?`) are all unchanged, hence **no code change**; a `^0.1.6-alpha.1` peer branch was added (devDep still pinned to `0.1.5-rc.2`, both hosts coexist); `check:deps` gained R4 (every host peer branch must carry a prerelease tag) with a negative test (a bare `^0.1.6` is rejected with the offending branch named). **On-host verification**: 0.1.6 was booted with `dsh-next --profile web --patch <temp overlay>` on port 3099 (the overlay is process-local, **the profile is untouched**): the startup log shows `[nautilus] Pulse OS/GPU layer mounted (sub-plugin)` and `[pulse] mode=auto interval=5000ms exec=ctx.subprocess db=...\.dsh-next\nautilus\nautilus.db`; the boot graph contains our row (rev `a05f2c1db892a264-51`) and the served bundle carries the workbench and heartbeat-control markers; `/api/nautilus/{state,vault,lfield,m2/state,m2/analysis,m2/annotations,pulse/state}` all return **200** (note: `state`/`vault` were retired on 2026-09-27 with the vault-observation leg) (pulse: 15 metrics, `shell=powershell`, `gpuOk=true`); `POST /pulse/control` switches to 1s -> `{mode:auto,intervalMs:1000}`, `{mode:manual,sample:true}` -> ticks 5 -> 6, and an out-of-range tier -> **400**; all six gates pass (`test` 22/22).

- **Adaptation run (2026-09-28, dsh 0.1.7-rc.1)**: the actual version was read first (`dsh --version` = 0.1.7-rc.1, `dsh-host-webserver` likewise; cordis 4.0.4 / schemastery 3.18.4) — **never inferred from a dist-tag**. The contract surface was checked item by item against the installed type declarations — `WebRoute{kind:'exact'|'prefix',path,handler}`, the `session/event` shapes (`turn/start{ turn }`, `step/start{ turn, step }`, `user/message`, `assistant/message{ turn, step, message.content, usage{ inputTokens, outputTokens, cacheReadTokens? } }`), `ToolDefinition{name,description,parameters,output}`, the client slots (`main` still kind `keyed`; `conversation.chat.assistant-actions`/`turnTail` still `list` · scope `session` · owner `{ messageId }`/`TurnTailOwnerProps`; `sidebar.panellist`) and the A-series additions (`ctx.llm.stream(GenerateOptions)`, `ctx.agentDefaultModel.currentSelection()`, `ctx.jobs.start(JobSpec)`) are all unchanged, hence **no code change**; a `^0.1.7-rc.1` peer branch was added (the four older branches stay) and the devDep was re-pinned exactly to `0.1.7-rc.1`; all six gates pass (`test` 55/55). On-host verification is archived as E29/E30.

## Installation

```sh
dsh plugin --profile <name> add github:chemmy-11/dsh-nautilus
```

This repository does not commit `lib/`, so a **git-form install builds in place at install time** (`prepare` / `prepack` → `scripts/prepare.mjs`). pnpm ≥10 **requires allowing `allowBuilds` in the profile's `pnpm-workspace.yaml`** (key like `@dsh-external/dsh-nautilus@git+…#<sha>`) — measured: without it pnpm fails loudly and prints the exact key (the quieter failure mode is worse: an installed package with no `lib/`, which only breaks at load time); allowing it authorizes running the package's build code at install time, so **pin a commit SHA**. The build probes `$DSH_CHECKOUT` / `~/dsh-harness` and falls back to npm-devDeps mode (devDependencies are installed by the package manager for git installs). A local `npm install` / `npm ci` never builds implicitly (use `npm run build`).

### Desktop form (dsh-desktop)

The desktop host loads this repository through **`link:`** (a development-mode link to the checkout), and its **profile is owned exclusively by Electron** —
CLI checks such as `dsh --profile desktop --dump-config` are **refused**, so "is the desktop assembly live?" cannot be proven from the CLI; observe it inside the app.

**Changes require an app restart: the desktop host has no hot reload.** The client half is loaded from `lib/client.js` at app startup, and `npm run build`
only updates artifacts on disk — it does not reach a running Electron process. The order is always **edit → `npm run build` → restart the app → reload the existing page and observe**.
Request plumbing (page origin `dsh-app://app`, `/api/*` proxied by the main process) and the measured header shapes are documented in
[docs/2-dev/nautilus-dev-07-desktop-host.md](./docs/2-dev/nautilus-dev-07-desktop-host.md).

Config example (in the profile's `cordis.patch.yml`; every field has a default, so configuration is usually unnecessary):

> **Breaking config change (AL.4g)**: the readings collector key was renamed from `lField` to `readings`.
> The old key `lField` is **no longer read** — rename it in your `cordis.patch.yml`, otherwise that field
> **silently falls back to its default**.

```yaml
- id: nautilus
  config:
    dataDir: ''       # empty = $DSH_HOME/nautilus (default, unchanged)
                      # when several frontends on one machine (dsh-web and desktop) must share
                      # one dataset, point both at the same directory (e.g. D:\\nautilus-data)
                      # only the data directory is shared; each home stays isolated. The db file is
                      # always nautilus.db inside that directory (the pulse sub-plugin uses the
                      # same file, different tables, and follows the same directory).
    readings:
      enabled: true
      historyDays: 30
    pulse:            # OS/GPU collection sub-plugin
      intervalMs: 5000
      enableCounters: true
      enableGpu: true
```

## API (same-origin)

Every route goes through the **same-origin gate** (non-local / cross-site requests get 403, and a rejection echoes the `seen` markers for diagnosis —
see [docs/2-dev/nautilus-dev-07-desktop-host.md](./docs/2-dev/nautilus-dev-07-desktop-host.md)).

| Endpoint | Description |
|---|---|
| `GET /api/nautilus/m2/state` | session readings (latest / totals / curve / self-review coverage) |
| `GET /api/nautilus/m2/turn-text` | full Q&A transcript of a turn (the source of scoring quotes) |
| `GET /api/nautilus/m2/analysis` | white-box analysis (sigmoid / bursts / τ_e) |
| `GET/POST /api/nautilus/m2/turn-annotations` | per-turn human judgement read/write (new form = `align` 1–5 + `boundary`; N/A exemption = `exempt`; tiers 4/5 require `quote`) |
| `GET /api/nautilus/m2/alignments` | alignment ledger (human / self tracks + coverage + consistency) |
| `GET /api/nautilus/m2/sessions` | past-session list (`?limit=50&offset=0`; label derived server-side) |
| `GET /api/nautilus/m2/sessions/\<sessionId\>` | per-turn detail of one session (readings + `hasText` + both judgement tracks; unknown id → 404) |

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
