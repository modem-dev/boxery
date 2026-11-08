# Environment recipes (v1)

A recipe describes a starting guest and an optional, ordinary Bash setup script. Keep them in a
project repository; share/review them like other executable project configuration. Recipes do not
introduce a provisioning language, require Nix/Ansible/Packer, or name a stockpile of snapshots.

For an experimental Arch development VM on Lima x86_64:

```json
{
  "version": 1,
  "kind": "headless",
  "distro": "arch",
  "setup": "setup.sh"
}
```

Save this as `.boxery/recipe.json` and put `setup.sh` beside it:

```bash
#!/usr/bin/env bash
sudo pacman -Syu --needed --noconfirm python uv
```

Then explicitly apply it:

```sh
boxery --host linux-lima new work --recipe .boxery/recipe.json --shape large
```

For Ubuntu, set `distro` to `ubuntu` and use apt commands in the setup script. Omitting `distro` keeps
the backend's normal source; `kind` is required (`desktop` or `headless`). `setup` is optional: an
OS-only recipe is valid. Supported OS/backend combinations are described in [Guest distributions](distros.md).
The default provider source is not necessarily Ubuntu (for example exe.dev uses exeuntu).

The setup script runs **inside the guest**, as `agent`, in its project directory. On ordinary VM
backends it can use `sudo`; OpenShell's existing restrictions still apply. It runs with Bash
`errexit`, `nounset` and `pipefail`, under the existing remote process-group/timeout transport (10-minute
setup limit). Nothing in a recipe is executed on the controller or trusted host. A setup script may
invoke an existing tool such as Ansible or Nix; Boxery does not interpret those tools' configuration.

## Safety and behavior

- Loading is explicit: no scanning/autoloading repository files, fetching remote recipes, building on
  the host, or running container/VM builders with host privileges.
- Review recipes before use. Guest code can use the network and any access that VM has. "Guest only"
  does not make malicious code harmless; the selected backend's documented isolation limits apply.
- The JSON accepts only `version`, `kind`, `distro`, and `setup`; unknown fields fail before creation.
  It cannot grant credentials, select a host, enable host mounts, or turn on agent forwarding.
- `setup` must be a relative file inside the recipe directory, including its resolved symlink target.
  JSON/script files must be regular, at most 32 KiB each, and contain no NUL bytes. The exact contents
  are read before VM creation, not fetched again later.
- `--from` and `--layers` cannot combine with `--recipe`. Contradictory `--headless`/`--distro` overrides
  fail. Shape/size flags and separately approved creation-time grants still work.
- Setup runs before applying new creation-time grants. On setup failure, the command fails and retains
  the VM for inspection; it does not apply those grants or silently rerun setup. Remove it explicitly
  with `boxery rm NAME` when done. Ordinary lifecycle recovery covers creation, not a transactional
  rollback of arbitrary provisioning scripts.
- Successful setup records a content hash and guest selection in `~/.boxery/recipe.json` inside the
  guest. It does not record script contents, controller paths or secrets. Disk snapshots/forks carry
  that provenance as ordinary files. Existing VMs aren't automatically reconciled to edited recipes.

Local CLI, stdio MCP and pi support recipes (`vm_manage {action:"new", recipe:"/local/path/recipe.json"}`).
HTTP/confined MCP refuses local recipe paths, including with `--copy-root`: it must not gain a new
way to read control-plane files. Run recipes from a local client instead.

## Deliberate limits

This is a creation workflow, not an image builder, scheduler, recipe registry or fully reproducible
build system. No automatic image cache, uploads of arbitrary project files, repository cloning,
implicit grants, live migration or existing-VM resume is added. Rolling distributions and unpinned
setup commands change over time; the recorded hash identifies the inputs, not every package resolved
from the network. Image versioning and repeatable dependency pinning are separate concerns.
