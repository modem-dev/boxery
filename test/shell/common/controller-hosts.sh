#!/usr/bin/env bash
# shellcheck disable=SC2088 # tilde strings below intentionally refer to target home
# Offline multi-profile registry and shell-layer quoting regressions (stock Bash 3.2).
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$ROOT/controller/boxery
REAL_SSH=$(command -v ssh)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" # even an injection regression's marker stays inside the fixture
export BOXERY_HOME="$tmp/registry" HOME="$tmp/controller-home"
mkdir -p "$HOME/.ssh" "$tmp/bin" "$tmp/remote-home"
printf 'public key\n' >"$HOME/.ssh/id_ed25519.pub"
export SSH_LOG="$tmp/ssh.log" REMOTE_HOME="$tmp/remote-home"
cat >"$tmp/bin/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SSH_LOG"
while [ $# -gt 0 ]; do case $1 in -o|-F) shift 2 ;; --) shift ;; *) break ;; esac; done
case ${1:-} in *.boxery) exit 0 ;; esac
shift
HOME=$REMOTE_HOME exec /bin/sh -c "$*"
STUB
chmod +x "$tmp/bin/ssh"
export PATH="$tmp/bin:$PATH"
# The executable path is data, including an apostrophe, $, backticks, %, spaces and shell syntax.
rel="bin/it's \$(touch NOT_EXECUTED) \`echo no\` % host"
mkdir -p "$REMOTE_HOME/bin"
printf '#!/usr/bin/env bash\ncase $1 in help) : ;; add-key) cat >/dev/null ;; ls) echo '"'"'[{"name":"demo","state":"running"}]'"'"' ;; connect) printf "CONNECTED:%%s:%%s\\n" "$2" "$3" ;; images) printf "via:%%s\\n" "${BOXERY_CLI-unset}" ;; esac\n' >"$REMOTE_HOME/$rel"
chmod +x "$REMOTE_HOME/$rel"
# Before any host is registered nothing is routed anywhere.
if "$CLI" ls >/dev/null 2>&1; then echo 'routed without a host' >&2; exit 1; fi
"$CLI" ls 2>&1 | grep -q 'no host configured'
"$CLI" host add alpha user@fake --host-bin "~/$rel" >/dev/null
[ "$(cat "$BOXERY_HOME/default-host")" = alpha ] # the first host becomes the default
[ "$("$CLI" host show alpha)" = "$BOXERY_HOME/profiles/alpha" ]
# Sourcing saved config on the controller must NOT expand the remote tilde.
# shellcheck disable=SC1090
. "$BOXERY_HOME/profiles/alpha/config"
[ "$HOST_BIN" = "~/$rel" ]
[ ! -e NOT_EXECUTED ]
"$CLI" --host alpha ls | grep -q '^demo '
# The remote host learns how boxery was run (BOXERY_CLI), for the commands its hints name.
[ "$("$CLI" --host alpha images)" = "via:boxery --host alpha" ]
[ "$("$CLI" images)" = "via:boxery" ]
# Execute exactly the ProxyCommand resolved by OpenSSH: local shell -> ssh -> remote /bin/sh.
proxy=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/alpha/ssh_config" -G demo.boxery | sed -n 's/^proxycommand //p')
# ssh -G retains tokens; model OpenSSH's percent substitution before /bin/sh executes it.
proxy=${proxy//%%/PERCENT_PLACEHOLDER}; proxy=${proxy//%h/demo.boxery}; proxy=${proxy//%p/22}; proxy=${proxy//PERCENT_PLACEHOLDER/%}
sh -c "$proxy" | grep -q '^CONNECTED:demo.boxery:22$'
[ ! -e NOT_EXECUTED ]
# Import as-is: paths with spaces/apostrophes, no setup, writes, or SSH invocations.
import="$tmp/imported profile's"
mkdir -p "$import/grants"
printf "HOST='local'\nHOST_BIN='/bin/echo'\n" >"$import/config"
printf '# untouched ssh config\n' >"$import/ssh_config"
printf 'ssh-agent\t\t\n' >"$import/grants/demo"
cp "$import/config" "$tmp/config.before"; cp "$import/ssh_config" "$tmp/ssh.before"
lines=$(wc -l <"$SSH_LOG")
"$CLI" host add beta --config-dir "$import" >/dev/null
[ "$(wc -l <"$SSH_LOG")" -eq "$lines" ]
cmp "$import/config" "$tmp/config.before"; cmp "$import/ssh_config" "$tmp/ssh.before"
"$CLI" --host beta shapes | grep -q '^shapes$'
"$CLI" host use alpha
cp "$BOXERY_HOME/default-host" "$tmp/default.before"
if "$CLI" host use unknown >/dev/null 2>&1; then exit 1; fi
cmp "$BOXERY_HOME/default-host" "$tmp/default.before"
"$CLI" ls | grep -q '^demo '
# Plain ls lists every host under one header, a section each, the default first; --host NAME ls just
# that one, unheaded. A host that fails (beta's host is /bin/echo: no JSON) is reported, the others are
# still listed, and ls exits 1.
other="$tmp/other profile"
mkdir -p "$other"
printf '#!/bin/sh\necho '"'"'[{"name":"web","state":"shut off"}]'"'"'\n' >"$tmp/other-host"; chmod +x "$tmp/other-host"
printf "HOST='local'\nHOST_BIN='%s'\n" "$tmp/other-host" >"$other/config"
printf '# untouched ssh config\n' >"$other/ssh_config"
"$CLI" host add gamma --config-dir "$other" >/dev/null
if "$CLI" ls >"$tmp/ls.out" 2>"$tmp/ls.err"; then echo 'ls succeeded with a failing host' >&2; exit 1; fi
[ "$(sed -n 1p "$tmp/ls.out")" = 'NAME  STATE     SSH  DISK  SHAPE  KIND     STATUS' ]
[ "$(sed -n 2p "$tmp/ls.out")" = 'alpha (default): on user@fake' ]
[ "$(grep -c '^NAME ' "$tmp/ls.out")" -eq 1 ]
grep -q '^demo  running ' "$tmp/ls.out"; grep -q '^web   shut off ' "$tmp/ls.out"
grep -A1 '^beta: on this machine$' "$tmp/ls.out" | grep -q '^(ls failed: see below)$'
[ "$(grep -n '^gamma' "$tmp/ls.out" | cut -d: -f1)" -gt "$(grep -n '^beta' "$tmp/ls.out" | cut -d: -f1)" ]
grep -q "^boxery: beta: host returned no JSON for 'ls --json'" "$tmp/ls.err"
"$CLI" ls --running >"$tmp/ls.out" 2>/dev/null || true # (beta still fails)
grep -A1 '^gamma' "$tmp/ls.out" | grep -q '^(no running VMs)$'
if grep -q '^web ' "$tmp/ls.out"; then echo 'ls --running listed a stopped VM' >&2; exit 1; fi
if "$CLI" --host alpha ls | grep -q '^alpha'; then echo 'headed a single-host ls' >&2; exit 1; fi
"$CLI" host rm gamma >/dev/null
"$CLI" host ls | grep -q "alpha.*\*"
if "$CLI" host rm alpha >/dev/null 2>&1; then echo 'removed selected default' >&2; exit 1; fi
"$CLI" host use beta
"$CLI" host rm alpha >/dev/null
[ -f "$BOXERY_HOME/profiles/alpha/config" ]
if "$CLI" host add alpha user@fake >/dev/null 2>&1; then echo 'overwrote forgotten profile data' >&2; exit 1; fi
[ -f "$import/grants/demo" ]
# There is no built-in root profile to fall back to.
if "$CLI" host use legacy >/dev/null 2>&1; then echo 'selected an unregistered legacy host' >&2; exit 1; fi
[ "$(cat "$BOXERY_HOME/default-host")" = beta ]
for name in '../escape' '-oProxyCommand=x' 'bad name' 'a/b' 'Upper' ''; do
 if "$CLI" --host "$name" ls >/dev/null 2>&1; then echo "accepted invalid host $name" >&2; exit 1; fi
done
if "$CLI" --host unknown ls >/dev/null 2>&1; then exit 1; fi
if "$CLI" host add beta --config-dir "$import" >/dev/null 2>&1; then exit 1; fi
if "$CLI" host add failed local --host-bin /no/such/bin >/dev/null 2>&1; then exit 1; fi
[ ! -e "$BOXERY_HOME/host-registry/failed" ]; [ ! -e "$BOXERY_HOME/profiles/failed" ]; [ "$(cat "$BOXERY_HOME/default-host")" = beta ]
# setup names the host after its destination, or fails asking for --name.
if "$CLI" setup 'you@-bad' >/dev/null 2>&1; then echo 'derived an invalid host name' >&2; exit 1; fi
"$CLI" setup 'you@9bad' 2>&1 | grep -q 'pass --name NAME'
if "$CLI" --host beta setup local >/dev/null 2>&1; then echo 'setup accepted --host' >&2; exit 1; fi
# Two managed local profiles: separate grants, SSH configs and control sockets, even for demo.
# Include quotes/spaces in the root path to exercise SSH config value quoting.
export BOXERY_HOME="$tmp/root's space"
localbin="$tmp/local it's \$(touch NOT_EXECUTED) \`echo no\` % host"
cp "$REMOTE_HOME/$rel" "$localbin"
"$CLI" host add quoted local --host-bin "$localbin" >/dev/null
"$CLI" --host quoted ls | grep -q '^demo '
proxy=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/quoted/ssh_config" -G demo.boxery | sed -n 's/^proxycommand //p')
proxy=${proxy//%%/PERCENT_PLACEHOLDER}; proxy=${proxy//%h/demo.boxery}; proxy=${proxy//%p/22}; proxy=${proxy//PERCENT_PLACEHOLDER/%}
sh -c "$proxy" | grep -q '^CONNECTED:demo.boxery:22$'
[ ! -e NOT_EXECUTED ]
"$CLI" host add one local --host-bin /bin/echo >/dev/null
"$CLI" host add two local --host-bin /bin/echo >/dev/null
echo 'GRANT_CONFIRM=off' >>"$BOXERY_HOME/profiles/one/config"
"$CLI" --host one grant demo ssh-agent >/dev/null
[ -f "$BOXERY_HOME/profiles/one/grants/demo" ]; [ ! -f "$BOXERY_HOME/profiles/two/grants/demo" ]
one=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/one/ssh_config" -G demo.boxery)
two=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/two/ssh_config" -G demo.boxery)
printf '%s\n' "$one" | grep -q '^forwardagent yes$'
printf '%s\n' "$two" | grep -q '^forwardagent no$'
printf '%s\n' "$one" | grep -Fq "controlpath $BOXERY_HOME/profiles/one/cm-demo.boxery"
printf '%s\n' "$two" | grep -Fq "controlpath $BOXERY_HOME/profiles/two/cm-demo.boxery"
"$CLI" host rm one >/dev/null
[ -f "$BOXERY_HOME/profiles/one/grants/demo" ]
# Upstream pool leases and HTTP grants must stay profile-local, even with duplicate VM/lease IDs.
leasebin="$tmp/lease-host"
export EDGE_LOG="$tmp/edge.log"
cat >"$leasebin" <<'STUB'
#!/usr/bin/env bash
case $1 in
help|release) : ;;
add-key) cat >/dev/null ;;
acquire) cat >/dev/null; printf 'demo l-0123456789abcdef0123456789abcdef %s\n' "$(( $(date +%s) + 600 ))" ;;
renew) printf '%s %s\n' "$2" "$(( $(date +%s) + 600 ))" ;;
edge-set) cat >>"$EDGE_LOG"; [ -z "${EDGE_ARGS:-}" ] || echo "$*" >>"$EDGE_ARGS" ;;
esac
STUB
chmod +x "$leasebin"
"$CLI" host add lease-one local --host-bin "$leasebin" >/dev/null
"$CLI" host add lease-two local --host-bin "$leasebin" >/dev/null
for profile in lease-one lease-two; do echo 'GRANT_CONFIRM=off' >>"$BOXERY_HOME/profiles/$profile/config"; done
id=l-0123456789abcdef0123456789abcdef
[ "$("$CLI" --host lease-one acquire --ttl 600 2>/dev/null)" = "demo $id" ]
p1="$BOXERY_HOME/profiles/lease-one"; p2="$BOXERY_HOME/profiles/lease-two"
[ -f "$p1/leases/$id.key" ]; [ ! -e "$p2/leases" ]
[ "$("$CLI" --host lease-two leases)" = "(no leases)" ]
if "$CLI" --host lease-two renew demo >/dev/null 2>&1; then echo 'renew crossed hosts' >&2; exit 1; fi
if "$CLI" --host lease-two release "$id" >/dev/null 2>&1; then echo 'release crossed hosts' >&2; exit 1; fi
"$CLI" --host lease-one renew demo --ttl 900 >/dev/null
[ "$("$CLI" --host lease-two acquire --ttl 600 2>/dev/null)" = "demo $id" ]
if cmp -s "$p1/leases/$id.key" "$p2/leases/$id.key"; then echo 'lease keys shared across profiles' >&2; exit 1; fi
"$REAL_SSH" -F "$p1/ssh_config" -G demo.boxery | grep -Fq "identityfile $p1/leases/$id.key"
"$REAL_SSH" -F "$p2/ssh_config" -G demo.boxery | grep -Fq "identityfile $p2/leases/$id.key"
"$CLI" --host lease-one grant demo http:api.example.com --cmd 'printf fixture-token' --readonly >/dev/null
[ -f "$p1/grants/.demo.edge" ]; [ ! -e "$p2/grants/.demo.edge" ]
grep -q '"readonly":true' "$EDGE_LOG"
"$CLI" --host lease-two grant demo http:api.example.com --cmd 'printf other-fixture-token' >/dev/null
# llm grants on a leased VM: sent with the lease id, even without any http grant.
: >"$EDGE_LOG"; export EDGE_ARGS="$tmp/edge.args"
"$CLI" --host lease-one revoke demo http:api.example.com >/dev/null
"$CLI" --host lease-one grant demo llm:ollama >/dev/null
tail -1 "$EDGE_LOG" | grep -q '"llm":\["ollama"\]'
grep -qx "edge-set demo --lease $id" "$EDGE_ARGS"
"$CLI" --host lease-one release demo >/dev/null
[ ! -e "$p1/leases/$id.key" ]; [ ! -e "$p1/grants/demo" ]; [ ! -e "$p1/grants/.demo.edge" ]
[ -f "$p2/leases/$id.key" ]; [ -f "$p2/grants/demo" ]; [ -f "$p2/grants/.demo.edge" ]
"$CLI" --host lease-two leases | grep -q "$id"
"$CLI" --host lease-two release "$id" >/dev/null
[ ! -e "$p2/leases/$id.key" ]
# Copy setup's exact Include recommendation into an isolated SSH config, never ~/.ssh/config.
for suffix in "root's include space" 'root "quoted" \slash [*?] include'; do
	export BOXERY_HOME="$tmp/$suffix"
	output=$("$CLI" setup local --host-bin "$localbin")
	recommendation=$(printf '%s\n' "$output" | sed -n 's/^    \(Include .*\)$/\1/p')
	[ -n "$recommendation" ]
	printf '%s\n' "$recommendation" >"$tmp/include-test-config"
	resolved=$("$REAL_SSH" -F "$tmp/include-test-config" -G demo.boxery)
	printf '%s\n' "$resolved" | grep -q '^user agent$'
	direct=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/local/ssh_config" -G demo.boxery)
	[ "$resolved" = "$direct" ]
	# Further hosts must not encourage ambiguous global *.boxery Includes.
	output=$("$CLI" host add named local --host-bin "$localbin")
	if printf '%s\n' "$output" | grep -q '^    Include '; then echo 'a non-default host recommended a global Include' >&2; exit 1; fi
	# Re-running setup reconfigures the registered host in place.
	"$CLI" setup local --host-bin "$localbin" >/dev/null
	[ "$(cat "$BOXERY_HOME/host-registry/local")" = "$BOXERY_HOME/profiles/local" ]
