# dsh-nautilus

**English** | [简体中文](README.md)

## Introduction

**Nautilus is a read-only session observability plugin** for DeepSeek Harness (dsh). It records the readings of every conversation turn
(tokens / cache / duration / tps) together with quality judgements, and presents them in a panel called the **Nautilus Workbench**.

- **The problem it solves**: in a long conversation, "which turns actually moved things forward, and at what cost?" is usually a vague impression.
  This plugin turns it into a **reviewable record** — per-turn readings, the model's self-assessment and your own judgement side by side, on the same row —
  and lets you go back and score past sessions retroactively.
- **What it does not do**: it **does not modify the host** (no source changes, no behaviour changes) and **does not write your data**;
  it **never reads or writes any Obsidian vault**. All observation data stays in your own `~/.dsh/nautilus/` (SQLite).
  The positioning is **observe, do not intervene** — conclusions are yours; the plugin only supplies evidence.

## Installation

> **Restart the host after installing.** The desktop app (dsh-desktop) has **no hot reload**; without a restart your change simply is not there
> (measured fact — see [Desktop host notes](docs/2-dev/nautilus-dev-07-desktop-host.md)).

### Option A: web profile (`dsh web`)

```sh
# git form: installs into the profile directory (recommended for regular use)
dsh plugin --profile <profile-name> add github:chemmy-11/dsh-nautilus

# local-checkout form: points at this repository (recommended for development)
cd <this-repo>
npm run build                                        # required before link:
dsh plugin --profile <profile-name> add link:<absolute path to this repo>
```

**git install**: this repository does not commit build artifacts (`lib/`), so the package is **built in place at install time**
(`prepare` / `prepack` → `scripts/prepare.mjs`). pnpm ≥10 **refuses to run dependency build scripts** by default, so you must allow it
in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@dsh-external/dsh-nautilus': true
```

- **Why the allowance is required**: allowing it means **authorising this dependency to execute build code at install time**
  (equivalent to trusting this repository's build script). Without it nothing errors — you just get a **silently broken package with no `lib/`**
  (measured with pnpm 11.24: no error, no warning; the symptom is that the plugin never appears).
- **For production, pin a commit SHA**: `github:chemmy-11/dsh-nautilus#<sha>`.

**`link:` install**: the profile points straight at this repository, so a rebuild (`npm run build`) is enough to pick up changes — no reinstall.
For the same reason (artifacts are not committed), **run `npm run build` before `link:`**, otherwise you link an empty shell.

### Option B: desktop app (dsh-desktop)

The desktop host loads this repository through **`link:`**:

```sh
cd <this-repo>
npm run build
dsh plugin --profile desktop add link:<absolute path to this repo>
```

- **The profile is owned exclusively by Electron**: CLI checks such as `dsh --profile desktop --dump-config` are **refused**,
  so "is the desktop assembly live?" cannot be proven from the CLI — observe it inside the app.
- **Always read back the profile's `dsh.profile.bundles` after installing**: the composer reads **only** that list, and a dependency
  that is missing from it is never mounted even when installed (the whole plugin disappears: routes 401, no tool, no panel).
  `dsh plugin add` writes it; re-read it as the first check after any reinstall or cleanup.
- **Changes require an app restart**: the client half is loaded from `lib/client.js` at app startup, and `npm run build` only updates
  artifacts on disk — it **does not reach a running process**. The order is always **edit → `npm run build` → restart → reload the existing page and observe**.
- Request plumbing and the measured header shapes (page origin `dsh-app://app`, `/api/*` proxied by the main process) are documented in
  [docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md).

### Post-install check

