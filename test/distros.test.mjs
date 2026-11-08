import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { parseNewArgs, createVm } from "../host/vms.mjs";
import { resources } from "../host/boxery-operations.mjs";
import { cloudConfig } from "../host/seed.mjs";

const root = path.resolve(import.meta.dirname, "..");
const shell = (script, env = {}) => execFileSync("bash", ["-euo", "pipefail", "-c", script, "test", root], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("distribution selection is validated, source images retain their distribution", async () => {
	assert.equal(parseNewArgs(["vm", "--headless", "--distro", "arch"]).distro, "arch");
	assert.throws(() => parseNewArgs(["vm", "--distro", "unknown"]), /ubuntu or arch/);
	assert.throws(() => parseNewArgs(["vm", "--distro"]), /ubuntu or arch/);
	assert.deepEqual(resources("new", ["vm", "--headless", "--distro", "arch"]), ["vm"]);
	const base = { name: "vm", shape: "", cpus: "", mem: "", disk: "", from: "", headless: true, distro: "arch" };
	for (const backend of ["libvirt", "cloud-hypervisor", "exe", "boat", "openshell", "fake"]) {
		await assert.rejects(createVm(/** @type {any} */ ({ backend }), base), /requires Lima/);
	}
	await assert.rejects(createVm(/** @type {any} */ ({ backend: "lima" }), { ...base, headless: false }), /requires Lima/);
	await assert.rejects(createVm(/** @type {any} */ ({ backend: "lima" }), { ...base, from: "src@one" }), /images keep/);
	await assert.rejects(createVm(/** @type {any} */ ({ backend: "lima" }), { ...base, layers: ["github-runner"] }), /no optional/);
});

test("Lima reuses the native distro image definition without enabling host mounts or agent forwarding", () => {
	const script = 'ROOT=$1; die() { echo "$*" >&2; exit 1; }; source "$ROOT/host/backends/lima.sh"; lima_template vm 2 2048 20 archlinux';
	const yaml = shell(script, { BOXERY_LIMA_ARCH: "x86_64" });
	assert.match(yaml, /template:_images\/archlinux/);
	assert.match(yaml, /mounts: \[\]/);
	assert.match(yaml, /loadDotSSHPubKeys: false/);
	assert.match(yaml, /forwardAgent: false/);
	assert.throws(() => shell(script, { BOXERY_LIMA_ARCH: "aarch64" }), /Command failed/);
	assert.match(shell(script.replace("20 archlinux", "20"), { BOXERY_LIMA_ARCH: "aarch64" }), /template:_images\/ubuntu-24.04/);
});

test("fresh pinned keys reload Arch's sshd unit as well as Ubuntu's ssh unit", () => {
	const seed = cloudConfig({ name: "arch", keys: [], upstream: "TCP:host:8088", cred: "dummy", hostKey: { private: "private", public: "ssh-ed25519 dummy" } });
	assert.match(seed, /try-reload-or-restart ssh\.service \|\| systemctl try-reload-or-restart sshd\.service/);
});

test("Arch layer packages use pacman full upgrades and native package names", () => {
	const out = shell(`source "$1/image/layers/lib.sh"
		pacman() { if [ "$1" = -Q ]; then return 1; fi; printf '%s\\n' "$*"; }
		pkgs fd-find build-essential python3 python3-venv socat
		upgrade_system`);
	assert.equal(out, "-Syu --needed --noconfirm fd base-devel python socat\n-Syu --noconfirm\n");
});