done
# OpenSSH 9.6 and newer macOS clients differ on percent expansion in Include. Do not print
# a misleading global Include for such paths; explicit -F still reads the exact config.
export BOXERY_HOME="$tmp/percent % profile"
output=$("$CLI" setup local --host-bin "$localbin")
if printf '%s\n' "$output" | grep -q '^    Include '; then echo 'nonportable percent Include recommended' >&2; exit 1; fi
printf '%s\n' "$output" | grep -q 'instead of a global Include'
"$REAL_SSH" -F "$BOXERY_HOME/profiles/local/ssh_config" -G demo.boxery | grep -q '^user agent$'
# host ls says where each host runs: destination, the backend setup recorded, and which names share a profile.
export BOXERY_HOME="$tmp/listing"
backendbin="$tmp/backend-host"
printf '#!/usr/bin/env bash\ncase $1 in add-key) cat >/dev/null ;; backend) echo lima ;; esac\n' >"$backendbin"
chmod +x "$backendbin"
out=$("$CLI" setup local --host-bin "$backendbin") # not piped: grep -q closing early would kill setup mid-registration
printf '%s\n' "$out" | grep -q '^==> backend: lima$'
[ "$(cat "$BOXERY_HOME/profiles/local/backend")" = lima ]
"$CLI" host add mirror --config-dir "$BOXERY_HOME/profiles/local" >/dev/null # records the canonical path (/private/var on macOS)
real=$(cd "$BOXERY_HOME/profiles/local" && pwd -P)
"$CLI" host add far user@fake --host-bin "~/$rel" >/dev/null # predates `backend`: nothing recorded
[ ! -e "$BOXERY_HOME/profiles/far/backend" ]
"$CLI" host use mirror
"$CLI" host ls | grep -q "^local		$BOXERY_HOME/profiles/local	local	lima	mirror$"
"$CLI" host ls | grep -q "^mirror	\*	$real	local	lima	local$"
"$CLI" host ls | grep -q "^far		$BOXERY_HOME/profiles/far	user@fake	-	-$"
"$CLI" host ls --json | jq -e --arg d "$BOXERY_HOME" --arg r "$real" '. == [
	{name:"far",dir:($d + "/profiles/far"),default:false,destination:"user@fake",backend:null,same_as:[]},
	{name:"local",dir:($d + "/profiles/local"),default:false,destination:"local",backend:"lima",same_as:["mirror"]},
	{name:"mirror",dir:$r,default:true,destination:"local",backend:"lima",same_as:["local"]}]' >/dev/null
