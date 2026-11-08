# Guest distributions (experimental)

Boxery's guest OS family remains `linux`; the distribution is a creation-time choice, not a new
hypervisor backend. Existing creation defaults are unchanged.

```sh
boxery --host linux-lima new arch-dev --headless --distro arch
```

Arch currently supports **Lima x86_64, headless, without optional layers** only. Boxery references
Lima's existing `_images/archlinux` definition instead of maintaining another image URL catalog or
installer language. Native `qemu` can emulate x86_64 on other architectures, but that is not a tested
configuration. Lima's older community aarch64 Arch image is deliberately not selected.

The plumbing/devtools layers use `pacman -Syu` and Arch package names. They still install Boxery's
proxy bridge, SSH configuration, tmux, Node and agent tooling. Distribution selection does not grant
LLM/API access or forward the controller's SSH agent. Host mounts remain disabled. Arch rolling
repositories and Lima's installed image definitions are not a reproducibility guarantee.

`--distro ubuntu` is supported explicitly on Lima, libvirt and Cloud Hypervisor (and fake tests).
Other backends keep their provider-controlled starting environment. Unknown distributions and
unsupported combinations fail; they never silently fall back to Ubuntu. `--from` cannot combine with
`--distro`: snapshots/forks inherit their source's distribution. Patching a headless Arch guest uses
its native package manager, but reboot-required detection remains Ubuntu-oriented; restart after
kernel/system updates explicitly.

## Validation boundary

Offline tests cover CLI/host argument validation, Lima's native image selection and confinement
settings, lifecycle lock parsing and pacman command generation. No live Arch guest validation is
claimed by this initial implementation. Before enabling production support, boot a disposable VM and
exercise SSH pinning, file tools, jobs, proxy grant/revoke, patch/restart and disk-only fork/reset.
Desktop Arch, aarch64 Arch and other backends remain unsupported.
