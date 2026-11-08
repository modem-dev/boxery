import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildBase } from "../host/setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("concurrent base builds get private user-data and cleanup on success or failure", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-build-inputs-"));
	const files = []; let layer = 0;
	const rt = /** @type {any} */ ({ root, cache: dir, vms: {
		layerFiles: async () => [`  # private-layer-${++layer}`],
		call: async (fn, _args, opts) => {
			if (fn !== "backend_build_base") return;
			const file = opts.extraEnv.BASE_USERDATA;
			files.push(file);
			const before = readFileSync(file, "utf8");
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(readFileSync(file, "utf8"), before);
		},
	} });
	try {
		await Promise.all([buildBase(rt), buildBase(rt)]);
		assert.equal(new Set(files).size, 2);
		assert.ok(files.every((f) => !existsSync(f)));
		rt.vms.call = async (fn, _args, opts) => { if (fn === "backend_build_base") { files.push(opts.extraEnv.BASE_USERDATA); throw new Error("build failed"); } };
		await assert.rejects(buildBase(rt), /build failed/);
		assert.ok(files.every((f) => !existsSync(f)));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("libvirt builds private immutable volumes, publishes only success and retains old backing disks", { skip: process.platform !== "linux" }, () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-base-versions-"));
	try {
		const out = execFileSync("bash", ["-euo", "pipefail", "-c", `
			ROOT=$1 CONF=$2/conf CACHE=$2/cache BOXERY_CONF=$2/conf
			mkdir -p "$CONF" "$CACHE" "$2/vols/boxery-base.qcow2"
			printf legacy >"$2/vols/boxery-base.qcow2/content"
			die() { echo "$*" >&2; exit 1; }; log() { :; }
			source "$ROOT/host/backends/libvirt.sh"
			VOLS=$2/vols; CALLS=$2/calls
			virsh() {
				printf '%s\\n' "$*" >>"$CALLS"
				case $1 in
				vol-list) find "$VOLS" -mindepth 1 -maxdepth 1 -printf '%f\\n' ;;
				vol-create-as) mkdir "$VOLS/$3" ;;
				vol-upload) printf built >"$VOLS/$4/content" ;;
				vol-download) if [[ \${FAIL_BUILD:-0} == 1 ]]; then echo FAILED >"$5"; else echo BOXERY_BUILD_OK >"$5"; fi ;;
				vol-delete) rm -rf "$VOLS/$4" ;;
				domstate) echo 'shut off' ;;
				esac
			}
			cloud_image() { echo source >"$CACHE/noble.img"; }
			isolation_ensure_filter() { :; }; net_arg() { echo network=default; }
			cloud-localds() { echo seed >"$1"; }; virt-install() { printf '%s\\n' "$*" >>"$CALLS"; }
			dependents() { echo 100; } # existing VMs must no longer block a new version
			BASE_USERDATA=$2/userdata; echo userdata >"$BASE_USERDATA"
			[[ $BASE_VOL == boxery-base.qcow2 ]]
			backend_build_base
			first=$(cat "$BASE_POINTER"); [[ $first == boxery-base.v-*.qcow2 ]]
			[[ $(cat "$VOLS/boxery-base.qcow2/content") == legacy ]]
			base_resolve; [[ $BASE_VOL == "$first" && $BOXERY_BASE_VOL == boxery-base.qcow2 ]]
			backend_build_base
			second=$(cat "$BASE_POINTER"); [[ $second != "$first" && -d $VOLS/$first && -d $VOLS/$second ]]
			if (FAIL_BUILD=1 backend_build_base) >/dev/null 2>&1; then exit 10; fi
			[[ $(cat "$BASE_POINTER") == "$second" ]]
			[[ $(cat "$VOLS/boxery-base.qcow2/content") == legacy ]]
			# The immutable upload path refuses existing targets instead of deleting/replacing them.
			if upload_new_vol "$CACHE/noble.img" "$first" qcow2 2>/dev/null; then exit 11; fi
			! grep -q "vol-delete --pool $POOL $first" "$CALLS"
			# Concurrent builders publish whole, independent versions; both remain usable.
			backend_build_base & a=$!; backend_build_base & b=$!; wait "$a"; wait "$b"
			latest=$(cat "$BASE_POINTER"); [[ -f $VOLS/$latest/content ]]
			[[ $(find "$VOLS" -maxdepth 1 -type d -name 'boxery-base.v-*' | wc -l) == 5 ]]
			pointer=$BASE_POINTER
			BOXERY_POOL=another; source "$ROOT/host/backends/libvirt.sh"
			[[ $BASE_POINTER != "$pointer" && $BASE_VOL == boxery-base.qcow2 ]]
			printf 'not/a/volume\\n' >"$BASE_POINTER"
			if (base_resolve) >/dev/null 2>&1; then exit 12; fi
			echo 'version publication, concurrency, failure and legacy safety passed'
		`, "test", root, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		assert.match(out, /legacy safety passed/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
