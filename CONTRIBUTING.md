# Contributing / testing

boxery has no build step and no runtime dependencies: clone it and run the commands below with Node ≥ 22.13. [ARCHITECTURE.md](ARCHITECTURE.md) maps the code; [AGENTS.md](AGENTS.md) is guidance for coding agents (and a fair summary of how the code is meant to be shaped).

```bash
npm run lint && npm test && npm run test:shell
```

| Layer | Command | Needs |
|---|---|---|
| Lint: shellcheck (warnings are errors), `node --check`, `bash -n`, and that `core/*.ts` parses under type stripping | `npm run lint` | shellcheck, node |
| Type check: the `.mjs` sources (JSDoc types, `checkJs`), the tests (`test/tsconfig.json`), `evals/` and VM-side `core/*.ts` | `npm i --no-save typescript@5.9.3 @types/node@22 && npm run typecheck` | node |
| Unit/integration tests: core helpers, proxy, MCP, SQLite leases and lifecycle crash recovery (real host dispatcher with a fake backend), background jobs (real CLI + MCP, helper run as in a VM) | `npm test` | node ≥ 22.13; job cases need ≥ 22.18; python3 ≥ 3.9 for real-PTY grant tests |
| Shell tests: host dispatcher against the `fake` backend, leases, images/forks (`host-images.sh`: the behaviour every backend must match), controller local mode + grants, named registry/import/defaults, injection/concurrency regressions | `npm run test:shell` | bash, jq, openssl, node ≥ 22.13, ps (procps on Linux) |
| Same under macOS's bash 3.2 | `docker run --rm -v "$PWD":/src:ro bash:3.2 bash -c 'apk add -q openssh-client jq coreutils openssl nodejs perl git procps-ng; cp -r /src /w && cd /w && bash test/shell/run.sh'` | docker |
| OpenShell live smoke (opt-in) | `node test/openshell-smoke.mjs HOST` | a configured OpenShell host with the bundled offline policy; creates/removes one disposable sandbox |
| MCP protocol against a live VM | `mcp/test-mcp.sh VM` | a VM |
| End-to-end (create VM → agents → proxy → extension → MCP → grants → snapshots → rm) | `./e2e.sh` | a configured host (any backend, after `boxery setup`); a terminal to approve 3 grant prompts, or `GRANT_CONFIRM=off` in the profile for unattended runs (use a throwaway `BOXERY_HOME`, see [grants](docs/grants.md#headless-automation)) |
| Agent behaviour evals: when an agent reaches for the `vm_*` tools, which ones, and whether it follows instructions ([evals/](evals/README.md)) | `cd evals && node run.mjs` | `claude` CLI signed in, a host with two VMs; spends tokens |

CI (`.github/workflows/ci.yml`) runs on PRs and pushes to `master`: lint and the type check, unit tests on Node 22/24/26, shell tests, the shell tests under bash 3.2 (docker), and on a macOS runner the shell tests under its `/bin/bash` and the unit tests. It skips changes that touch only `*.md`, `docs/` or `LICENSE`; after a docs-only change, run `node --test test/help-drift.test.mjs test/backend-capabilities.test.mjs` yourself, since they check docs. `e2e.sh` and the other live checks need a real host, so they run by hand.

## When you add or change something

| Change | Also |
|---|---|
| a `vm_*` tool or action | the table in `core/boxery-tools.mjs`, not one front-end (`test/frontends.test.mjs`); map it to a `boxery` command in `test/parity.test.mjs`, or say why it has none |
| a `boxery` command or flag | its `help` in `controller/cli.mjs`'s `COMMANDS`; map it in `test/parity.test.mjs` (and, if it can run for more than a few seconds, give its entry a `status`, which reports it to the terminal: `controller/status.mjs`; the test says so for a command with neither a `status` nor a `NO_STATUS` reason); `npm run docs:cli`; review the help change, then `BOXERY_UPDATE_GOLDEN=1 node --test test/help-drift.test.mjs` (it rewrites both `boxery help` and `boxery help --all`) |
| a family action (`boxery snapshot create`, `job ls`, …) | an entry in the family's `actions` naming the command whose handler it runs (no second handler; `help` is derived from that command's, with overrides only where its arguments differ), plus the same as for a command; test canonical and older spelling together in `test/cli-families.test.mjs` |
| a `boxery-host` command or flag | its help in `host/help.mjs` (`host/cli.mjs` won't load without it); `npm run docs:cli`; output formats are pinned by `test/shell/host-output.sh` |
| a backend | `host/backends/NAME.sh` ([contract](host/backends/README.md)); a declaration in `backends/index.mjs` ([support contract](docs/backends.md), `test/backend-capabilities.test.mjs`); its `BOXERY_NAME_*` settings in `host/host-env.list`; tests like `test/shell/host-lima-backend.sh`; the README's platform lists |
| a shell test | add it to the list in `test/shell/run.sh`, which doesn't glob; keep its state in its own `mktemp -d` |
| a source directory or file glob | `test/lint.sh`, the `include` of `tsconfig.json`, and `files` in `package.json` if it ships |
| anything a user sees | the docs that describe it (`docs/`, README, ARCHITECTURE.md), in the same change |

## Pull requests

Commit and PR titles say where and what: `fix(host): …`, `feat(exe): …`, `docs(readme): …`, `test: …`, with the issue they close as `(#123)`. Split a large change into a stack of PRs that each pass CI, and say so in each title: `(stack 2/3)`. Run lint and both test suites before you open one.

## Notes on the code and tests

Types: the code is plain JavaScript typed with JSDoc comments (`/** @param {string} name */`, `@typedef`, `/** @import { Runtime } from "./runtime.mjs" */`), checked by `tsc` under `strict`. There is no build step, and nothing to strip: npm installs live under `node_modules`, where Node refuses to strip TypeScript types, so files that ship stay `.mjs`. Define a shared shape as a `@typedef` in the module that owns it. Only `core/*.ts` is TypeScript syntax: it is piped into the VM and run under type stripping, so it must stay erasable.

`test/copy.test.mjs` exercises streaming transfers with real tar and isolated fake SSH endpoints: 192 MiB archives with bounded agent buffers, all endpoint combinations, producer/consumer failures, cancellation/KILL escalation (including descriptor-free descendants), metadata deadline/late-preparation faults, read-only cleanup, non-writable parents and pinned routing. `COPY_TEST_TAR=/path/to/bsdtar node --test test/copy.test.mjs` checks BSD tar locally; native macOS CI uses its system tar. Fixture subprocesses live under `test/fixtures/`.

`test/parity.test.mjs` keeps the CLI and the agent tools in step: a new `vm_*` tool or action, or a new `boxery` command, fails it until it is mapped to its counterpart or listed with a reason it has none. When both sides need a feature, give the CLI the tool's implementation rather than a second one (as `boxery cp` runs `vm_copy`).

`boxery help`, `boxery help --all` and `boxery COMMAND [ACTION] --help` are rendered (`help/index.mjs`, through `controller/usage.mjs`) from the `help` each command carries in `controller/cli.mjs`'s `COMMANDS` table, next to its handler: a new command needs its help to exist at all. boxery-host's help is the same kind of table, in `host/help.mjs` (its handlers are in `host/cli.mjs`, which refuses to load with a command that has no help). Write the summary as one short line; longer explanations go in `details`, `flags` and `examples`, which only its own `--help` shows. `test/help-drift.test.mjs` keeps it honest: a command's help must list exactly the `--flags` its code compares against (flags the host parses are checked against `boxery-host help`), examples must use real commands and documented flags, the same holds for every `boxery-host` command, `docs` anchors must exist, the command reference in `docs/cli.md` must be current (`npm run docs:cli` regenerates it), and `boxery help` and `boxery help --all` are pinned in `test/fixtures/boxery-help.txt` and `boxery-help-all.txt` (`BOXERY_UPDATE_GOLDEN=1 node --test test/help-drift.test.mjs` rewrites it after you review the change).

`test/cli-families.test.mjs` runs the real CLI against a stub `boxery-host` and a stub `ssh` in temporary profiles, and checks that every family action and its older spelling produce the same output, exit status, ssh and host calls and saved state; that help and mistakes touch no host, profile or grant; that `host`'s registry actions refuse `--host` while its maintenance actions follow it; that `access ls` is read-only; and that grant approval, grant stores and leases stay per profile. Add a pair there when you add an action.

`test/frontends.test.mjs` does the same for the two agent front-ends, the MCP server and the pi extension: both must list exactly the shared tool table in `core/boxery-tools.mjs`. Put a new tool or action in the table (with its `run`), not in one front-end; something only one of them can offer goes in that test's `MCP_ONLY` or `PI_ONLY` with the reason.

`test/grants.test.mjs` exercises the actual CLI with no controlling terminal and with a real PTY (`test/fixtures/grant-pty.py`, Python standard library only), plus in-process approvals, shared prompt text, config-only automation and deny-directory parity. Its profiles, stores and transport effects are temporary; it never grants access to a real VM.

`test/lease-workflows.test.mjs` tests lease policy directly through injected store/backend/journal dependencies, without SQLite or subprocesses. [Host module boundaries](docs/host-modules.md) documents ownership and dependencies. `test/operations.test.mjs` uses deterministic fake-backend barriers to SIGKILL supervisors while their worker groups are alive, checking both recovery and external side effects. Keep these tests offline: they use only temporary config and VM directories. The [lifecycle contract](docs/lifecycle.md) documents resource boundaries, durable intents and backend recovery responsibilities.

Backends live in `host/backends/<name>.sh` and implement the contract in `host/backends/README.md`; `fake.sh` is the test double. What is written in Bash (the entry shims, `connect`, the backends, the job runner) runs under macOS's bash 3.2; [AGENTS.md](AGENTS.md#node-and-bash) explains why each of those is Bash and when to move one to Node.

Named-host interface/layout: [docs/hosts.md](docs/hosts.md). `test/hosts.test.mjs` uses independent fake profile directories and SSH/host stubs to check duplicate VM names, per-call contexts, cross-host copies, timeout cleanup and HTTP session isolation. `test/shell/controller-hosts.sh` exercises the real CLI (`controller/boxery` → `cli.mjs`) and real `ssh -G` config parser without connecting to any host, including remote tilde and hostile executable paths. All profiles and grants are temporary; never point offline tests at a real BOXERY_HOME. For native macOS Bash 3.2 (what still runs in Bash: entry shims, `connect`, backends, sourced profile configs): `BASH_UNDER_TEST=/bin/bash npm run test:shell`.

Live checks (`e2e.sh`, `mcp/test-mcp.sh`, `test/openshell-smoke.mjs`, `test/bench/vm-startup.mjs`) create and remove real VMs: run them against a host you own, and on a shared host take any lease it requires first (registering a host is not acquiring a lease). Keep hostnames, credentials and private app recipes out of public changes.