# `backend` refreshes the record, and clears it rather than keep a stale one when the host can't say.
[ "$("$CLI" --host local backend)" = lima ]
printf 'stale\n' >"$BOXERY_HOME/profiles/far/backend"
if "$CLI" --host far backend >/dev/null 2>&1; then echo 'backend invented a value' >&2; exit 1; fi
[ ! -e "$BOXERY_HOME/profiles/far/backend" ]
# host add --backend: creates the host-side profile, then every call (and the ProxyCommand) names it.
export BOXERY_HOME="$tmp/profiles-root" PROFILE_LOG="$tmp/profile.log"
mkdir -p "$REMOTE_HOME/bin"
cat >"$REMOTE_HOME/bin/profiled" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$PROFILE_LOG"
p=""; if [ "$1" = --profile ]; then p=$2; shift 2; fi
if [ -n "$p" ] && [ ! -f "$HOME/made-$p" ] && [ "$1" != init ]; then echo "no profile '$p'" >&2; exit 1; fi
case $1 in
init) [ "${3:-}" != broken ] || { echo "backend check failed" >&2; exit 1; }; : >"$HOME/made-$p" ;;
add-key) cat >/dev/null ;;
ls) echo "[{\"name\":\"demo\",\"state\":\"running\",\"shape\":\"${p:-default}\"}]" ;; # the profile, as its shape
connect) printf 'CONNECTED:%s:%s:%s\n' "${p:-default}" "$2" "$3" ;;
esac
STUB
chmod +x "$REMOTE_HOME/bin/profiled"
out=$("$CLI" host add gamma user@fake --host-bin '~/bin/profiled' --backend exe)
grep -qx -- '--profile gamma init --backend exe' "$PROFILE_LOG"
grep -qx -- '--profile gamma add-key' "$PROFILE_LOG"
printf '%s\n' "$out" | grep -q 'boxery --host gamma build-base'
grep -qx "HOST_PROFILE='gamma'" "$BOXERY_HOME/profiles/gamma/config"
"$CLI" --host gamma ls | grep -q '^demo .* gamma '
proxy=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/gamma/ssh_config" -G demo.boxery | sed -n 's/^proxycommand //p')
proxy=${proxy//%h/demo.boxery}; proxy=${proxy//%p/22}
sh -c "$proxy" | grep -q '^CONNECTED:gamma:demo.boxery:22$'
# --profile reuses one that exists (no init); a missing one or a failed init registers nothing.
: >"$PROFILE_LOG"
"$CLI" host add gamma2 user@fake --host-bin '~/bin/profiled' --profile gamma >/dev/null
if grep -q init "$PROFILE_LOG"; then echo '--profile ran init' >&2; exit 1; fi
"$CLI" --host gamma2 ls | grep -q '^demo .* gamma '
for args in "--profile nosuch" "--backend broken" "--backend ../x" "--profile Bad"; do
	# shellcheck disable=SC2086 # word-split on purpose
	if "$CLI" host add delta user@fake --host-bin '~/bin/profiled' $args >/dev/null 2>&1; then echo "host add $args succeeded" >&2; exit 1; fi
	[ ! -e "$BOXERY_HOME/host-registry/delta" ]; [ ! -e "$BOXERY_HOME/profiles/delta" ]
done
# setup is host add with a derived name, so --backend names the host-side profile after it.
: >"$PROFILE_LOG"
"$CLI" setup user@fake --name epsilon --host-bin '~/bin/profiled' --backend exe >/dev/null
grep -qx -- '--profile epsilon init --backend exe' "$PROFILE_LOG"
# Default key (#220): ~/.ssh/id_{ed25519,ecdsa,rsa}.pub, else the key a registered host uses, else another
# ~/.ssh/id_*.pub. It's found before the host's slower checks, and the error says what was tried.
export BOXERY_HOME="$tmp/keys" HOME="$tmp/keys-home"
mkdir -p "$HOME/.ssh" "$HOME/kid" "$HOME/kid2"
keylog="$tmp/key-host.log"; keybin="$tmp/key-host"
printf '#!/usr/bin/env bash\necho "$*" >>"%s"\n[ "$1" != --profile ] || shift 2\ncase $1 in help) echo capabilities ;; add-key) cat >"%s.pub" ;; backend) [ -z "${KEY_BACKEND:-}" ] || echo "$KEY_BACKEND" ;; esac\n' "$keylog" "$keylog" >"$keybin"; chmod +x "$keybin"
if out=$("$CLI" host add k0 local --host-bin "$keybin" 2>&1); then echo 'host add without any key succeeded' >&2; exit 1; fi
printf '%s\n' "$out" | grep -qF 'no ssh public key found: tried ~/.ssh/id_ed25519.pub, id_ecdsa.pub and id_rsa.pub, the keys your registered hosts use, and other ~/.ssh/id_*.pub with their private key. Pass --key PATH.pub'
if grep -q capabilities "$keylog"; then echo 'checked capabilities before finding a key' >&2; exit 1; fi
[ ! -e "$BOXERY_HOME/host-registry/k0" ]
# A new host-side profile: no init either before the key is found.
if "$CLI" host add k0 local --host-bin "$keybin" --backend exe >/dev/null 2>&1; then echo 'host add --backend without any key succeeded' >&2; exit 1; fi
if grep -q init "$keylog"; then echo 'ran init before finding a key' >&2; exit 1; fi
if out=$("$CLI" host add k0 local --host-bin "$keybin" --key "$HOME/none.pub" 2>&1); then echo 'a missing --key was accepted' >&2; exit 1; fi
printf '%s\n' "$out" | grep -qF "no such ssh public key: $HOME/none.pub"
# OpenShell's gateway authenticates: no key needed.
out=$(KEY_BACKEND=openshell "$CLI" host add shell local --host-bin "$keybin")
printf '%s\n' "$out" | grep -q 'no guest SSH key registration needed'
grep -qx "IDENTITY=''" "$BOXERY_HOME/profiles/shell/config"
rm -rf "$BOXERY_HOME" # (start again with no hosts)
# The key a registered host already uses (IDENTITY as ssh_config reads it: ~/ is this machine's home), the
# default host's first; only with its private half.
printf 'ssh-ed25519 AAAAregistered\n' >"$HOME/kid/id_ed25519.pub"; : >"$HOME/kid/id_ed25519"
printf 'ssh-ed25519 AAAAsecond\n' >"$HOME/kid2/id_ed25519.pub"; : >"$HOME/kid2/id_ed25519"
for n in old other; do
	mkdir -p "$tmp/keys-$n"; printf '#\n' >"$tmp/keys-$n/ssh_config"
done
printf "HOST='local'\nHOST_BIN='/bin/echo'\nIDENTITY='~/kid/id_ed25519'\n" >"$tmp/keys-old/config"
printf "HOST='local'\nHOST_BIN='/bin/echo'\nIDENTITY='~/kid2/id_ed25519'\n" >"$tmp/keys-other/config"
"$CLI" host add old --config-dir "$tmp/keys-old" >/dev/null # the default
"$CLI" host add aaa --config-dir "$tmp/keys-other" >/dev/null
out=$("$CLI" host add k1 local --host-bin "$keybin")
printf '%s\n' "$out" | grep -qF "no --key given: using $HOME/kid/id_ed25519.pub"
grep -q AAAAregistered "$keylog.pub"; grep -qF "IDENTITY='$HOME/kid/id_ed25519'" "$BOXERY_HOME/profiles/k1/config"
grep -q 'capabilities --check' "$keylog"
"$CLI" host use aaa
out=$("$CLI" host add k1b local --host-bin "$keybin")
printf '%s\n' "$out" | grep -qF "registering $HOME/kid2/id_ed25519.pub"
# With no registered host to borrow from, another ~/.ssh/id_*.pub (what the help promises): not one without
# its private key (someone else's), a certificate or a DSA key.
export BOXERY_HOME="$tmp/keys2"
printf 'ssh-ed25519 AAAAbob\n' >"$HOME/.ssh/id_bob.pub"
printf 'ssh-dss AAAAdsa\n' >"$HOME/.ssh/id_dsa.pub"; : >"$HOME/.ssh/id_dsa"
printf 'ssh-ed25519-cert-v01@openssh.com AAAAcert\n' >"$HOME/.ssh/id_ed25519_github-cert.pub"
printf 'ssh-ed25519 AAAAgithub\n' >"$HOME/.ssh/id_ed25519_github.pub"; : >"$HOME/.ssh/id_ed25519_github"
out=$("$CLI" host add k2 local --host-bin "$keybin")
printf '%s\n' "$out" | grep -qF "registering $HOME/.ssh/id_ed25519_github.pub"
grep -q AAAAgithub "$keylog.pub"
# The usual names come first; re-running setup keeps the key the host's VMs already trust.
printf 'ssh-ed25519 AAAAusual\n' >"$HOME/.ssh/id_rsa.pub"
out=$("$CLI" host add k3 local --host-bin "$keybin")
printf '%s\n' "$out" | grep -qF "registering $HOME/.ssh/id_rsa.pub"
if printf '%s\n' "$out" | grep -q 'no --key given'; then echo 'noted a usual key' >&2; exit 1; fi
out=$("$CLI" setup local --name k2 --host-bin "$keybin")
printf '%s\n' "$out" | grep -qF "registering $HOME/.ssh/id_ed25519_github.pub"
# Two names for one host-side profile are the same host (#221), though host add --profile P makes a profile
# directory of its own: same destination and host profile, here also through a wrapper from before host
# profiles (BOXERY_CONF=…/boxery-exe). ls lists that host once.
export BOXERY_HOME="$tmp/same"
samebin="$tmp/same-host"
printf '#!/usr/bin/env bash\n[ "$1" != --profile ] || shift 2\ncase $1 in ls) echo '"'"'[{"name":"vm1","state":"running"}]'"'"' ;; esac\n' >"$samebin"; chmod +x "$samebin"
printf '#!/usr/bin/env bash\nexport BOXERY_CONF="$HOME/.config/boxery-exe"\nexec "%s" "$@"\n' "$samebin" >"$tmp/boxery-host-exe"; chmod +x "$tmp/boxery-host-exe"
mk() { mkdir -p "$tmp/same-$1"; printf '#\n' >"$tmp/same-$1/ssh_config"; printf '%s\n' "$2" >"$tmp/same-$1/config"; [ -z "${3:-}" ] || printf '%s\n' "$3" >"$tmp/same-$1/backend"; "$CLI" host add "$1" --config-dir "$tmp/same-$1" >/dev/null; }
mk exe "HOST='local'
HOST_BIN='$tmp/boxery-host-exe'" exe
mk lab2 "HOST='local'
HOST_BIN='$samebin'
HOST_PROFILE='exe'" exe
mk lab3 "HOST='local'
HOST_BIN='$samebin'
HOST_PROFILE='exe'"
mk other "HOST='local'
HOST_BIN='$samebin'
HOST_PROFILE='iso'"
# Wrappers count only when they say it plainly: --profile P too; not a BOXERY_CONF of its own (other state),
# a profile in a comment, or one computed at run time.
wrap() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$tmp/wrap-$1"; chmod +x "$tmp/wrap-$1"; mk "$1" "HOST='local'
HOST_BIN='$tmp/wrap-$1'"; }
wrap flag "exec \"$samebin\" --profile exe \"\$@\""
wrap elsewhere "export BOXERY_CONF=/srv/scratch/boxery-exe; exec \"$samebin\" \"\$@\""
wrap computed "P=lab # like: boxery-host --profile exe
exec \"$samebin\" --profile \"\$P\" \"\$@\""
mkdir -p "$tmp/same-lab2/grants"; printf 'ssh-agent\t\t\n' >"$tmp/same-lab2/grants/vm1" # lab2's own grant
"$CLI" host ls --json | jq -e '[.[] | {(.name): .same_as}] | add == {computed: [], elsewhere: [], exe: ["flag", "lab2", "lab3"], flag: ["exe", "lab2", "lab3"],
	lab2: ["exe", "flag", "lab3"], lab3: ["exe", "flag", "lab2"], other: []}' >/dev/null
out=$("$CLI" ls)
[ "$(printf '%s\n' "$out" | grep -c '^vm1 ')" -eq 4 ] # exe (for flag, lab2 and lab3 too), other, elsewhere, computed
printf '%s\n' "$out" | grep -q '^exe (default; also flag, lab2, lab3): exe on this machine$'
printf '%s\n' "$out" | grep -A1 '^exe (default' | grep -q '^vm1 .* grants (lab2) ssh-agent$'
if printf '%s\n' "$out" | grep -q '^\(lab[23]\|flag\)'; then echo 'ls listed a second name for one host' >&2; exit 1; fi
# A wrapper on another machine can't be read: matched by directory only.
mk far "HOST='user@fake'
HOST_BIN='~/bin/boxery-host-exe'"
mk farp "HOST='user@fake'
HOST_PROFILE='exe'"
"$CLI" host ls --json | jq -e 'map(select(.name == "far" or .name == "farp") | .same_as) == [[], []]' >/dev/null
echo 'PASS: named registry, first-host default, setup naming, host listing, host-side profiles, import, safe removal, isolation, failures, remote quoting, default keys and same hosts'
