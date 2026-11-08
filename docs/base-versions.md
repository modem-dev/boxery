# Versioned desktop bases: libvirt first

`boxery build-base` on libvirt builds a **new volume**, rather than replacing the current base or
refusing because existing VMs depend on it. Headless/stock-image creation is unchanged. Other backends
retain their existing build behavior; this is not a universal image registry or GC feature.

- Each attempt gets a UUID-named disk, builder domain, seed and serial log. It never replaces another
  attempt's volume, seed or builder. The immutable upload path refuses existing targets.
- After the builder has stopped and its serial log confirms `BOXERY_BUILD_OK`, Boxery atomically
  publishes the selected volume name in the host profile's `libvirt-base-<scope>.current` file. The
  scope includes the libvirt connection, pool and configured `BOXERY_BASE_VOL` alias.
- Each backend invocation resolves that pointer once. New desktop overlays record the **actual version
  volume** as their backing file, never a symlink or movable alias. Older VMs, disk images, forks and
  resets keep their existing backing chain. Updating the pointer cannot retarget an existing disk.
- `BOXERY_BASE_VOL` and operation journals continue to contain the configured alias, not whatever
  version happened to be current when an administrative check ran.
- Before the first successful versioned build, the legacy base is used unchanged. It is not renamed,
  overwritten or deleted during migration. A malformed pointer is an error; a missing selected volume
  is a missing base, not a reason to silently select some other version.
- A failed build does not publish. Ordinary failure cleanup stops/undefines only its own builder and
  removes its seed; the candidate disk and serial log remain for diagnosis. Concurrent successful
  builds can both finish: the last successful publication selects the base for future creates, and
  all built versions remain intact.

Build user-data now lives in a private per-attempt cache directory across all backends, so one build
cannot atomically replace a shared file just before another backend reads it.

## Storage and limits

**Old base versions are deliberately retained.** Do not delete a version just because it is no longer
current: stopped VMs and images can still depend on it. Use libvirt's volume/backing-chain inspection
before any manual cleanup. Automated GC, a public base-version listing/rollback command, per-VM
base-version/staleness reporting, signatures and portable image publication remain follow-up work.

The publication uses an atomic same-directory rename; a complete power-loss/durability matrix has not
been validated. `build-base` remains an administrative operation outside the VM intent journal. A
SIGKILL/host crash can leave an unpublished builder/candidate; it must not be mistaken for a validated
base or automatically published by recovery. There is no claim of automatic orphan cleanup.

## Validation

The offline regression runs the real builder/publication code against a mocked native volume/domain
API: migration from a legacy base, multiple builds with active dependents, failure before publication,
concurrent builders, immutable-upload refusal, profile/pool pointer scoping and malformed pointers.
Existing libvirt image/backing-chain tests must continue to pass. Before merge, validate a real private
libvirt pool: create from version A, publish B, prove A's VM/image/fork/reset still use A and new desktops
use B, then test failed publication and host reboot. No live libvirt build result is claimed here.