**After restarting the host, a "Nautilus 工作台" (Nautilus Workbench) icon row should appear in the sidebar**; clicking it opens the workbench
on the **Overview** view by default. If you do not see it, see the [FAQ](#faq) — usually it is a missing restart, or a git install without `allowBuilds`.

## Quick start

The workbench opens with a row of view buttons along the top, plus refresh and "back to conversation" on the right.

| View | In one line |
|---|---|
| **Overview** | Reading totals and the per-session list (each row opens a per-turn drawer): tokens, cache hits, duration, tps. |
| **Alignments** | The **two-track ledger** of human "alignment 1–5" vs the model's self-assessment (paired per turn, Δ = self − human), boundary distribution and sample consistency. |
| **Sessions** | Past sessions (workspace name · session name / turn count / reading totals / human coverage); expand one for per-turn detail and **score any turn directly**. |
| **Alerts** | OS / GPU red-line alerting: threshold detection, evidence freezing, reports and human adjudication. |
| **Curves** | Session reading curves: time tiers, metric switching, turn axis, fullscreen, hover drill-down. |
| **Report** | The repeatable analysis report: shape classification, characteristic time τ_e, bucketed comparison. |

### Scoring a single turn

1. Open the **Sessions** view → click a session name to expand its per-turn detail;
2. The rightmost column of each turn is the scoring entry — click **"对齐" (alignment)** to expand it: pick a tier **1–5**, or **N/A**;
3. Tiers **4 and 5 require a quote** (which sentence did you cite / question / change course on?) — this is a hard requirement, you cannot submit without it;
4. Click **Submit**.

**Some terms**:

- **Alignment 1–5**: how far this turn advanced the other side's real question along the "receive → follow → push" calibration loop —
  `1` did not catch it (dodged their state, answered a different question) · `2` caught it but added nothing (correct, no increment) ·
  `3` caught + followed one layer (lit up one point in what they already said) · `4` followed + pushed (named a structure or direction they had not named) ·
  `5` pushed far enough to change the next action (they changed course / cited / asked again, verifiable).
- **N/A**: this turn had **nothing to judge** (a purely operational instruction turn) → exempt, excluded from the denominator.
- **The four boundaries** (orthogonal to the tier; crossing one does not change the tier but is recorded): **no substitution · no possession · no coercion · no projection**.
- **Re-submitting overwrites**: judgements are **overwrite** semantics (server-side upsert) — no extra row is appended.
  When you expand the scoring widget on an already-scored turn it is **pre-filled with the current value**; pick another tier and submit.
- **Turns without source text cannot be scored**: the entry is **disabled** with a visible reason (the turn's text is not in the database, so the server rejects the write) — no fake buttons.

## What you can do

- **Per-turn telemetry**: tokens (input / output / cache hits), duration and tps for every turn — collected automatically, nothing to record by hand;
- **Self-assessment**: the model judges itself on "alignment 1–5 + the four boundaries" (via a dsh tool or the HTTP channel);
- **Human judgement and consistency**: score the self-assessment (or record your own), and the workbench puts both tracks side by side, computes the delta,
  and reports coverage and consistency metrics;
- **Retrospective review**: the sessions view lists historical sessions; expand one to add or change scores for **past turns**;
- **OS / GPU red-line alerts**: rule-based threshold detection (with hysteresis and cooldown), frozen evidence snapshots, an optional three-stage LLM report,
  and human adjudication in the workbench;
- **Repeatable analysis**: shape classification, characteristic time, bucketed comparison — the same data always yields the same conclusion.

## Configuration

Configuration lives in the profile's `cordis.patch.yml`. **Every field has a default, so configuration is usually unnecessary**:

```yaml
- id: nautilus
  config:
    dataDir: ''            # empty = $DSH_HOME/nautilus (default); point several hosts at one directory to share data
    readings:
      enabled: true        # collect session readings
      historyDays: 30      # reading retention window
    selfcheck:
      ingest:
        enabled: false     # external-harness self-assessment channel, off by default
        token: ''          # required when enabled (enabled=true with an empty token fails loudly at load time)
        maxBodyBytes: 8192
    pulse:
      enabled: true        # OS/GPU collection sub-plugin
      intervalMs: 5000
      enableCounters: true
      enableGpu: true
      alertEnabled: true   # red-line alerting
```

> **Config key note**: the readings collector has been called **`readings`** since AL.4g (the old key `lField` was renamed and is **no longer read**).
> If your config still uses `lField`, rename it — otherwise that field **silently falls back to its default**.
>
> The pulse sub-plugin has more fields (sampling intervals, retention, alert rules `alertRules`, `alertsDir`, …), all with defaults — see
> [docs/2-dev/nautilus-dev-03-os-layer.md](docs/2-dev/nautilus-dev-03-os-layer.md) and
> [docs/2-dev/nautilus-dev-06-os-alerting.md](docs/2-dev/nautilus-dev-06-os-alerting.md).

## Data & privacy

- **Data stays on your machine**: `~/.dsh/nautilus/nautilus.db` (SQLite; the pulse sub-plugin shares the database but uses its own tables).
  `dataDir` can point elsewhere (used to share one dataset across hosts).
- **No vault access**: the plugin has zero coupling to Obsidian vaults (the vault observation leg was retired on 2026-09-27).
- **No host modification**: it does not patch host source or behaviour; collection subscribes to the official `session/event` stream.
- **Self-assessment ingest is off by default** and requires a `token` when enabled (header `x-nautilus-selfcheck-token`); while the channel is closed,
  that route always returns 403.
- **Local APIs are gated by same-origin checks**: every `/api/nautilus/*` route accepts only local same-origin requests; cross-site requests get 403
  (and a rejection echoes the markers it saw, to make diagnosis easy) — see
  [Desktop host notes](docs/2-dev/nautilus-dev-07-desktop-host.md).

## FAQ

**Q: Why do I have to restart the host after a change?**
A: The desktop app has **no hot reload**: the client half is loaded from `lib/client.js` at startup, and `npm run build` only updates files on disk.
The order is always **edit → `npm run build` → restart the app → reload the existing page**.

**Q: The desktop panel is blank / requests keep returning 403?**
A: That was a fixed bug: the same-origin gate used to treat `sec-fetch-mode` as a cross-site signal, so desktop requests
(`dsh-app://app` page origin, proxied by the main process) always got 403. **Upgrade to the latest version**; the cause and the criteria are documented in
[docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md).

**Q: Desktop requests return 401 rather than 403?**
A: That is a different path — do not conflate the two:
(1) **0.1.x**: the same-origin gate misjudged the request → **403** (the case above; the body echoes the markers it saw via `seen`);
(2) **0.2.0-rc.1**: the host **compatibility gate** decides this plugin is unavailable from its peer ranges → the **whole plugin is denied**
(`insert: nautilus` never enters the composition), so a path that **should already be registered** returns a bare-text
**401 `unauthorized`** under `/api/nautilus/*`, and the tool and collection disappear with it.
Note: a **401 on an unknown path** (e.g. `/api/nautilus/nope`, or `/api/pet/nope` for another plugin) is just the connection layer’s
`/api` prefix fallback — **identical for any plugin** — so it proves nothing about whether this plugin is registered.
**The fix is to upgrade this plugin** (the peer range now covers `0.2.0-rc.1`); criteria and evidence in
[docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md).

**Q: Why do historical sessions show "unknown workspace"?**
A: Workspace attribution has only been collected **since v10**, and historical rows are **not back-filled** (forward-only — we do not rewrite the past
with today's attribution). "Unknown workspace" on old sessions is the designed outcome, not a defect.

**Q: Where does the "session name" come from? Is it the host's real title?**
A: **It is a derived name, not the real title**: the first line (up to 24 characters) of the session's **first question that does not start with `<`** and is non-empty;
if there is none, it falls back to the **last 8 characters of the session id**. Real databases are full of questions that begin with blocks such as
`<system-reminder>`, hence the rule — so treat these names as a way to **recognise** a session, not as an authoritative title.

**Q: Why do two places show different turn counts?**
A: Different scopes. The **Sessions view (`/m2/sessions`) uses the union scope** — a turn counts if it has readings **or** source text
(turns with text but no readings are deliberately listed, because **they can still be scored**); the readings on the **Overview** view use the readings scope
and count only turns that have readings. Totals (tokens / duration / tps) always sum **only turns that have readings**; missing readings render as `—`
(never 0 — 0 is a real measurement).

## Development

```sh
npm run typecheck && npm run build && npm test      # local gates before committing (three of them)
npm run check:deps && npm run check:exports && node .github/scripts/check-meta.mjs
```

- Conventions and red lines: [CONTRIBUTING.md](CONTRIBUTING.md) (branches / commit format / the six gates / host adaptation / profile hygiene);
- Developer docs index: [docs/2-dev/README.md](docs/2-dev/README.md) — including
  [desktop host notes (dev-07)](docs/2-dev/nautilus-dev-07-desktop-host.md),
  [workbench UI (dev-02)](docs/2-dev/nautilus-dev-02-ui-workbench.md),
  [the alignment rubric decision](docs/1-planning/nautilus-alignment.md) and the
  [UI-line evidence archive](docs/2-dev/evidence-al-20260928.md);
- Contributing: open an issue first, PRs are squashed; `lib/` is not committed (the only build entry point is `scripts/prepare.mjs`).

### Compatibility

- **Primary host in use**: dsh **0.2.0-rc.1** (the desktop app **dsh-desktop 0.2.0-rc.1** is verified working);
  also tested on **0.1.5-rc.2** (stable line), **0.1.6-alpha.2** (side-by-side install `dsh-next`), **0.1.7-rc.1** and desktop **0.1.7-rc.2**
  (component version matrix in [dev-07](docs/2-dev/nautilus-dev-07-desktop-host.md)).
- **A host upgrade goes through a compatibility gate first**: the host checks this package's `@deepseek-ai/dsh*` peer ranges against the
  running version, and a range that does not cover it gets the plugin **denied wholesale** (routes 401, tool gone, no panel — and on the
  desktop the diagnostic is swallowed). Run `npm run check:deps` right after bumping the devDep; that is exactly what rule R3 guards.
  The peer range now covers `0.1.1-rc.2 … 0.2.0-rc.1`.
- The dependency surface, peer ranges and the five-step host upgrade flow live in [CONTRIBUTING.md](CONTRIBUTING.md) ("host version adaptation").

## License

**BSD-3-Clause** (see the `license` field in `package.json`; the repository does not currently ship a separate LICENSE file).
