# CLI reference

← [Docs](README.md)

- [`boxery`](#boxery-your-laptop) runs on your laptop (Node ≥ 22.13 + ssh).
- [`boxery-host`](#boxery-host-the-vm-host) runs on the VM host. You'll rarely call it directly.
- [JSON output](#json-output): `--json` on every listing command, for scripts and agents.

## `boxery` (your laptop)

`boxery help` lists the everyday commands and the command families; `boxery help --all` lists every command, every family action and every older spelling. `boxery COMMAND --help` (or `boxery help COMMAND`) shows one command's options and examples, `boxery FAMILY --help` a family's actions, and `boxery FAMILY ACTION --help` (or `boxery help FAMILY ACTION`) an action's options. Help works before `setup` and never contacts a host. `boxery --version` (or `-V`) is `boxery version`.

Exit status: `0` on success; a command that runs something in the VM (`run`, `ssh`, `attach`, `wait` and the like) exits with its status, so a script can't tell boxery's codes from the command's. boxery's own failures exit `1`, and its usage errors (an unknown command or flag, a missing argument or flag value, arguments that don't fit the command's usage) exit `2`. A value that is refused (an invalid name, a VM that doesn't exist) is a failure, `1`, and so is a usage error that the host reports for a command boxery passes to it (`images`, `pool`, `runners`, …).

- [Command families](#command-families)
- [All commands](#all-commands), generated from the same help

### Command families

The everyday commands stay top level: `new`, `ls`, `start`, `stop`, `rm`, `resize`, `fork`, `patch`, `ssh`, `run`, `cp`, `desktop`, `forward`, `setup`, and the two shortcuts `attach` and `prompt`. Everything else is grouped by what it is for:

| Family | For | Actions (older spelling) |
|---|---|---|
| `host` | named hosts, and maintenance of the selected host | `add`, `ls`, `show`, `use`, `rm` (the host registry); `build-base`, `upgrade` (`upgrade-host`), `proxy-log`, `backend`, `backends`, `capabilities` |
| `snapshot` | saved VM disk states | `create` (`snap`), `ls` (`snaps`), `restore` (`revert`), `rm` (`snap-rm`), `images` |
| `agent` | persistent coding-agent sessions | `attach`, `prompt` (both also top level), `ls` (`sessions`) |
| `job` | background processes | `ls` (`jobs`), `logs`, `wait`, `kill`; a job is started with `run --bg` |
| `access` | what a VM may use from this machine | `grant`, `revoke`, `ls` (`grants NAME`), `apply` (`grants NAME apply`); `agent-forward NAME on\|off` is `grant\|revoke NAME ssh-agent` |
| `lease` | borrowing a pool VM | `acquire`, `renew`, `release`, `ls` (`leases`) |
| `pool` | adding and removing leasable VMs (admin) | `add`, `rm`, `ls` |
| `runners` | GitHub Actions runners | `once`, `status`, … |

- **The same commands.** A family action runs its older spelling's code: same arguments and flags, output, `--json` fields, exit statuses and signals, and the same host selection. Older spellings keep working, without a warning, so scripts need no change. Only usage errors differ: they show the spelling you typed.
- **`host` has two kinds of action.** `add`, `ls`, `show`, `use` and `rm` manage this machine's registry of hosts and refuse `--host`. `add NAME DEST` runs setup on its explicit destination; importing `--config-dir` and the other registry actions stay local. Mutating maintenance actions (`build-base`, `upgrade`) and `proxy-log`/`backend` use the selected host, the default or `--host NAME`. Read-only `upgrade --check`, `backends` and `capabilities` list every host unless scoped: `boxery --host lab host upgrade --check`.
- **`access ls` only lists.** It takes `NAME [--json]` and nothing else, so `access ls demo apply` is a usage error, not a push. Pushing the grants again is `access apply`. Grant approval is unchanged ([Grants](#grants)).
- **`snapshot images`** lists the snapshots `new NAME --from VM@SNAP` can start from; it is not another kind of saved state. `fork` copies a VM's current disk; `snapshot create` saves one to come back to.
- **Mistakes.** An unknown action names the family's actions (`unknown snapshot action: restroe (did you mean restore?); actions: …`) and exits 2, before any host, profile or grant is read.
- **Payload words are not options.** `boxery run` and `boxery ssh` hand every word after the VM name to the VM, `--help` included. Family actions recognise help only immediately after the action (`job logs --help`), so `agent prompt demo --help` sends `--help` as task text. Older top-level spellings retain their help conventions, including `snap demo --help` and `prompt demo --help`.

### Named hosts

```bash
boxery host add laptop local
boxery host add hornet you@hornet
boxery host add exe local --backend exe     # a second backend on that machine: own profile, proxy port, services
boxery host add exe2 local --profile exe    # an existing profile on that machine
boxery host add existing --config-dir "$HOME/.boxery-other"
boxery host ls [--json]                     # where each runs (local / ssh destination), backend, same-profile names
boxery host show hornet
boxery host use laptop
boxery --host hornet ls
boxery --host hornet lease acquire          # pool lease on that host
boxery --host hornet host upgrade --check   # --host scopes this read-only check
boxery host rm hornet                       # forget only; preserves VMs and profile data
```

Without `--host`, `ls` lists every registered host's VMs under one header, a section each (the default host first, each headed by its name, backend and where it runs); names for the same host (`same_as` in `host ls --json`) are listed once, headed `(also NAME)`, with each name's grants. The hosts are asked at once; one that can't be reached shows `(ls failed: see below)`, its error follows the table on stderr, the others are still listed, and `ls` exits 1. `--host NAME ls` lists that host's alone, without a heading, and so does `ls` when only one host is registered. `ls --json` is always one host's VMs (the default's, or `--host NAME`'s). See [Named hosts](hosts.md) for isolation, imports, precedence and safe removal. `--host NAME` precedes the command and also scopes grants and lease keys.

The read-only commands `lease ls`, `pool ls`, `version`, `shapes`, `host capabilities`, `host backends`, `host upgrade --check` and `runners status` also list every host without `--host`, using the same sections, default-first ordering and same-host deduplication as `ls`. `snapshot images` instead adds a `HOST` column to its table. Older spellings (`leases`, `images`, `capabilities`, `backends`, `upgrade-host --check`) behave identically. With only one host, output stays unchanged. `--host NAME` and `--json` always mean one host (the selected default for JSON without `--host`). Unreachable hosts do not hide the others: their errors follow the output on stderr and the command exits 1 once. `lease ls` reads local lease records only and does not contact hosts. `host upgrade --check` prints each host's report under its heading, without host-name prefixes. `version` prints the controller once, then each host's version, warning separately for each host that is behind. Real upgrades, mutating commands and commands taking a VM name remain on the selected host.

### Backend discovery

`boxery host backends [--json]` lists backend platform support, requirements and capabilities.
`boxery host capabilities [--json | --check]` assesses each **host**, not the controller; `--host NAME` or `--json` selects one.
Both are also available as the top-level `backends` and `capabilities`, and directly as `boxery-host` commands. Agents use
`vm_info {action:"capabilities"}`. See the [metadata contract](backends.md) for
supported versus tested configurations and conditional features. Setup checks
locally verifiable requirements before backend initialization; manual account and
privilege requirements are explained but remain unknown until verified.

### Lifecycle

```bash
boxery setup you@my-host                     # or: setup local   [--name NAME] [--key ~/.ssh/id_ed25519.pub]
boxery new demo                              # ~13 s   [--shape large] [--cpus N --mem MiB --disk GiB] [--grant SPEC]…
boxery new ci-1 --headless                   # no desktop, no build-base needed: ~50 s on Lima (see below)
boxery host build-base                       # the host's desktop base image (one time, ~3 min); older spelling: build-base
boxery shapes [--json]                       # VM sizes the host offers (* = default); see Shapes
boxery ls [--json] [--refresh] [--running]   # VMs on every host, grouped; STATUS: lease, outdated guest, grants
boxery patch demo | --all [--wait S]         # update a VM's guest software to the host's image layers
boxery start demo | stop demo
boxery resize demo --cpus 8 --mem 16384      # [--disk GiB]; restarts a running VM
boxery rm demo                               # also revokes its LLM proxy token
boxery pin demo [--from-guest]               # re-pin demo's ssh host key (a VM from before keys were pinned)
```

**Headless VMs.** `new --headless` makes a VM without the desktop: shell, git (current, from the git-core PPA), build tools, node 24, pi, opencode and ripgrep, but no XFCE, VNC, browsers or computer use. It boots the backend's stock image (the Ubuntu 24.04 cloud image; exeuntu on exe.dev) and installs boxery's plumbing and dev-tools layers at first boot, so the host needs no `build-base`. That takes longer than cloning the built desktop base: about 50 s on Lima (vz, Apple Silicon), mostly the dev tools. Snapshots, forks and `new --from` of a headless VM are as fast as for desktop VMs and stay headless; a VM made from an image keeps its source's kind, and `--headless` with a desktop image is refused. `boxery desktop`, `vm_screenshot`/`vm_click`/`vm_type`/`vm_key`/`vm_scroll` and `vm_browser` refuse headless VMs with a clear error. `ls` shows the kind (KIND column, `desktop` in `--json`). The layers are in [`image/layers/`](../image/layers/); see [backends](../host/backends/README.md#image-layers-desktop-and-headless-vms). `--layers github-runner` adds an optional layer at first boot, the GitHub Actions runner ([GitHub Actions runners](github-runners.md)); only a headless VM takes `--layers`, since a desktop VM's layers come from its base and a VM made from an image has its source's.

**Host keys.** Every ssh to a VM checks its host key, which is pinned on the host when the VM is made ([security](security.md#vm-host-keys)). A VM made before that, or whose record was lost, fails with "Host key verification failed" until you run `boxery pin NAME`. That reads the key through the hypervisor (libvirt's guest agent) or the host's loopback endpoint (Lima, exe, boat). `--from-guest` instead trusts what the VM's ssh endpoint answers, once. `boxery start NAME` pins it automatically where it can.

**Outdated guest software.** A VM keeps the kernel and packages it was built with: nothing updates them after it is made. Every VM records what it was built with in `/etc/boxery/build-info` (date, kernel, a hash of boxery's image layers, and on desktops the Chrome/Chromium and `playwright-core` versions), and the host keeps a copy, read whenever it reaches the VM anyway (`new`, `fork`, `start`, `revert`, `patch`). `ls` shows `outdated guest (REASONS)` in its STATUS column when it is (`guest` in `--json`, with `status` `outdated`, `current` or `unknown`): `outdated` when the VM was built from other image layers than the host's current ones (the host was upgraded since), more than 30 days ago (`BOXERY_STALE_DAYS` in the host's `host.env` changes that), or when the guest asks for a reboot (`/var/run/reboot-required`, read when the host last reached it); `current` otherwise; `unknown` for a VM built before build records or never read. `ls` reads only the host's copy, so it stays fast; `ls --refresh` first reads each running VM's record over ssh. After the table, `ls` names the outdated VMs again on stderr with how to update them, and the running VMs not checked yet. `new` warns when a VM is outdated from the start because what it was made from is: an outdated desktop base or snapshot (`fork`: its source, once). `boxery patch NAME` updates the VM; to make new desktop VMs current, rebuild the base (`boxery build-base`, once no VM depends on it). A headless VM whose first-boot package updates ask for a reboot (a new kernel) is restarted once by `new`, so it starts current.

`boxery patch NAME` updates a running VM in place: it copies the host's current image layers into the VM, runs the layers the VM has again (security updates and kernel with `apt-get full-upgrade`, and what the layers install outside apt: `playwright-core` and, on arm64, its Chromium; the pi and opencode CLIs; node 24), and restarts the VM if the updates ask to (its tmux sessions end; its grants are pushed again). It takes a few minutes, streams the layers' progress and logs everything to `/var/log/boxery-patch.log` in the VM. `--all` patches every running VM in turn, and says which it skipped (stopped VMs, pool VMs with a lease). A pool VM must be free: `patch` refuses one with a lease, or waits up to `--wait S` seconds for it to end; while it is patched no lease can start on it, and its clean image (`NAME@boxery-clean`) is captured again, so later leases start patched. **Snapshots and images are not patched**: `snaps` and `images` show their age and the guest software they hold, and a VM made or reverted from an outdated one is outdated until you patch it. A VM from a desktop base built before build records shows `unknown`; patching gives it a record. To patch the base itself, rebuild it (`boxery build-base`).

`resize` takes any of `--cpus`, `--mem` (MiB) and `--disk` (GiB), the same units as `new`. A running VM is stopped, resized and started again, so its tmux sessions end; its grants are pushed again afterwards. A stopped VM stays stopped. The disk can only grow, and the guest's root filesystem grows on the next boot. Values that are already the VM's current size are ignored, so a resize that changes nothing doesn't restart anything. Like other long-lived VM products (exe.dev, Daytona, EC2), it changes the VM in place; throwaway sandboxes such as E2B are recreated instead.

### Snapshots and forks

```bash
boxery fork demo try-a try-b                 # copy demo (running or not) into 2 new VMs, ~15–25 s   [--grants] [--shape S]
boxery snapshot create demo before-refactor  # ~1 s and live on libvirt; Lima restarts a running VM (~10 s)
boxery snapshot ls demo [--json]
boxery snapshot restore demo before-refactor # VM keeps its name, address and token
boxery new demo2 --from demo@before-refactor # a new VM from a snapshot
boxery snapshot rm demo before-refactor
boxery snapshot images [--json]              # snapshots on every host (HOST, AGE and GUEST columns)
```

`snap`, `snaps`, `revert`, `snap-rm` and `images` are the older spellings of `snapshot create`, `ls`, `restore`, `rm` and `images`, and do the same.

A **fork** is a separate VM with the source's disk (files, installed packages, git state) but not its running processes, and with its own hostname, LLM proxy token, ssh keys and network identity. Forks don't depend on the source: removing either one is fine. Forks get the source's size (cpus, memory, disk) unless you pass `--shape` or size flags. Grants are per VM and aren't copied unless you pass `--grants`. That option revalidates the source grants and asks for each destination before creating anything; stale files or newly forbidden legacy grants must be revoked first (or omit `--grants`). A fork of a leased pool VM is an ordinary VM and never accepts the lease key.

Snapshots and forks are built on one backend primitive, the image (a copy of a VM's disk named `VM@LABEL`). They hold disk state only, never memory, so secrets pushed by grants (tmpfs) are never captured. `rm` removes a VM's snapshots too. Capturing a running VM (`snap`, `fork`, `pool add`, `patch` of a pool VM) depends on the backend: libvirt does it live in about a second, exe.dev in about 12 s with the VM kept running, but **Lima stops the VM and starts it again** (about 10 s), because Lima clones only stopped instances, so its processes, tmux sessions and background jobs end. `boxery host capabilities` (or `boxery host backends --json`) shows this in the `diskSnapshots` note. How each backend implements images: [backends](../host/backends/README.md#images-one-primitive-for-snapshots-forks-and-pool-resets).

### Shell and in-VM agents

```bash
boxery ssh demo [cmd…]                       # interactive shell (or: ssh demo.boxery)
boxery ssh demo@lab                         # a VM on registered host lab (no default change)
boxery run demo git log --oneline -5         # exact argv, like docker exec; runs in ~/project
boxery run demo --cwd app pnpm test          # in ~/project/app
boxery run demo bash -c 'make test 2>&1 | tail'   # a shell line: bash -c
boxery attach demo                           # pi in tmux. Ctrl-b d detaches; it keeps running.
boxery attach demo opencode                  # or: shell
boxery prompt demo "fix the failing tests and commit"   # headless pi task, as a background job (job wait/logs)
boxery agent ls demo [--json]                # list tmux sessions
```

`attach` and `prompt` are everyday shortcuts for `agent attach` and `agent prompt` (same arguments, same behaviour). `agent ls` lists a VM's tmux sessions (older spelling: `sessions`).

`run` works like `docker exec` / `kubectl exec`: the command gets exactly the arguments you pass, and nothing in them (quotes, `$`, `~`, globs, `;`) is re-parsed in the VM. For pipes, `&&`, `~` or `$VAR`, run a shell explicitly with `bash -c '…'` (how `run` used to treat every command). A whole command line passed as one argument (`boxery run demo 'make test'`) is looked up as a single command name and fails with a hint. An argument that is `~`, starts with `~/` or contains `$VAR`/`${…}` reaches the command literally and exits 0, so `run` adds a note on stderr pointing at `bash -c` (not when the command is a shell or an interpreter such as awk, perl or jq, whose code uses `$`). Like the `vm_bash` tool, `run` starts in `~/project` (home if there is none), and a relative `--cwd DIR` is under `~/project`; `~/` expands in the VM and absolute paths are used as is. `--` ends `run`'s own options. The exit code is the command's. `ssh NAME cmd…` keeps plain ssh semantics.

`ssh NAME@HOST [CMD...]` is shorthand for `--host HOST ssh NAME [CMD...]`.
`HOST` is a registered Boxery host, not an SSH destination or username. A matching
`--host` is allowed; conflicting selectors are rejected before connecting. The
shorthand does not change the default host and works even when none is selected.

When ssh can't connect (exit 255), `ssh`, `run`, `attach`, `prompt`, `agent ls`, `job ls`, `job logs`, `job wait`, `job kill` and `desktop` (and `cp`, which exits 1; see [Copying files](copy.md)) say why: `no such vm: NAME`, a VM that isn't running, or a pool VM this machine holds no lease on (or whose lease has expired); otherwise what ssh said. The exit code stays 255. (The generated `ssh_config` keeps connections open with `ControlPersist`, and OpenSSH then discards the host's own message, so boxery checks with one fresh connection and the host's VM list, only after a failure. A command that exits 255 itself, or ssh ended by Ctrl-C, gets no such message.) The agent tools that reach a VM (`vm_bash`, `vm_jobs`, `vm_copy`, the file and desktop tools) report the same. `access ls NAME` (also `grants NAME`) says `no such vm` too.

### Files

```bash
boxery cp ./repo.bundle demo:                # this machine → VM (~/project/repo.bundle)
boxery cp demo:dist ./dist                   # VM → here; directories copy recursively
boxery cp demo:out.zip hornet/worker:in.zip  # VM → VM, here across named hosts
boxery --host hornet cp local:notes.md ci-1:~/notes.md
```

`cp` is the `vm_copy` tool's own code, so it takes the same locations, `local:PATH`, `NAME:PATH` (a VM on the selected host) and `HOST/NAME:PATH`, and behaves the same way: streaming tar, staging, destination and cancellation rules are in [file transfers](copy.md). The one difference: the CLI has no current VM, so a bare path is on this machine, like `cp`/`scp` (`vm_copy` reads it as the current VM). A bare path that looks like a location with an invalid VM name (`Demo:x`) is refused instead of being written locally. Ctrl-C cancels and cleans up staging. `cp` runs on Node (≥ 20), which the npm package already needs.

`boxery sync demo [--from DIR] [--to PATH] [--json]` pushes a local git checkout into a VM so its tree matches exactly (commits by `git push` over the VM's ssh connection, plus uncommitted and untracked changes); it is the `vm_sync` tool's own code ([sync](sync.md)).

`attach` starts pi, opencode or a shell (nothing else) and needs a terminal; without one it says to use `prompt` or `run --bg`, which work headless. `prompt` starts `pi -p TASK` in `~/project` as a background job and prints its id, so `job ls`, `job logs -f`, `job wait` (exits with pi's status) and `job kill` work on it; `pi -p` prints its answer when it finishes, so the log can stay empty until then. pi needs the `llm:` grant for its provider (`llm:chatgpt` unless you changed pi's settings in the VM), and a new VM has none: `prompt` checks first and, if it's missing, starts nothing and prints the `boxery grant` command to run (the older spelling of `boxery access grant`).

### Background command jobs

For commands that take a while (a test suite, a build). The job runs in the VM, detached from your ssh connection, so a dropped connection or a sleeping laptop doesn't stop it, and its real exit code is kept.

```bash
job=$(boxery run --bg demo --cwd app pnpm test)   # prints just the job ID
boxery job ls demo [--json]                      # state, exit code, start time, command
boxery job logs demo "$job" [-f] [--strip-ansi] [--lines 200] [--bytes N]
boxery job wait demo "$job" [--timeout S] [--json]   # exits with the command's real status
boxery job kill demo "$job" [--grace S] [--json]     # SIGTERM its process group, SIGKILL after S s (default 5)
boxery job ls demo --prune [--older-than 7d]     # delete finished jobs and their logs (default: all)
```

`run demo --bg …` is the only way to start a job; the `job` family lists, reads, waits for and stops them. `jobs`, `logs`, `wait` and `kill` are the older spellings and do the same. The notes below call the actions `wait`, `logs`, `kill` and `ls` by those short names.

- **The command** follows the same rules as foreground `run`: exact arguments, `--cwd`, and `bash -c '…'` for shell syntax. It runs in a login shell (profile and grants loaded) with no stdin, and stdout and stderr go to `~/.boxery/jobs/ID.log` in the VM.
- **States** are `running`, `exited` (any exit code, including failures) or `lost`. `lost` means the job stopped without recording an exit code: the VM restarted, or it was killed outside boxery. Closing or killing the job's tmux session doesn't stop it; use `kill`.
- **Left-over processes:** a job can exit while something it started keeps running (`server & tests`). It then shows as `exited+` in `boxery jobs` (`"leftover": true` in JSON); `kill` stops those processes, and `--prune` keeps the job until they're gone.
- **`wait`** exits with the job's exit code, `124` if `--timeout` passes first (the job keeps running) and `125` if the job is `lost`. Without `--timeout` it waits as long as the job runs. If the connection drops while waiting, it reconnects (within `--timeout`); a VM that can't be reached at all fails at once. boxery's own errors exit `1`, `2` (usage) or `3` (unknown job). A job can exit with any of these codes too, so scripts that need to tell them apart should use `--json` and read `state`, `exit_code` and `timed_out`.
- **`logs`** shows the last 200 lines by default; `-f` follows until the job ends. `--strip-ansi` removes colours and other terminal escapes as they stream, including in newline-free progress output. `--bytes N` clips each read to its last N bytes before lines are selected, with a notice on stderr when it does. A cut can start partway through a line or UTF-8 character.
- **`kill`** signals the job's process group, including whatever it left running after it exited. Processes that start their own group (`setsid`, daemons) aren't part of it.
- **No ssh agent in jobs:** a forwarded agent ([`ssh-agent` grant](grants.md)) only lasts as long as the ssh session that started the job, so `git push` over ssh fails in a job. Use an [`http:`/`github` grant](grants.md) (HTTPS) instead.
- **Storage:** logs and records stay in `~/.boxery/jobs/` until pruned or the VM is reset, and a fork gets a copy. They may contain secrets the command printed.

How it works: the job logic lives in `core/boxery-jobs.ts`, which the controller pipes over ssh on every call and the VM's Node runs with built-in type stripping (Node ≥ 22.18; every boxery image has it). Each job is kept alive by a small bash runner, `core/boxery-job-runner.sh`, sent along with `start`. Nothing is installed in the VM, so it always runs your controller's version. Agents get the same through the `vm_jobs` tool ([MCP](mcp.md#background-jobs), [pi](pi-extension.md)).

### Desktop and ports

```bash
boxery desktop demo                          # XFCE desktop in your browser (noVNC over ssh)
boxery forward demo 3000                     # localhost:3000 → the VM's dev server   [LOCAL_PORT]
```

`desktop` forwards a free local port (from 16080) to the VM's noVNC and opens it in your browser (`--no-open` only prints the URL). The VM's VNC server asks for a password. Each `desktop` session sets a new random one over ssh and puts it in the URL's fragment (`vnc.html?…#password=…`), which the browser never sends to the server, so it stays out of logs. It does land in the browser's history. A new session replaces the previous session's password for new logins; a tab that is already connected stays connected. If that tab is disconnected later, it fails to log back in and you run `boxery desktop` again. With the tunnel open, other processes on your machine, and web pages, can reach the noVNC port, but without the password they can't use the desktop.

VMs made from a desktop base built before this change have **no** VNC password. Neither do snapshots or images of those VMs. `boxery desktop` warns when it opens one of them. To fix it, rebuild the base with `boxery build-base` (or `boxery-host build-base` on the host) and create the VMs again. Backends refuse to rebuild the base while VMs or snapshots still depend on it, so remove those first. An older controller can't log in to a VM from a new base: noVNC asks for a password it doesn't have. Update the controller too.

Editors: once the `Include` line `setup` prints is in your `~/.ssh/config` ([Install](install.md#laptop--controller)), connect VS Code, Cursor or Zed via Remote-SSH to `demo.boxery`.

### Moving code in and out of a VM

Agents are expected to work inside the VM, so code usually gets there with `git clone` in the VM (add a [`github` grant](grants.md) for private repos). To hand off a local checkout, including unpushed commits and uncommitted work, use plain git and rsync over the `demo.boxery` ssh alias (needs the `Include` line above). No GitHub round trip or VM credentials are involved:

```bash
# once, if the VM has no copy yet
ssh demo.boxery git init -q project/modem

# commits (pushed to a new branch: git refuses to update the VM's checked-out branch)
git push demo.boxery:project/modem HEAD:refs/heads/handoff
ssh demo.boxery git -C project/modem switch handoff

# uncommitted changes, plus untracked files that .gitignore doesn't exclude
git diff --binary HEAD | ssh demo.boxery git -C project/modem apply
git ls-files --others --exclude-standard -z | rsync -a --from0 --files-from=- ./ demo.boxery:project/modem/
```

The other way, fetch the VM agent's commits without touching your working tree:

```bash
git fetch demo.boxery:project/modem 'refs/heads/*:refs/remotes/demo/*'
git log demo/handoff
```

For files that aren't in a repo, use `boxery cp` (above), `vm_copy` (pi/MCP), or `scp`/`rsync` to `demo.boxery`.

### Grants

```bash
boxery access grant demo llm:PROVIDER | http:HOST --cmd CMD | github | ssh-agent | env:VAR [--cmd CMD] | file:LOCAL[=REMOTE]
boxery access revoke demo SPEC… | all
boxery access ls demo [--json]               # saved grant kinds and settings, without fetching values
boxery access apply demo [--quiet]           # push its grants to the VM again
```

`grant`, `revoke` and `grants NAME [apply | --json]` are the older spellings (`grants NAME` is `access ls`, `grants NAME apply` is `access apply`), and `agent-forward NAME on|off` is `access grant|revoke NAME ssh-agent`. `access ls` is read-only and takes only `NAME [--json]`: it never grants, revokes or applies, and it lists this machine's grant records for the selected host, not every controller's.

Adding access prompts on `/dev/tty`, defaults to No, and fails without a controlling terminal; stdin (including `yes | …`) cannot approve. This includes `agent-forward NAME on`, `new --grant` / `--agent-forward`, and `fork --grants`. Creation-time grants are validated and approved before creating VMs. Listing, applying existing grants, revoking, and `agent-forward NAME off` never prompt. Both CLI and agent tools enforce the same deny directories. Grant commands and grant-enriched inventory (`ls`) require Node on the controller. A grant lookup failure makes `ls --json` fail without emitting partial/malformed JSON.

Headless automation can put the literal line `GRANT_CONFIRM=off` in the selected host profile's `config`. **It disables CLI grant confirmation protection for that profile.** It is not an environment variable or flag and does not auto-approve MCP/pi dialogs. Confirmation is not a boundary against a local agent that can fake a terminal or call internals. See [Grants](grants.md#confirmation).

### Shared pool

```bash
boxery lease acquire [--ttl S] [--wait S]    # prints "NAME LEASE_ID"
boxery lease renew NAME [--ttl S]
boxery lease release NAME                    # VM is reset to its clean snapshot
boxery lease ls [--json]                     # your leases
boxery pool add|rm|ls                        # admin: which VMs can be leased
boxery runners once [--repo O/R | --org ORG] [--vms NAME,…] [--labels L,…] [--group ID]
                                             # local runner: one GitHub Actions job on a fresh pool VM, with your gh login
boxery runners status|start|stop|config|token   # admin: host runners, the always-on runner service
```

`acquire`, `renew`, `release` and `leases` are the older spellings of the `lease` actions. See [Shared pool & leases](pool.md) and [GitHub Actions runners](github-runners.md).

### Misc

```bash
boxery host proxy-log [N]                    # which VM called which LLM provider
boxery version [--json]                      # controller + host versions; warns when the host is behind
boxery host backend                          # the host's VM backend; recorded for host ls / vm_info hosts
boxery host upgrade [--check] [--ref REF]    # update boxery on the host (see Install → Upgrading)
```

`proxy-log`, `backend` and real upgrades act on the selected host (`--host NAME`, else the default); `upgrade --check` lists every host unless scoped. `version` also lists every host unless `--host NAME` or `--json` is given; `proxy-log`, `backend` and `upgrade-host` are the older spellings. `shapes` and `pin` stay top level.

### Terminal status

Long commands tell the terminal what they're doing, with the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status) (OSC 7501). A terminal that speaks it, such as Rex, shows a spinner while the command runs and marks it done or failed, so you can start `boxery build-base` and look at another tab. Terminals that don't know the sequence ignore it.

| Reports | When |
|---|---|
| `run`, `wait`, `new`, `fork`, `start`, `stop`, `resize`, `patch`, `snap`, `revert`, `build-base`, `cp`, `upgrade-host` | always (`run --bg` and `upgrade-host --check` return at once, so they don't) |
| `pool add` | always (the other `pool` actions are quick) |
| `logs` | with `-f` |
| `acquire` | with `--wait N`, N above 0 |
| `runners once` | always, including the time it waits for a GitHub job to pick up the runner (the other `runners` actions are host calls) |

A family action (`job wait`, `lease acquire`, `snapshot create`, …) reports through the command it runs. Quick commands (`ls`, `jobs`, `grants`, …) don't report, and neither do `ssh`, `attach`, `forward` and `desktop`, which are interactive or a tunnel with nothing to finish.

- **Outcome:** `working` while it runs, then `done` (exit 0), `error` (anything else, with the exit code), or `idle` when you stop it with Ctrl-C. `wait` reports `done` with "timed out (the job is still running)" when `--timeout` passes (exit 124) and `error` for a lost job (125). A mistake in the command line (a usage error, exit 2 with a usage message) reports `idle`, not a failure. The message is only the VM name, the command and the outcome (`demo: run failed (exit 2)`), never the command's output.
- **Waiting for you:** the grant approval prompt of `new --grant` and `fork --grants` reports `blocked` (a permission), not `working`. Ctrl-C at the prompt ends the command as usual, and the terminal drops the blocked record when the process exits.
- **Only on a terminal:** it's written to stderr, and only when stderr is a terminal and `TERM` isn't `dumb`. Pipes, logs and CI never see it, and neither does stdout. Agents using the `vm_*` tools capture output, so they get none of it.
- **`BOXERY_STATUS=0`** turns it off, and so does any value that isn't `auto` or a yes. `BOXERY_STATUS=1` forces it on even when stderr isn't a terminal (used by the tests; don't set it in a profile, or output that agents capture gets the sequences).
- Inside `boxery attach` it doesn't reach your terminal: tmux drops sequences it doesn't know.
- A command declares it with a `status` on its entry in `controller/cli.mjs`'s `COMMANDS` (`controller/status.mjs`); `test/parity.test.mjs` fails for a command that neither declares one nor says why not.

### All commands

Generated from the help `boxery help --all` shows (`controller/cli.mjs`); edit it there, then `npm run docs:cli`. `--host NAME` before any command runs it on another host. The last table lists the older spellings, each with the family action it is the same as.

<!-- BEGIN generated: boxery commands (npm run docs:cli) -->

**Getting started**

| Command | What it does |
|---|---|
| `boxery setup user@host\|local [--name NAME] [--key K.pub] [--host-bin PATH] [--profile P [--backend B]]`<br>`boxery setup local --backend openshell [OPTIONS]` | Configure a VM host (local = this machine), register your ssh key [→](install.md) |
| `boxery help [--all \| COMMAND [ACTION]]` | Show help for boxery, a command or a family action |

**VMs**

| Command | What it does |
|---|---|
| `boxery ls [--json] [--refresh] [--running]` | List VMs: every host's, a section each (--host NAME: one) (also: `list`) [→](#lifecycle) |
| `boxery new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward]`<br>`boxery new NAME --from VM@SNAP` | Create a VM [→](#lifecycle) |
| `boxery start NAME` | Start a stopped VM (pins its ssh host key where it can) |
| `boxery stop NAME` | Stop a VM |
| `boxery rm NAME` | Destroy a VM and its snapshots (revokes its LLM token) |
| `boxery resize NAME [--cpus N] [--mem MiB] [--disk GiB]` | Change a VM's size (restarts it if running; disk only grows) [→](#lifecycle) |
| `boxery fork SRC DST... [--grants] [--shape S] [--cpus N --mem MiB --disk GiB]` | Copy a VM (running or not) into new VMs, ~10 s [→](#snapshots-and-forks) |
| `boxery patch NAME\|--all [--wait S]` | Update a VM's guest software to the host's image layers [→](#lifecycle) |

**Work in a VM**

| Command | What it does |
|---|---|
| `boxery ssh NAME[@HOST] [CMD...]` | Shell into a VM (also: ssh NAME.boxery) |
| `boxery run [--bg] NAME [--cwd DIR] [--] CMD [ARG...]` | Run a command in ~/project, args as given (like docker exec) [→](#shell-and-in-vm-agents) |
| `boxery cp FROM TO` | Copy files and directories to, from and between VMs [→](copy.md) |
| `boxery sync NAME [--from DIR] [--to PATH] [--json]` | Push a local git checkout into a VM, so its tree matches exactly [→](sync.md) |
| `boxery desktop NAME [--no-open]` | Open a VM's desktop in your browser (noVNC over ssh) [→](#desktop-and-ports) |
| `boxery forward NAME PORT [LOCAL_PORT]` | Forward a VM port to localhost |
| `boxery attach NAME [pi\|opencode\|shell] [SESSION]` | Attach to an agent in a persistent tmux session (= agent attach) |
| `boxery prompt NAME "TASK"` | Start a headless pi task as a background job (= agent prompt) |

**Command families (boxery FAMILY --help)**

| Command | What it does |
|---|---|
| `boxery host add NAME DEST [--key K.pub] [--host-bin PATH] [--backend B \| --profile P]`<br>`boxery host add NAME --config-dir DIR`<br>`boxery host ls [--json]`<br>`boxery host show NAME`<br>`boxery host use NAME`<br>`boxery host rm NAME`<br>`boxery host build-base`<br>`boxery host upgrade [--check] [--ref REF] [--wait S] [--reinit]`<br>`boxery host proxy-log [N]`<br>`boxery host backend`<br>`boxery host backends [--json]`<br>`boxery host capabilities [--json \| --check]` | Named hosts, and maintenance of the selected host [→](hosts.md) |
| `boxery snapshot create NAME [SNAP]`<br>`boxery snapshot ls NAME [--json]`<br>`boxery snapshot restore NAME SNAP`<br>`boxery snapshot rm NAME SNAP`<br>`boxery snapshot images [--json]` | Saved VM disk states: create, restore, list, delete [→](#snapshots-and-forks) |
| `boxery agent attach NAME [pi\|opencode\|shell] [SESSION]`<br>`boxery agent prompt NAME "TASK"`<br>`boxery agent ls NAME [--json]` | Persistent coding-agent sessions in a VM [→](#shell-and-in-vm-agents) |
| `boxery job ls NAME [--json]`<br>`boxery job ls NAME --prune [--older-than 7d] [--json]`<br>`boxery job logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]`<br>`boxery job wait NAME JOB [--timeout S] [--json]`<br>`boxery job kill NAME JOB [--grace S] [--json]` | Background jobs in a VM (run --bg starts one) [→](#background-command-jobs) |
| `boxery access grant NAME SPEC... [--cmd CMD]`<br>`boxery access revoke NAME SPEC...\|all`<br>`boxery access ls NAME [--json]`<br>`boxery access apply NAME [--quiet]` | What a VM may use from this machine (grants) [→](grants.md) |
| `boxery lease acquire [--ttl S] [--wait S] [--holder H]`<br>`boxery lease renew NAME [--ttl S]`<br>`boxery lease release NAME`<br>`boxery lease ls [--json]` | Borrow a VM from the shared pool [→](pool.md) |
| `boxery pool add NAME`<br>`boxery pool rm NAME [--force]`<br>`boxery pool ls [--json]` | Manage the shared pool of leasable VMs (admin) [→](pool.md) |
| `boxery runners once [--repo OWNER/REPO \| --org ORG] [--vms NAME,...] [--labels L,...] [--group ID]`<br>`boxery runners status [--json] \| start \| stop \| token < FILE`<br>`boxery runners config [--repo OWNER/REPO \| --org ORG] [--vms NAME,...] [--count N] [--labels L,...] ...` | GitHub Actions runners on pool VMs [→](github-runners.md) |

**boxery host — named hosts, and maintenance of the selected host**

| Command | What it does |
|---|---|
| `boxery host add NAME DEST [--key K.pub] [--host-bin PATH] [--backend B \| --profile P]`<br>`boxery host add NAME --config-dir DIR` | Register DEST (user@host or local) as NAME [→](hosts.md) |
| `boxery host ls [--json]` | List hosts: where each runs and its backend [→](hosts.md) |
| `boxery host show NAME` | Print a host's profile directory [→](hosts.md) |
| `boxery host use NAME` | Make NAME the default host [→](hosts.md) |
| `boxery host rm NAME` | Forget a host (its VMs and profile data stay) [→](hosts.md) |
| `boxery host build-base` | Build the host's desktop base image (one time, ~3 min) [→](#lifecycle) |
| `boxery host upgrade [--check] [--ref REF] [--wait S] [--reinit]` | Update boxery on the host and restart its services [→](install.md#upgrading) |
| `boxery host proxy-log [N]` | Recent LLM and edge (http: grant) requests on the host |
| `boxery host backend` | The host's VM backend (recorded for host ls) |
| `boxery host backends [--json]` | Backend support and capabilities on every host [→](backends.md) |
| `boxery host capabilities [--json \| --check]` | Every host's platform and capabilities (--host NAME: one) [→](backends.md) |

**boxery snapshot — saved VM disk states: create, restore, list, delete**

| Command | What it does |
|---|---|
| `boxery snapshot create NAME [SNAP]` | Snapshot a VM's disk (Lima restarts a running VM) [→](#snapshots-and-forks) |
| `boxery snapshot ls NAME [--json]` | List a VM's snapshots |
| `boxery snapshot restore NAME SNAP` | Restore a VM to a snapshot (keeps its name, address and token) |
| `boxery snapshot rm NAME SNAP` | Delete a snapshot |
| `boxery snapshot images [--json]` | Snapshots on every host, with HOST column (--host NAME: one) |

**boxery agent — persistent coding-agent sessions in a VM**

| Command | What it does |
|---|---|
| `boxery agent attach NAME [pi\|opencode\|shell] [SESSION]` | Attach to an agent in a persistent tmux session |
| `boxery agent prompt NAME "TASK"` | Start a headless pi task as a background job |
| `boxery agent ls NAME [--json]` | List a VM's tmux sessions |

**boxery job — background jobs in a VM (run --bg starts one)**

| Command | What it does |
|---|---|
| `boxery job ls NAME [--json]`<br>`boxery job ls NAME --prune [--older-than 7d] [--json]` | List background jobs (run --bg starts one) [→](#background-command-jobs) |
| `boxery job logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]` | Show a job's output (the last 200 lines) [→](#background-command-jobs) |
| `boxery job wait NAME JOB [--timeout S] [--json]` | Wait for a job; exits with its exit code [→](#background-command-jobs) |
| `boxery job kill NAME JOB [--grace S] [--json]` | Stop a job: SIGTERM its process group, then SIGKILL [→](#background-command-jobs) |

**boxery access — what a VM may use from this machine (grants)**

| Command | What it does |
|---|---|
| `boxery access grant NAME SPEC... [--cmd CMD]` | Give a VM access to something on this machine (asks first) [→](grants.md) |
| `boxery access revoke NAME SPEC...\|all` | Take access away (pushed values are deleted from the VM) [→](grants.md) |
| `boxery access ls NAME [--json]` | Show a VM's grant kinds and settings (read-only) [→](grants.md) |
| `boxery access apply NAME [--quiet]` | Push a VM's grants to it again [→](grants.md) |

**boxery lease — borrow a VM from the shared pool**

| Command | What it does |
|---|---|
| `boxery lease acquire [--ttl S] [--wait S] [--holder H]` | Lease a VM from the shared pool (prints NAME LEASE_ID) [→](pool.md) |
| `boxery lease renew NAME [--ttl S]` | Extend your lease [→](pool.md) |
| `boxery lease release NAME` | Give a leased VM back (it is reset to its clean snapshot) [→](pool.md) |
| `boxery lease ls [--json]` | Your leases on every host (--host NAME: one) [→](pool.md) |

**More**

| Command | What it does |
|---|---|
| `boxery pin NAME [--from-guest]` | Re-pin a VM's ssh host key (VMs made before keys were pinned) [→](security.md#vm-host-keys) |
| `boxery shapes [--json]` | VM sizes on every host (* = default; --host NAME: one) [→](shapes.md) |
| `boxery version [--json]` | Controller and every host's version; warns per host |

**Older spellings (still work; the same commands as the family actions)**

| Command | What it does |
|---|---|
| `boxery build-base` | Build the host's desktop base image (one time, ~3 min) (= host build-base) [→](#lifecycle) |
| `boxery snap NAME [SNAP]` | Snapshot a VM's disk (Lima restarts a running VM) (= snapshot create) [→](#snapshots-and-forks) |
| `boxery snaps NAME [--json]` | List a VM's snapshots (= snapshot ls) |
| `boxery revert NAME SNAP` | Restore a VM to a snapshot (keeps its name, address and token) (= snapshot restore) |
| `boxery snap-rm NAME SNAP` | Delete a snapshot (= snapshot rm) |
| `boxery images [--json]` | Snapshots on every host, with HOST column (--host NAME: one) (= snapshot images) |
| `boxery sessions NAME [--json]` | List a VM's tmux sessions (= agent ls) |
| `boxery jobs NAME [--json]`<br>`boxery jobs NAME --prune [--older-than 7d] [--json]` | List background jobs (run --bg starts one) (= job ls) [→](#background-command-jobs) |
| `boxery logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]` | Show a job's output (the last 200 lines) (= job logs) [→](#background-command-jobs) |
| `boxery wait NAME JOB [--timeout S] [--json]` | Wait for a job; exits with its exit code (= job wait) [→](#background-command-jobs) |
| `boxery kill NAME JOB [--grace S] [--json]` | Stop a job: SIGTERM its process group, then SIGKILL (= job kill) [→](#background-command-jobs) |
| `boxery grant NAME SPEC... [--cmd CMD]` | Give a VM access to something on this machine (asks first) (= access grant) [→](grants.md) |
| `boxery revoke NAME SPEC...\|all` | Take access away (pushed values are deleted from the VM) (= access revoke) [→](grants.md) |
| `boxery grants NAME [apply [--quiet] \| --json]` | Show a VM's grants, or push them again (apply) (= access ls \| access apply) [→](grants.md) |
| `boxery agent-forward NAME on\|off` | Same as access grant\|revoke NAME ssh-agent |
| `boxery acquire [--ttl S] [--wait S] [--holder H]` | Lease a VM from the shared pool (prints NAME LEASE_ID) (= lease acquire) [→](pool.md) |
| `boxery renew NAME [--ttl S]` | Extend your lease (= lease renew) [→](pool.md) |
| `boxery release NAME` | Give a leased VM back (it is reset to its clean snapshot) (= lease release) [→](pool.md) |
| `boxery leases [--json]` | Your leases on every host (--host NAME: one) (= lease ls) [→](pool.md) |
| `boxery upgrade-host [--check] [--ref REF] [--wait S] [--reinit]` | Update boxery on the host and restart its services (= host upgrade) [→](install.md#upgrading) |
| `boxery backends [--json]` | Backend support and capabilities on every host (= host backends) [→](backends.md) |
| `boxery capabilities [--json \| --check]` | Every host's platform and capabilities (--host NAME: one) (= host capabilities) [→](backends.md) |
| `boxery backend` | The host's VM backend (recorded for host ls) (= host backend) |
| `boxery proxy-log [N]` | Recent LLM and edge (http: grant) requests on the host (= host proxy-log) |

<!-- END generated -->

## `boxery-host` (the VM host)

`boxery-host help` lists every command; `boxery-host COMMAND --help` shows one. Generated from the same help (`host/help.mjs`); edit it there, then `npm run docs:cli`. `--profile NAME` before any command runs it in a second profile on this host (`~/.config/boxery-NAME`: its own backend, state, proxy port and services); `--profile NAME init --backend B` creates it with a free proxy port. `upgrade` keeps the code and each profile's state from before in `$BOXERY_CONF/pre-upgrade/` after a success too.

Controller-generated follow-up hints use the canonical command families (`job logs`, `job wait`, `lease renew`, `access grant`) and shell-quote dynamic arguments so they can be copied safely. They keep an explicit `--host NAME`; grant approval requests name the host even when it was the default, so another controller cannot accidentally grant on a different host. Everyday `run`, `ssh`, `attach` and `prompt` stay short. Shared approval prompts and core/host messages may still name working legacy aliases.

When `boxery` runs a host command, it passes the unchanged `BOXERY_CLI` prefix (`boxery`, or `boxery --host NAME` if you gave one), so a host error suggests `boxery --host lab snap-rm demo s1` rather than `boxery-host snap-rm demo s1`. Commands only boxery-host has (`init`, …) keep its name. Called directly, boxery-host names itself. Messages about a VM that can't be reached (`no such vm`, not running, a pool VM without a lease) name `--host NAME` when you gave one or when the VM's host isn't the default (another host's VM in `cp`, an agent's host session), since a bare `boxery start NAME` would go to the default host.

<!-- BEGIN generated: boxery-host commands (npm run docs:cli) -->

**Setup**

| Command | What it does |
|---|---|
| `boxery-host init [--backend libvirt\|lima\|cloud-hypervisor\|exe\|boat\|openshell]` | Install the proxy and reaper services, backend setup and symlinks [→](install.md) |
| `boxery-host profiles [--json]` | The profiles on this host (backend, proxy port, service, state dir) [→](hosts.md) |
| `boxery-host version [--json]` | This install's version, commit and kind (git or npm) |
| `boxery-host upgrade [--check] [--ref REF] [--wait S] [--reinit]` | Update this install, re-run init for its profiles, check them [→](install.md#upgrading) |
| `boxery-host build-base` | Build the golden desktop image (one time; not for headless VMs) |
| `boxery-host add-key < key.pub` | Authorize a controller's ssh key for new VMs |
| `boxery-host backends [--json]` | Backend support, requirements and capability declarations [→](backends.md) |
| `boxery-host capabilities [--json \| --check]` | This host's platform, validation and conditional capabilities [→](backends.md) |
| `boxery-host backend` | This profile's VM backend |
| `boxery-host help [COMMAND]` | Show help for boxery-host or a command |

**VMs**

| Command | What it does |
|---|---|
| `boxery-host new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless [--layers L,…]]` | Create a VM; prints NAME HOST:PORT [→](#lifecycle) |
| `boxery-host fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]` | Copy a VM (running or not) into new VMs with their own identity [→](#snapshots-and-forks) |
| `boxery-host ls [--json] [--refresh]` | VMs; --refresh first reads running VMs' guest build records (also: `list`) |
| `boxery-host shapes [--json]` | VM sizes (built-ins + shapes.json in the profile; * = default) [→](shapes.md) |
| `boxery-host ip NAME` | A running VM's ssh address |
| `boxery-host start NAME` | Start a VM |
| `boxery-host stop NAME` | Stop a VM |
| `boxery-host rm NAME` | Destroy a VM, its snapshots and its proxy token (also: `delete`) |
| `boxery-host resize NAME [--cpus N] [--mem MiB] [--disk GiB]` | Change a VM's size; a running VM is restarted. Disk only grows [→](#lifecycle) |
| `boxery-host patch NAME\|--all [--wait S]` | Update a VM's guest software to this host's image layers [→](#lifecycle) |
| `boxery-host pin NAME [--from-guest]` | Re-pin running NAME's ssh host key; prints its fingerprint [→](security.md#vm-host-keys) |

**Snapshots & images**

| Command | What it does |
|---|---|
| `boxery-host snap NAME [SNAP]` | Snapshot a VM's disk [→](#snapshots-and-forks) |
| `boxery-host snaps NAME [--json]` | A VM's snapshots, with their age and guest software |
| `boxery-host snap-rm NAME SNAP` | Delete a snapshot |
| `boxery-host revert NAME SNAP` | Restore a VM to a snapshot |
| `boxery-host images [--json]` | Every image on this host (new --from takes one) |

**Connections & proxy**

| Command | What it does |
|---|---|
| `boxery-host connect NAME [PORT]` | Stdio to VM port (for ssh ProxyCommand) |
| `boxery-host known-hosts NAME` | NAME's pinned ssh host key, a known_hosts line (KnownHostsCommand) |
| `boxery-host edge-set NAME [--lease ID] < routes.json` | Set a VM's edge credential routes (boxery grant http:… uses it) [→](grants.md) |
| `boxery-host proxy-log [N]` | Recent LLM + edge proxy requests |

**Shared pool & runners**

| Command | What it does |
|---|---|
| `boxery-host pool add NAME`<br>`boxery-host pool rm NAME [--force]`<br>`boxery-host pool ls [--json]` | The shared pool of leasable VMs [→](pool.md) |
| `boxery-host acquire --holder H [--ttl S] [--wait S] [--only NAME,…] [--json]` | Lease a free pool VM (lease ssh pubkey on stdin) [→](pool.md) |
| `boxery-host renew LEASE [--ttl S] [--json]` | Extend a lease [→](pool.md) |
| `boxery-host release LEASE` | End a lease (the VM is reset to its clean image) [→](pool.md) |
| `boxery-host reap` | Release expired leases, recover abandoned operations [→](lifecycle.md) |
| `boxery-host reconcile` | Recover abandoned operations and check inventory drift [→](lifecycle.md) |
| `boxery-host runners status [--json] \| start \| stop \| token < FILE \| run`<br>`boxery-host runners config [--repo OWNER/REPO \| --org ORG] [--vms NAME,…] [--count N] [--labels L,…] [--group ID] [--ttl S] [--api URL] [--prefix P]` | GitHub Actions runners, one job per freshly reset pool VM [→](github-runners.md) |

<!-- END generated -->

`runners` is described in [GitHub Actions runners](github-runners.md); `boxery runners …` on your machine passes the same arguments (and stdin, for `token`) to the host, except `runners once`, which runs on your machine with its `gh` login and drives the host's internal `runners __once`.

`acquire` prints `NAME LEASE_ID EXPIRES` and `renew` prints `NAME EXPIRES`; with `--json`, both print `{"name","lease_id","expires_at"}` (expiry in unix seconds). The controller asks for `--json` when the host's `help` shows it (and falls back to the line for a host that predates it); the runner manager, part of the same install, always does.

`reconcile` (also performed by `reap`) recovers abandoned lifecycle operations and checks inventory drift. Conflicting VM mutations are serialized through readiness/key installation, not just disk operations. See [Lifecycle coordination and recovery](lifecycle.md) for crash behavior, backend responsibilities and upgrade precautions.

## JSON output

Every listing command takes `--json` and prints one JSON value on stdout. Errors go to stderr with a non-zero exit status; nothing else is printed on stdout. Field names below are stable: new fields may be added, existing ones are not renamed or removed without a major version bump.

Conventions:

- Timestamps are Unix epoch seconds (numbers). Durations are seconds.
- A field that is unknown or does not apply is `null`, never `""` or `"-"`.
- Arrays are printed one element per line. That is still ordinary JSON; parse it as a whole.
- Empty lists print `[]`.

Both `boxery` and `boxery-host` build JSON in Node; neither needs `jq`.

### Controller (`boxery`, on your laptop)

#### `boxery ls --json`

VMs on one host (the default, or `--host NAME`; text `ls` lists every host), plus the grants this machine has given each one. `--running` keeps only running VMs.

```json
[
{"name":"demo","state":"running","ssh_addr":"192.168.122.50:22","disk_size":40,"disk_used":2.1,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192,"desktop":true,"os":"linux","grants":[{"kind":"ssh-agent"}]},
{"name":"pool-1","state":"running","ssh_addr":"192.168.122.51:22","disk_size":80,"disk_used":1.8,"tunnel":null,"lease":{"state":"leased","holder":"ben@mac","expires_at":1793462400},"shape":"large","cpus":8,"mem":16384,"desktop":false,"os":"linux","grants":[]}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | VM name |
| `state` | string \| null | backend state: `running`, `shut off`, … (as reported by libvirt/Lima; `paused` on exe.dev; `starting`/`stopping` on boat.dev) |
| `ssh_addr` | string \| null | the VM's ssh endpoint as the host reaches it, always `HOST:PORT` (`192.168.122.50:22` on libvirt and cloud-hypervisor, `127.0.0.1:PORT` on Lima and the tunnelled backends). `null` while the VM isn't running (or its tunnel isn't `up`). Agents don't connect to it directly; `boxery` reaches VMs through the host |
| `disk_size` | number \| null | the disk's configured size in GiB (what `--disk` set, or the size it was grown to) |
| `disk_used` | number \| null | GiB the VM's own disk takes on the host (allocated blocks, two decimals; a shared base image is not counted). `null` where the backend can't know (exe.dev, boat.dev) |
| `tunnel` | string \| null | exe.dev and boat.dev only: the host's ssh tunnel to the VM, which carries its ssh endpoint and LLM proxy: `up`, `connecting` (retrying; is the host online?) or `down` (`boxery-host start NAME`). `null` on other backends. A running VM shows `ssh_addr: null` while its tunnel isn't `up` |
| `lease` | object \| null | `null` for ordinary VMs; for pool VMs: `{state, holder, expires_at}`, `state` lowercase as in `pool ls` |
| `shape` | string \| null | shape the VM was created with; `custom` if size flags or `resize` changed it, if the backend gave it other CPUs or memory than the shape's (exe.dev's account limit, boat's types; [shapes](shapes.md)), or if it has no recorded size (made before shapes, or outside boxery: its size is read from the backend once and recorded); `null` only if the size can't be read |
| `cpus` | number \| null | vCPUs (`null` if unknown) |
| `mem` | number \| null | memory in MiB (`null` if unknown) |
| `desktop` | boolean | `false` for headless VMs (`new --headless`, or made from a headless VM's image); `true` otherwise, including VMs created before headless VMs existed |
| `os` | string | the guest OS: `linux` (the only one so far; VMs made before it was recorded are `linux` too). A VM made from an image or a fork has its source's |
| `guest` | object | the VM's guest software, from the host's build record (see [Outdated guest software](#lifecycle)): `status` (`current`, `outdated` or `unknown`), `reasons` (why: `layers changed`, `built N days ago`, `reboot required`, `no build record`, `not checked`), `built_at` (epoch seconds), `age_days`, `kernel` (the newest installed), `chrome` and `playwright_core` (desktops; `null` otherwise), `reboot_required`, `checked_at` (when the host last read it; `null` if never). Unknown fields are `null` |
| `grants` | array | this machine's grants for the VM, same objects as `grants --json` |

#### `boxery shapes --json`

VM sizes the host offers, after merging its `shapes.json` over the built-ins ([Shapes](shapes.md)).

```json
{"default":"standard","shapes":{"small":{"cpus":2,"mem":4096,"disk":20},"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}
```

| Field | Type | |
|---|---|---|
| `default` | string | shape used when `new` gets no `--shape` or size flags |
| `shapes` | object | shape name → `{cpus, mem (MiB), disk (GiB)}` |

#### `boxery grants NAME --json`

(Also `boxery access ls NAME --json`.) Local grant specifications, including stored command text, without fetching values. With none recorded, the host is asked whether NAME exists: `[]` for a VM without grants, `no such vm: NAME` (exit 1) for one the host doesn't list. A host that can't be reached doesn't fail the listing.

```json
[
{"kind":"ssh-agent"},
{"kind":"env","var":"GITHUB_TOKEN","cmd":"gh auth token"},
{"kind":"file","local":"/Users/ben/app/.env","remote":"/home/agent/project/.env"}
]
```

| `kind` | Fields |
|---|---|
| `ssh-agent` | (none) |
| `env` | `var` (string), `cmd` (string \| null: command that produces the value; `null` = read from the local environment) |
| `file` | `local` (absolute local path), `remote` (absolute path in the VM) |
| `llm` | `provider` (`chatgpt`, `openai`, `anthropic`, `ollama`) |
| `http` | `host`, `auth` (`bearer`, `basic:USER`, `header:NAME`), `readonly` (boolean), `cmd` (command that produces the secret) |

#### `boxery leases --json`

(Also `boxery lease ls --json`.) Leases held by this machine (from `~/.boxery/leases`).

```json
[
{"name":"pool-1","lease_id":"l-0123456789abcdef0123456789abcdef","expires_at":1793462400,"expires_in":1712,"ttl":1800,"holder":"ben@mac"}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | leased VM |
| `lease_id` | string | `l-` + 32 hex |
| `expires_at` | number | last known expiry (updated by `renew`) |
| `expires_in` | number | seconds left, `0` once expired |
| `ttl` | number \| null | TTL used for renewals |
| `holder` | string \| null | holder name sent to the host |

#### `boxery sessions NAME --json`

(Also `boxery agent ls NAME --json`.) tmux sessions in the VM (agents started by `attach` / `prompt`).

```json
[
{"name":"pi","windows":1,"created":1793460000,"attached":true},
{"name":"task-20261031-120000","windows":1,"created":1793460100,"attached":false}
]
```

#### `boxery jobs NAME --json`

(Also `boxery job ls NAME --json`.) Background jobs in the VM (started by `run --bg` or `vm_jobs`), oldest first.

```json
[
{"id":"job-20261101-120000-a1b2c3","state":"exited","command":"pnpm test","argv":["pnpm","test"],"cwd":"/home/agent/project/app","started_at":1793460000,"ended_at":1793460371,"exit_code":1,"killed":false,"log":"/home/agent/.boxery/jobs/job-20261101-120000-a1b2c3.log"}
]
```

| Field | Type | |
|---|---|---|
| `id` | string | `job-` + the VM's local time + a random suffix. Scoped to the VM and host. |
| `state` | string | `running`, `exited` or `lost` |
| `command` | string | `argv` as a shell-quoted line, for display |
| `argv` | array | the arguments, exactly as given |
| `cwd` | string | absolute working directory |
| `started_at`, `ended_at` | number \| null | Unix epoch seconds. `ended_at` is `null` unless `exited`. |
| `exit_code` | number \| null | `null` unless `exited`. A signal shows as 128 + signal (143 = SIGTERM). |
| `killed` | boolean | stopped by `kill` |
| `leftover` | boolean | `exited`, but processes it started are still running (`kill` stops them) |
| `log` | string | log path in the VM |

`wait NAME JOB --json` prints one such object plus `timed_out` (boolean), whenever the VM answered (the exit status is as without `--json`). `kill NAME JOB --json` prints one object. `jobs NAME --prune --json` prints the removed IDs.

#### `boxery host ls --json`

Registered hosts, by name. Read from local profile files only: no host is contacted. The same fields as MCP `vm_info {action:"hosts"}` (which adds `current`).

```json
[
{"name":"hornet","dir":"/home/you/.boxery/profiles/hornet","default":false,"destination":"you@hornet","backend":"libvirt","same_as":[]},
{"name":"laptop","dir":"/home/you/.boxery/profiles/local","default":false,"destination":"local","backend":"lima","same_as":["local"]},
{"name":"local","dir":"/home/you/.boxery/profiles/local","default":true,"destination":"local","backend":"lima","same_as":["laptop"]}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | host name for `--host` |
| `dir` | string | profile directory (`config`, `ssh_config`, grants, leases) |
| `default` | boolean | selected by `host use` (`default-host`; the first host registered starts as the default) |
| `destination` | string \| null | where its VM host runs: `local` (this machine) or the ssh destination (`user@host` or an ssh-config alias). `null` when not set up |
| `backend` | string \| null | `lima`, `libvirt`, `cloud-hypervisor`, `exe`, `boat`, … as recorded by `setup` or `boxery backend`; `null` if never recorded (an older profile: run `boxery --host NAME host backend`; or a host that predates `boxery-host backend`) |
| `same_as` | string[] | other names for the same host and VMs: the same profile directory (e.g. a second name imported with `--config-dir`), or the same destination and host-side profile (e.g. a second name added with `host add NAME DEST --profile P`); see [Named hosts](hosts.md) |

#### `boxery snaps NAME --json`

(Also `boxery snapshot ls NAME --json`.) Snapshots of a VM, passed through from `boxery-host snaps NAME --json`. `size` is `null` when the backend does not report it. `age_days` is days since it was taken; `guest` is the guest software it holds (its VM's build record when it was taken), the same object as in `ls --json` except that `reboot_required` is `null` (a VM made from an image boots fresh).

```json
[
{"name":"before-refactor","created":"2026-10-31T19:28:31","size":"173MiB","age_days":2,"guest":{"status":"current","reasons":[],"built_at":1793300000,"age_days":4,"kernel":"6.8.0-90-generic","chrome":"Google Chrome 141.0.7390.54","playwright_core":"1.57.0","reboot_required":null,"checked_at":1793460000}}
]
```

The text form is tab-separated: `NAME CREATED SIZE AGE GUEST` (`AGE` like `2d`).

### Host (`boxery-host`, on the VM host)

#### `boxery-host ls --json`

Same objects as `boxery ls --json` without `grants` (grants live on the controller): `name`, `state`, `ssh_addr`, `disk_size`, `disk_used`, `tunnel`, `lease`, `shape`, `cpus`, `mem`, `desktop`, `os`, `guest`. Built in one place from the backend's `backend_list` lines, the recorded VM sizes, the lease store and the build records (`--refresh`: read from running VMs first).

#### `boxery-host snaps NAME --json`

`[{"name", "created", "size", "age_days", "guest"}]`, from the backend's `backend_images` and the build records.

#### `boxery-host images --json`

`[{"image", "created", "size", "age_days", "guest"}]`: every image on the host (`VM@SNAP`), from the backend's `backend_images` and the build records; empty fields are `null`.

#### `boxery-host pool ls --json`

Every pool VM and its lease state.

```json
[
{"name":"pool-1","state":"leased","holder":"ben@mac","acquired_at":1793460600,"expires_at":1793462400,"expires_in":1800},
{"name":"pool-2","state":"free","holder":null,"acquired_at":null,"expires_at":null,"expires_in":null}
]
```

| Field | Type | |
|---|---|---|
| `state` | string | `free`, `acquiring`, `leased`, `resetting`, `broken` |
| `holder` | string \| null | who holds it |
| `acquired_at`, `expires_at` | number \| null | lease start / expiry |
| `expires_in` | number \| null | seconds left (only while `leased`; may be negative until the reaper runs) |

Run it on the host, or from the controller as `boxery pool ls --json`.

#### `boxery-host acquire … --json`, `boxery-host renew LEASE … --json`

The lease just taken or extended: `{"name":"pool-1","lease_id":"l-0123456789abcdef0123456789abcdef","expires_at":1793462400}`.

| Field | Type | |
|---|---|---|
| `name` | string | the pool VM |
| `lease_id` | string | `l-` + 32 hex |
| `expires_at` | number | expiry (unix seconds) |

The controller (`boxery acquire`, `vm_lease`) asks for it when the host's `help` shows `renew … [--json]`; without `--json` the host prints `NAME LEASE_ID EXPIRES` / `NAME EXPIRES`.

## Configuration

| Where | What |
|---|---|
| `~/.boxery/host-registry/HOST`, `~/.boxery/default-host` | Registered hosts and the default one ([Named hosts](hosts.md)) |
| `~/.boxery/profiles/HOST/config` | Controller: host, host binary path, identity |
| `~/.boxery/profiles/HOST/ssh_config` | Generated. `*.boxery` hosts via `ProxyCommand`. |
| `~/.boxery/profiles/HOST/grants/NAME` | Grant names and paths (never values) |
| `~/.boxery/profiles/HOST/leases/` | Your leases and their per-lease ssh keys |
| `~/.config/boxery/host.env` (host) | Backend and overrides (`BOXERY_BACKEND`, `BOXERY_LIMA_VMTYPE`, …) |
| `~/.config/boxery/proxy.env` (host) | Extra LLM provider keys (VMs still need an `llm:` grant to use them) |
| `~/.config/boxery/tokens.json` (host) | Per-VM proxy tokens (per lease on pool VMs) |
| `~/.config/boxery/leases.db` (host) | Lease state (SQLite) |
| `~/.config/boxery/build-info/` (host) | What each VM and image was built with (`NAME`, `NAME@SNAP`: JSON), for `ls`, `snaps` and `images` |
