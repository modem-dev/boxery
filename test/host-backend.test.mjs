// host/backend.sh + backend.mjs (the only way Node reaches a hypervisor backend), guest.mjs and
// config.mjs, against the fake backend and a stub ssh. No SQLite: runs on every supported Node.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BackendError, createBackend } from "../host/backend.mjs";
import { HOST_ENV, loadConfig } from "../host/config.mjs";
import { createGuest } from "../host/guest.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
let dir, env;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-backend-"));
	mkdirSync(path.join(dir, "vms")); mkdirSync(path.join(dir, "conf")); mkdirSync(path.join(dir, "bin"));
	env = { ...process.env, BOXERY_BACKEND: "fake", BOXERY_FAKE_DIR: path.join(dir, "vms"), BOXERY_CONF: path.join(dir, "conf"), PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeVm(name, { state = "running", port = 22000, size = "2 2048 10" } = {}) {
	const d = path.join(dir, "vms", name);
	mkdirSync(d, { recursive: true });
	writeFileSync(path.join(d, "state"), state); writeFileSync(path.join(d, "port"), String(port)); writeFileSync(path.join(d, "size"), size);
}
function stub(name, script) {
	writeFileSync(path.join(dir, "bin", name), `#!/usr/bin/env bash\n${script}\n`);
	chmodSync(path.join(dir, "bin", name), 0o755);
}

test("backend.sh reads host.env through host/host-env.list, as config.mjs does", () => {
	assert.ok(HOST_ENV.length > 30 && HOST_ENV.includes("BOXERY_BACKEND") && HOST_ENV.includes("BOXERY_BOAT_API"));
	assert.ok(readFileSync(path.join(ROOT, "host/host-env.list"), "utf8").endsWith("\n"), "the list ends in a newline");
	const sh = readFileSync(path.join(ROOT, "host/backend.sh"), "utf8");
	assert.match(sh, /host\/host-env\.list/);
	assert.doesNotMatch(sh, /BOXERY_BOAT_API|LIBVIRT_DEFAULT_URI/, "no second copy of the list");
	// Every listed name reaches a backend function from host.env; anything else doesn't.
	const conf = path.join(dir, "envlist");
	mkdirSync(conf, { recursive: true });
	writeFileSync(path.join(conf, "host.env"), [...HOST_ENV.filter((k) => k !== "BOXERY_BACKEND").map((k) => `${k}=v-${k}`), "BOXERY_BACKEND=fake", "PATH=/evil", "NOT_LISTED=x", "BAD NAME=x", "$(touch pwned)=x"].join("\n"));
	const out = execFileSync("bash", [path.join(ROOT, "host/backend.sh"), "__functions"], { env: { HOME: dir, PATH: process.env.PATH, BOXERY_CONF: conf, BOXERY_FAKE_DIR: path.join(dir, "envlist-vms") }, encoding: "utf8" });
	assert.match(out, /backend_list/, "the fake backend loaded (BOXERY_BACKEND from host.env)");
	// What a backend function sees: a stub backend that prints its environment.
	const stubRoot = path.join(dir, "envlist-root");
	mkdirSync(path.join(stubRoot, "host", "backends"), { recursive: true });
	for (const f of ["backend.sh", "host-env.list"]) writeFileSync(path.join(stubRoot, "host", f), readFileSync(path.join(ROOT, "host", f)));
	writeFileSync(path.join(stubRoot, "host", "backends", "envdump.sh"), "backend_list() { env; }\n");
	writeFileSync(path.join(conf, "host.env"), readFileSync(path.join(conf, "host.env"), "utf8").replace("BOXERY_BACKEND=fake", "BOXERY_BACKEND=envdump"));
	const env = execFileSync("bash", [path.join(stubRoot, "host", "backend.sh"), "backend_list"], { env: { HOME: dir, PATH: process.env.PATH, BOXERY_CONF: conf }, encoding: "utf8", cwd: dir });
	for (const k of HOST_ENV.filter((k) => k !== "BOXERY_BACKEND")) assert.match(env, new RegExp(`^${k}=v-${k}$`, "m"), k);
	assert.doesNotMatch(env, /^NOT_LISTED=/m);
	assert.match(env, new RegExp(`^PATH=${process.env.PATH?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), "PATH isn't host.env's");
	assert.equal(existsSync(path.join(dir, "pwned")), false);
});

test("loadConfig: host.env fills unset or empty settings; explicit values win; other keys are ignored", () => {
	writeFileSync(path.join(dir, "conf", "host.env"), "BOXERY_BACKEND=lima\nBOXERY_PROXY_PORT=9000\nBOXERY_CH_DNS=a=b\nPATH=/evil\nBOXERY_POOL=p\n");
	const c = loadConfig({ BOXERY_CONF: path.join(dir, "conf"), BOXERY_PROXY_PORT: "7000", BOXERY_POOL: "", PATH: "/usr/bin" });
	assert.equal(c.backend, "lima");
	assert.equal(c.proxyPort, "7000");
	assert.equal(c.env.BOXERY_POOL, "p");
	assert.equal(c.env.BOXERY_CH_DNS, "a=b");
	assert.equal(c.env.PATH, "/usr/bin");
	assert.equal(c.proxyUnit, "boxery-proxy");
	assert.equal(c.reaperUnit, "boxery-reaper");
	assert.equal(loadConfig({ BOXERY_CONF: path.join(dir, "none") }).backend, "libvirt");
});

test("only contract functions run, and arguments are never evaluated", async () => {
	const b = createBackend(env);
	for (const fn of ["boxery_seed", "backend_list;id", "fake_disk_copy", "", "__functions;id"]) {
		await assert.rejects(b.call(fn, [], { quiet: true }), BackendError, fn);
	}
	const marker = path.join(dir, "pwned");
	assert.equal(await b.exists(`$(touch ${marker})`), false);
	assert.equal(await b.exists(`x; touch ${marker}`), false);
	assert.equal(existsSync(marker), false);
	await assert.rejects(createBackend({ ...env, BOXERY_BACKEND: "nope" }).call("backend_list", [], { quiet: true }), BackendError);
});

test("metadata is parsed: list, images, endpoints, size, optional functions", async () => {
	const b = createBackend(env);
	assert.deepEqual(await b.list(), []);
	fakeVm("a1"); fakeVm("b2", { state: "shut off", port: 22001, size: "4 8192 40" });
	assert.deepEqual(await b.list(), [
		{ name: "a1", state: "running", ssh: "127.0.0.1:22000", diskBytes: 10 * 2 ** 30, diskUsedBytes: 2 ** 29, tunnel: "" },
		{ name: "b2", state: "shut off", ssh: "", diskBytes: 40 * 2 ** 30, diskUsedBytes: 2 ** 29, tunnel: "" },
	]);
	writeFileSync(path.join(dir, "vms", "b2", "size"), "");
	assert.equal((await b.list())[1].diskBytes, null, "an empty or non-numeric size field is unknown (null)");
	writeFileSync(path.join(dir, "vms", "b2", "size"), "4 8192 40");
	assert.equal(await b.exists("a1"), true);
	assert.equal(await b.exists("zz"), false);
	assert.deepEqual(await b.sshEndpoint("a1"), { host: "127.0.0.1", port: "22000", name: "a1" }); // name: whose host key to check
	await assert.rejects(b.sshEndpoint("b2", { quiet: true }), (e) => e instanceof BackendError && e.exitCode === 1 && !e.reported);
	assert.deepEqual(await b.size("b2"), [4, 8192, 40]);
	await b.call("backend_capture", ["a1", "a1@one"]);
	const [img] = await b.images();
	assert.equal(img.image, "a1@one"); assert.equal(img.size, "1MiB");
	assert.equal(await b.imageExists("a1@one"), true);
	assert.equal(await b.imageExists("a1@on"), false);
	assert.equal(await b.has("backend_resize"), true);
	assert.equal(await b.has("backend_no_such_function"), false);
	assert.equal(await b.endpointProblem("a1"), null, "no backend_endpoint_problem: nothing known to be wrong");
	// The check is advisory: if it can't run at all, nothing is known (the ssh wait keeps going).
	const broken = createBackend({ ...env, BOXERY_BACKEND: "no-such-backend" });
	assert.equal(await broken.endpointProblem("a1"), null);
	assert.equal(await b.guestProxyUpstream(), "TCP:fake-gateway:8088");
});

test("Lima starts and renders cloud-config with the host's Node when PATH node is unavailable", async () => {
	stub("node", 'echo "node unavailable on PATH" >&2; exit 127');
	stub("limactl", 'case "$1" in list) ;; start) printf "%s\\n" "$*" >"$START_LOG" ;; esac');
	stub("sandbox-exec", 'shift 2; exec "$@"');
	stub("ssh", 'case "$*" in *"sudo bash -s") cat >"$RENDERED" ;; esac');
	const userdata = path.join(dir, "user-data.yaml");
	const rendered = path.join(dir, "rendered.sh");
	const startLog = path.join(dir, "start.log");
	writeFileSync(userdata, "write_files:\n  - path: /tmp/hello\n    content: hello\n");
	const b = createBackend({ ...env, BOXERY_BACKEND: "lima", BOXERY_LIMA_CONFINE: "1",
		BOXERY_LIMA_VMTYPE: "vz", BASE_USERDATA: userdata, RENDERED: rendered, START_LOG: startLog });
	await b.call("backend_build_base");
	assert.match(readFileSync(startLog, "utf8"), /--ssh-port [1-9][0-9]* /);
	assert.match(readFileSync(rendered, "utf8"), /echo aGVsbG8= \| base64 -d > "\/tmp\/hello"/);
	assert.equal(existsSync(`${userdata}.files.sh`), false);
});

test("Lima: a missing limactl is reported as such, not as a missing base (#143)", async () => {
	// Not macOS, so backend.sh adds no Homebrew directories that might hold a real limactl.
	stub("uname", "echo Linux");
	const lima = { ...env, BOXERY_BACKEND: "lima", PATH: `${path.join(dir, "bin")}:/usr/bin:/bin` };
	await assert.rejects(createBackend(lima).hasBase(), (e) => e instanceof BackendError && e.exitCode === 2 && e.reported);
	stub("limactl", 'echo \'{"name":"boxery-other"}\'');
	assert.equal(await createBackend(lima).hasBase(), false);
	stub("limactl", 'echo \'{"name":"boxery-base"}\'');
	assert.equal(await createBackend(lima).hasBase(), true);
	stub("limactl", "exit 1");
	await assert.rejects(createBackend(lima).hasBase(), (e) => e instanceof BackendError && e.exitCode === 2);
});

test("backend calls on macOS find Homebrew's tools without a login shell's PATH (#143)", async () => {
	stub("uname", "echo Darwin");
	stub("limactl", `printf '%s' "$PATH" >"${dir}/path"`);
	const b = createBackend({ ...env, BOXERY_BACKEND: "lima", PATH: `${path.join(dir, "bin")}:/usr/bin:/bin` });
	assert.equal(await b.hasBase(), false);
	assert.equal(readFileSync(path.join(dir, "path"), "utf8"), `${path.join(dir, "bin")}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`);
});

test("backend scripts run node only as the host's Node (BOXERY_NODE), never from PATH", () => {
	const scripts = ["host/backend.sh", ...readdirSync(path.join(ROOT, "host/backends"), { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".sh")).map((f) => path.join("host/backends", f))];
	const bare = scripts.flatMap((f) => readFileSync(path.join(ROOT, f), "utf8").split("\n")
		.map((l, i) => `${f}:${i + 1}: ${l.trim()}`).filter((l) => /(?:^[^:]+:\d+: |[;&|({]\s*|\bneed\s+)node(?:[\s;]|$)/.test(l)));
	assert.deepEqual(bare, []);
});

test("a failing backend call keeps its exit status and says whether it reported the error", async () => {
	const b = createBackend({ ...env, BOXERY_FAKE_FAIL_CAPTURE: "1" });
	fakeVm("a1");
	await assert.rejects(b.call("backend_capture", ["a1", "a1@x"], { quiet: true }), (/** @type {any} */ e) => e.exitCode === 1 && e.message === "backend_capture failed");
});

test("guest: SSH retries use 250 ms probes, preserving the legacy wait budget", async (t) => {
	const calls = path.join(dir, "attempts");
	stub("ssh", `n=0; [[ ! -f "${calls}" ]] || read -r n <"${calls}"; n=$((n + 1)); echo "$n" >"${calls}"; [[ $n -gt 2 ]]`);
	let now = 0;
	const delays = [];
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setTimeout", (fn, ms) => { delays.push(ms); now += ms; queueMicrotask(fn); });
	const guest = createGuest({ conf: path.join(dir, "conf"), env });
	await guest.waitSsh({ host: "10.0.0.5", port: 22, name: "a1" }, 2);
	assert.deepEqual(delays, [250, 250]);
	assert.equal(readFileSync(calls, "utf8").trim(), "3");

	stub("ssh", "exit 255");
	delays.length = 0;
	let asked = 0;
	await assert.rejects(guest.waitSsh({ host: "10.0.0.5", port: 22, name: "a1" }, 2, async () => {
		asked++; return { fatal: false, message: "still booting" };
	}), /timed out.*still booting/);
	assert.equal(asked, 8);
	assert.deepEqual(delays, Array(8).fill(250));
	assert.equal(now, 2500, "two legacy tries allow 2 seconds of waiting, not 250 ms");
});

test("guest: prepare (host key pinning) runs before every 250 ms probe", async (t) => {
	stub("ssh", "exit 255");
	let now = 0, prepared = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setTimeout", (fn, ms) => { now += ms; queueMicrotask(fn); });
	const guest = createGuest({ conf: path.join(dir, "conf"), env });
	await assert.rejects(guest.waitSsh({ host: "10.0.0.5", port: 22, name: "a1" }, 2, async () => null, async () => { prepared++; }), /timed out/);
	assert.equal(prepared, 8, "one per probe: every 250 ms of the 2 s budget");
});

test("runtime: until a host key is pinned it is looked for on every probe; then refreshed at most every 2 s", async (t) => {
	const { createRuntime } = await import("../host/runtime.mjs");
	let now = 0, asked = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setTimeout", (fn, ms) => { now += ms; queueMicrotask(fn); });
	const rt = createRuntime(env);
	// A platform-managed key (boat): each ensureHostKey asks the backend once; the key appears on the 3rd ask.
	t.mock.method(rt.vms, "has", async (/** @type {string} */ fn) => fn === "backend_platform_host_key");
	t.mock.method(rt.vms, "call", async () => (++asked >= 3 ? "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" : ""));
	t.mock.method(rt.vms, "endpointProblem", async () => null);
	stub("ssh", "exit 255");
	await assert.rejects(rt.waitSsh("a1", { host: "10.0.0.5", port: 22, name: "a1" }, 3), /timed out/);
	// 16 probes over 4 s: asked at 0, 250 and 500 ms (pinned then), and once more at 2500 ms.
	assert.equal(asked, 4);
});

test("guest: SSH connection time consumes the wait budget", async (t) => {
	stub("ssh", "exit 255");
	let now = 0, asked = 0;
	t.mock.method(performance, "now", () => now);
	const guest = createGuest({ conf: path.join(dir, "conf"), env });
	await assert.rejects(guest.waitSsh({ host: "10.0.0.5", port: 22, name: "a1" }, 2, async () => {
		asked++; now += 5000; return null;
	}), /timed out/);
	assert.equal(asked, 1, "a slow failed connection does not get another full wait budget");
});

test("guest: ssh argv, stdin for keys, wait retries, host key creation", async () => {
	const log = path.join(dir, "ssh.log");
	stub("ssh", `printf '%s\\n' "$*" >>"${log}"; [ -n "\${SSH_FAIL:-}" ] && exit 255; case "$*" in *authorized_keys*) cat >"${dir}/keys" ;; esac; exit 0`);
	stub("ssh-keygen", `while [ $# -gt 1 ]; do shift; done; echo "ssh-ed25519 AAAAnew boxery-host" >"$1.pub"; touch "$1"`);
	const conf = path.join(dir, "conf");
	const guest = createGuest({ conf, env });
	assert.equal(guest.hostPubkey(), "ssh-ed25519 AAAAnew boxery-host");
	writeFileSync(path.join(conf, "authorized_keys"), "ssh-ed25519 BBBB laptop\n\nssh-ed25519 AAAAnew boxery-host\n");
	assert.deepEqual(guest.petKeys(), ["ssh-ed25519 AAAAnew boxery-host", "ssh-ed25519 BBBB laptop"]);
	const ep = { host: "10.0.0.5", port: "2222", name: "a1" };
	await guest.setKeys(ep, guest.petKeys());
	assert.equal(readFileSync(path.join(dir, "keys"), "utf8"), "ssh-ed25519 AAAAnew boxery-host\nssh-ed25519 BBBB laptop\n");
	const line = /** @type {string} */ (readFileSync(log, "utf8").trim().split("\n").at(-1));
	assert.match(line, /-o IdentityFile=.*mgmt_ed25519 .* -p 2222 agent@10\.0\.0\.5 umask 077;/);
	// The VM's pinned host key, checked strictly, under its own alias (#70): never accept-anything.
	assert.match(line, new RegExp(`-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${conf}/host-keys/a1 -o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=a1\\.boxery `));
	assert.doesNotMatch(line, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
	await assert.rejects(guest.run({ host: "10.0.0.5", port: "22" }, "true"), /needs the VM.s name/);
	assert.equal(await guest.run(ep, "echo hi"), 0);
	const failing = createGuest({ conf, env: { ...env, SSH_FAIL: "1" } });
	assert.equal(await failing.run(ep, "true"), 255);
	await assert.rejects(failing.waitSsh(ep, 1), /timed out waiting for ssh on 10\.0\.0\.5:2222$/);
	// The backend's endpoint problem: fatal gives up at once, otherwise it is added to the timeout.
	let asked = 0;
	const t0 = Date.now();
	await assert.rejects(failing.waitSsh(ep, 30, async () => (asked++, { fatal: true, message: "no tunnel. Fix: boxery-host start a1" })), /^Error: no tunnel\. Fix: boxery-host start a1$/);
	assert.equal(asked, 1); assert.ok(Date.now() - t0 < 5000, "a fatal problem doesn't wait out the tries");
	await assert.rejects(failing.waitSsh(ep, 1, async () => ({ fatal: false, message: "reconnecting" })), /timed out waiting for ssh on 10\.0\.0\.5:2222: reconnecting$/);
	await assert.rejects(failing.setKeys(ep, ["k"]), /could not set ssh keys/);
});
