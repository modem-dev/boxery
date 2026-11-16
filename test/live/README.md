# Opt-in real-backend lifecycle checks

These checks create **three real VMs**, each initially 1 vCPU / 2 GiB RAM / 20 GiB disk. Provider compute
can be billed. Use an explicitly registered, disposable test host/profile with enough capacity, not
production. The normal `npm test` and offline CI never start this runner.

```sh
BOXERY_LIVE_ALLOW_CREATE=1 BOXERY_LIVE_HOST=lab npm run test:live
# With the experimental Arch feature installed on the selected Lima x86_64 host:
BOXERY_LIVE_ALLOW_CREATE=1 BOXERY_LIVE_HOST=arch-lab BOXERY_LIVE_DISTRO=arch npm run test:live
```

`BOXERY_LIVE_CLI` optionally selects an executable controller path. Default: this checkout's controller.
The registered host's `boxery-host` must have the features being tested installed too. This does not
install/upgrade either side or build/rebuild bases. Headless provisioning can download packages and
agent tooling from the network. No model inference or grants are requested.

## What runs

Supported backends: libvirt, Lima, Cloud Hypervisor and exe.dev. Arch selection requires the experimental
Lima feature; unknown/unsupported combinations fail before creation.

1. Create a fresh headless source and check SSH, its headless marker and actual tmpfs at `/dev/shm`.
2. Write a persistent project file and a dummy tmpfs marker (not a real credential).
3. Capture a disk image; create a second VM from it. Check disk contents survived, tmpfs did not, and
   machine IDs plus pinned SSH host keys are distinct.
4. Change the clone's file; check the source is unchanged. Fork the clone and check independent
   contents and another fresh identity, again without the tmpfs marker.
5. Stop/start the clone: persistent disk data and VM/SSH identity must survive; tmpfs must not.
6. Remove the three generated VMs in reverse order (their snapshots are removed by normal lifecycle
   cleanup). Every attempted create is tracked before dispatch, covering partial-create failures.

Only names generated as `live-<random>-a/b/c` are mutated. No existing VM name is accepted, no shared
network configuration changes, no `init`, `build-base`, grants, pools or source-image deletion outside
the generated VM tree. Ordinary SSH connections check the selected host's pinned VM keys.

SIGINT/SIGTERM cancels active CLI work and attempts cleanup with a fresh, non-aborted transport.
Cleanup errors fail the run and identify resources needing inspection; they are not swallowed behind
a passing check. SIGKILL, power loss, a second interrupt or unreachable hosts can still leave generated
VMs. The runner prints their names before starting; inspect/remove only those resources manually.

## What this does not prove

This is an **opt-in lifecycle regression**, not a security audit, network isolation matrix, real grant
revocation test, pool lease-fencing test, versioned-base rebuild/reboot test or recipe package test.
No actual real-backend pass is claimed just because the runner is added. Offline unit tests check the
runner's consent gate, operation sequencing, generated resource scope and cleanup paths with command
doubles; those results must never be relabeled as live hypervisor validation.

Record backend/version, host architecture, commands, timings and pass/fail when you run it. Use a
separate dedicated pool/profile for destructive base-version or host-reboot validation.
