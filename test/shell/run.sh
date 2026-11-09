#!/usr/bin/env bash
# Run the offline shell tests, in parallel: run.sh [DIR...], every directory by default. Where a test lives
# says where it has to run:
#   common/  code that runs on macOS and Linux and can differ between them (shims, controller, the Lima,
#            exe and boat backends, launchd paths): every OS, macOS included
#   linux/   code that only runs on Linux (the libvirt and Cloud Hypervisor backends, systemd units)
#   logic/   Node logic driven through the fake backend: the same on any OS, so CI runs it on Linux only
# When unsure, use common/: a test there that didn't need macOS costs CI time; one missing from it loses
# coverage. BASH_UNDER_TEST=/path/to/bash runs them under another bash (e.g. 3.2); JOBS=N caps how many run at once
# (default: the CPU count). Each test's output is printed whole once it finishes, in start order. Tests
# must keep their state in their own mktemp -d.
# This script itself runs under bash 3.2 on macOS, so no wait -n: it polls for finished tests.
set -euo pipefail
cd "$(dirname "$0")"
B=${BASH_UNDER_TEST:-bash}
JOBS=${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}
[ "$JOBS" -ge 1 ] || JOBS=1
# only the directories are globbed: a test left up here would never run, so stop until it is moved
for t in *.sh; do
	[ "$t" = run.sh ] || { echo "run.sh: test/shell/$t would never run; move it into common/, linux/ or logic/ (see the top of run.sh)" >&2; exit 2; }
done
[ $# -gt 0 ] || set -- */
files=()
for d in "$@"; do
	d=${d%/}
	[ -d "$d" ] || { echo "run.sh: no test directory $d (have: $(echo */ | tr -d /))" >&2; exit 2; }
	for t in "$d"/*.sh; do [ -f "$t" ] && files+=("$t"); done
done
[ ${#files[@]} -gt 0 ] || { echo "run.sh: no tests in $*" >&2; exit 2; }
tests=()
# Longest file first, a stand-in for slowest, so a long test doesn't start last.
while read -r _ t; do tests+=("$t"); done < <(for t in "${files[@]}"; do awk 'END { print NR, FILENAME }' "$t"; done | sort -rn)
ver=$("$B" -c 'echo $BASH_VERSION')
out=$(mktemp -d)
# A tripwire in front of this machine's launchctl and systemctl: tests stub them (their stubs come first on
# PATH). The real ones act on this account's launchd domain / systemd user manager whatever HOME is, so a
# test that misses a stub would replace the user's own services (one replaced dev.boxery-proxy).
trip=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$out" "$trip"' EXIT
# logs and tripwire records are kept by test path, so each test's directory is made in both
for t in "${tests[@]}"; do mkdir -p "$out/${t%/*}" "$trip/reached/${t%/*}"; done
for c in launchctl systemctl; do
	command -v "$c" >/dev/null || continue   # absent here: keep it absent
	printf '#!/bin/sh\necho "%s $*" >>"%s/reached/${BOXERY_TEST_FILE:-unknown}"\necho "test reached the real %s (stub it)" >&2\nexit 97\n' "$c" "$trip" "$c" >"$trip/$c"
	chmod +x "$trip/$c"
done
export PATH="$trip:$PATH"

# one TEST: run it with its output in $out/TEST.log; $out/TEST.done ("RC SECONDS") appears when it's finished
one() {
	local s rc; s=$(date +%s)
	BOXERY_TEST_FILE=$1 "$B" "$1" >"$out/$1.log" 2>&1 && rc=0 || rc=$?
	echo "$rc $(($(date +%s) - s))" >"$out/$1.tmp" && mv "$out/$1.tmp" "$out/$1.done"
}
rc=0 next=0 started=0 n=${#tests[@]}
# Print every finished test from $next on, stopping at the first one still running.
flush() {
	local t trc secs
	while [ "$next" -lt "$n" ] && [ -f "$out/${tests[$next]}.done" ]; do
		t=${tests[$next]}; read -r trc secs <"$out/$t.done"
		echo "== $t ($ver, ${secs}s)"; cat "$out/$t.log"
		[ "$trc" = 0 ] || { echo "!! $t exited $trc"; rc=1; }
		if [ -s "$trip/reached/$t" ]; then
			echo "  ✗ $t reached the real service manager:"; sed 's/^/    /' "$trip/reached/$t"; rc=1
		fi
		next=$((next + 1))
	done
}
# A process that lost BOXERY_TEST_FILE still trips the wire: which test is unknown, but the run fails.
unknown() {
	if [ -s "$trip/reached/unknown" ]; then
		echo "  ✗ a test reached the real service manager:"; sed 's/^/    /' "$trip/reached/unknown"; rm "$trip/reached/unknown"; rc=1
	fi
}
running() {
	local c=0 i
	for ((i = next; i < started; i++)); do [ -f "$out/${tests[$i]}.done" ] || c=$((c + 1)); done
	echo "$c"
}
while [ "$next" -lt "$n" ]; do
	if [ "$started" -lt "$n" ] && [ "$(running)" -lt "$JOBS" ]; then
		one "${tests[$started]}" &
		started=$((started + 1))
	else
		flush
		if [ "$next" -lt "$n" ]; then sleep 0.1; fi
	fi
done
unknown
exit $rc
