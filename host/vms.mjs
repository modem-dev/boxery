// VM lifecycle commands: new, fork, rm, start, stop, resize. Each runs inside a supervised worker that
// holds the VMs' lifecycle locks for its whole duration (boxery-operations.mjs, docs/lifecycle.md).
import { randomBytes } from "node:crypto";
import { DEFAULT_OS } from "../guests/index.mjs";
import * as linux from "../guests/linux.mjs";
import { buildRecord, deleteBuildRecord, guestChecker, refreshBuild } from "./build-info.mjs";
import { captureVm, cleanupVmImages } from "./images.mjs";
import { deleteHostKey } from "./hostkeys.mjs";
import { issueToken, writeSeed } from "./seed.mjs";
import { shapeSize } from "./shapes.mjs";
import { fail, hint, log, print, sleep, stamp, validImage, validName, validNum } from "./util.mjs";
import { createVmRecord, deleteVmRecord, inheritedType, setVmSize, vmRecord } from "./vm-records.mjs";
import { hostUsage } from "./help.mjs";
/** @import { BuildRecord } from "./build-info.mjs" */
/** @import { GuestEndpoint } from "./guest.mjs" */
/** @import { Runtime } from "./runtime.mjs" */
/** @import { ShapeInput } from "./shapes.mjs" */
/** @import { VmKind } from "./vm-records.mjs" */

/** Parsed `new` arguments; sizes are the flags' strings ("" = unset). layers: optional layers on top of
 *  plumbing + devtools (headless only). sameAs (fork, not a flag): the shape name to record although the
 *  size is given by flags, which copy that shape's size exactly. forked (fork, not a flag): fork warns
 *  about outdated guest software once, for all its copies.
 *  @typedef {{ name: string, shape: string, cpus: string, mem: string, disk: string, from: string, headless: boolean, layers?: string[], sameAs?: string, forked?: boolean }} NewArgs */
// Layers a headless VM may add with --layers (image/layers/; the base layers are always there).
export const OPTIONAL_LAYERS = ["github-runner"];
/** @typedef {{ cpus: string, mem: string, disk: string }} SizeFlags */

const SHAPE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const NOVNC = "for i in $(seq 60); do curl -fsS -o /dev/null 127.0.0.1:6080/vnc.html && exit 0; sleep 1; done; exit 1";

/** Pet VMs accept the host and every registered controller. @param {Runtime} rt @param {string} name */
export async function setPetKeys(rt, name) {
	await rt.guest.setKeys(await rt.vms.sshEndpoint(name), rt.guest.petKeys());
}
/** Back to a pet: registered controller keys may log in again, and the VM gets a proxy token of its own
 * (a pool VM's token belonged to a lease). A stopped VM gets both on its next start; a
 * running-but-unreachable guest is an error, not a successful permission update. @param {Runtime} rt @param {string} name */
export async function restorePetAccess(rt, name) {
	let inventory;
	try { inventory = await rt.vms.list(); } catch { fail("cannot inspect VM for pet access"); }
	if (/** @type {Array<string | undefined>} */ (["running", "idle"]).includes(inventory.find((v) => v.name === name)?.state)) {
		try { await setPetKeys(rt, name); await issueToken(rt, name); } catch { fail(`could not restore pet access to ${name}`); }
	} else rt.deleteToken(name);
}
/** @param {Runtime} rt @param {GuestEndpoint} ep @param {string} command */
async function mustRun(rt, ep, command) {
	if (await rt.guest.run(ep, command) !== 0) fail(`ssh to ${ep.host}:${ep.port} failed`);
}

const BOOT_ID = "cat /proc/sys/kernel/random/boot_id";
/** Restart NAME if its updates ask for it, and wait until it is back (a new boot id). @param {Runtime} rt @param {string} name @param {GuestEndpoint} ep */
export async function rebootIfRequired(rt, name, ep) {
	if (await rt.guest.run(ep, "test -e /var/run/reboot-required", { quiet: true }) !== 0) return false;
	const boot = (await rt.guest.output(ep, BOOT_ID)).out.trim();
	log(`${name}: restarting it (the updates ask for it: /var/run/reboot-required)`);
	await rt.guest.run(ep, "sudo systemctl reboot", { quiet: true }); // the connection may drop
	const tries = Number(rt.env.BOXERY_SSH_WAIT_TRIES || 180);
	for (let i = 0; i < tries; i++) {
		await sleep(2000);
		try {
			const now = await rt.guest.output(await rt.vms.sshEndpoint(name, { quiet: true }), BOOT_ID);
			if (now.code === 0 && now.out.trim() && now.out.trim() !== boot) return true;
		} catch { /* not back yet */ }
	}
	return fail(`${name} did not come back after restarting (${hint("ls")}; ${hint(`start ${name}`)})`);
}

// ---------------------------------------------------------------- new
const NEW_USAGE = hostUsage("new");
/** new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless [--layers L,…]] @param {string[]} args */
export function parseNewArgs(args) {
	/** @type {NewArgs} */
	const o = { name: "", shape: "", cpus: "", mem: "", disk: "", from: "", headless: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--headless") o.headless = true;
		else if (a === "--layers") {
			const layers = (v ?? "").split(",");
			for (const l of layers) if (!OPTIONAL_LAYERS.includes(l)) fail(`unknown layer '${l}' (optional layers: ${OPTIONAL_LAYERS.join(", ")})`);
			o.layers = [...new Set(layers)]; i++;
		}
		else if (a === "--shape") { if (!SHAPE_NAME.test(v ?? "")) fail(`invalid shape name '${v ?? ""}'`); o.shape = v; i++; }
		else if (["--cpus", "--mem", "--disk"].includes(a)) { o[/** @type {keyof SizeFlags} */ (a.slice(2))] = validNum(a, v); i++; }
		else if (a === "--from") { o.from = validImage(v); i++; }
		else if (a.startsWith("-")) fail(`unknown flag ${a}`);
		else o.name = a;
	}
	if (!o.name) fail(NEW_USAGE);
	// A desktop VM's layers come from its base and a VM from an image keeps its source's: only a headless VM,
	// provisioned from the stock image at first boot, can add one.
	if (o.layers && (!o.headless || o.from)) fail("--layers needs --headless (and no --from: a VM made from an image has its source's layers)");
	return o;
}

/** The size the backend gave new VM NAME, which may not be the one asked for (#211): exe.dev caps it to the
 *  account's largest VM, boat rounds up to one of its types, a disk grows to its source's. A VM whose CPUs
 *  or memory differ from its shape's is a custom size; a bigger disk keeps the shape's name. The size
 *  asked for if the backend can't say. @param {Runtime} rt @param {string} name @param {ShapeInput} want
 *  @returns {Promise<ShapeInput>} */
async function sizeGot(rt, name, want) {
	if (!await rt.vms.has("backend_size")) return want;
	const got = await rt.vms.size(name, { quiet: true }).catch(() => null);
	if (!got) return want;
	const [cpus, mem, disk] = got;
	return { shape: cpus === Number(want.cpus) && mem === Number(want.mem) ? want.shape : null, cpus, mem, disk };
}

/** Create, boot and wait for NAME. Returns "NAME HOST:PORT". @param {Runtime} rt @param {NewArgs} args */
export async function createVm(rt, { name, shape, cpus, mem, disk, from, headless, layers = [], sameAs, forked = false }) {
	validName(name);
	if (rt.backend === "openshell") {
		if (!headless || from) fail("OpenShell supports only new --headless without --from; no desktop, snapshots, forks or pools");
		if (disk) fail("OpenShell disk sizing is managed by its compute driver; omit --disk");
		if (layers.length) fail("OpenShell uses prebuilt images; --layers is not supported");
	}
	// Size: the shape (the default shape if none), then explicit flags. Any flag makes it a custom size, as does a backend that
	// gives the VM other CPUs or memory (sizeGot).
	const shapes = rt.shapes();
	const base = shapeSize(shapes, shape || shapes.default);
	const custom = Boolean(cpus || mem || disk);
	const label = sameAs ?? (custom ? "" : shape || shapes.default);
	cpus ||= String(base.cpus); mem ||= String(base.mem); disk ||= String(base.disk);
	if (!(Number(cpus) >= 1 && Number(mem) >= 1 && Number(disk) >= 1)) fail("--cpus, --mem and --disk must be >= 1");
	if (await rt.vms.exists(name)) fail(`${name} already exists`);
	// Where the disk comes from: an image (its VM's kind and OS), the stock image (headless), or the desktop base.
	/** @type {VmKind} */
	let kind = "desktop";
	let os = DEFAULT_OS, src = "", provision = "";
	if (from) {
		if (!await rt.vms.imageExists(from)) fail(`no such image: ${from} (${hint("images")})`);
		({ kind, os } = inheritedType(rt.db(), from)); src = from;
		if (headless && kind !== "headless") fail(`${from} has a desktop, and a VM made from an image keeps it (drop --headless)`);
	} else if (headless) {
		kind = "headless"; src = "stock"; provision = ["plumbing", "devtools", ...layers].join(" ");
	} else if (!await rt.vms.hasBase()) {
		fail(`no base image; run: ${hint("build-base")} (or: new ${name} --headless, which needs none)`);
	}
	const t0 = performance.now(), secs = () => Math.floor((performance.now() - t0) / 1000); // monotonic: a wall clock can step back
	// Opt-in diagnostics stay on stderr and never include seed contents, tokens or SSH commands.
	/** @template T @param {string} stage @param {() => Promise<T>} fn @returns {Promise<T>} */
	const step = async (stage, fn) => {
		if (rt.env?.BOXERY_TIMINGS !== "1") return fn();
		const start = performance.now();
		let ok = false;
		try { const result = await fn(); ok = true; return result; }
		finally { process.stderr.write(`[boxery-timing] ${JSON.stringify({ vm: name, stage, ms: Math.round(performance.now() - start), ok })}\n`); }
	};
	const action = rt.intent("create", name);
	// Restricted workloads have no root provisioning, guest SSH keys or Boxery proxy token.
	const userdata = rt.backend === "openshell" ? "" : await step("seed", () => writeSeed(rt, name, provision));
	await step("backend-new", () => rt.vms.call("backend_new", [name, cpus, mem, disk, userdata, src]));
	createVmRecord(rt.db(), name, { kind, os, size: rt.backend === "openshell" ? null : await step("size", () => sizeGot(rt, name, { shape: label, cpus, mem, disk })) });
	let ep = await step("endpoint", () => rt.vms.waitEndpoint(name));
	log(rt.backend === "openshell" ? `${name}: waiting for restricted gateway SSH` : `${name} reachable at ${ep.host}:${ep.port}; waiting for ssh + cloud-init${provision ? ` (installing ${provision})` : ""}`);
	await step("ssh", () => rt.waitSsh(name, ep));
	if (rt.backend === "openshell") {
		await mustRun(rt, ep, `test "$(id -u)" != 0 && test "$HOME" = ${linux.home} && test -d ${linux.project} && test -f ${linux.configDir}/headless || exit 1; for tool in bash node tar python3 setsid file git tmux; do command -v "$tool" >/dev/null || exit 1; done`);
		rt.done(action);
		log(`${name} ready (restricted headless; policy and credentials managed by OpenShell)`);
		return `${name} ${ep.host}:${ep.port}`;
	}
	await step("cloud-init", () => mustRun(rt, ep, "cloud-init status --wait >/dev/null 2>&1; true"));
	if (provision) {
		if (await rt.guest.run(ep, "test -f /var/log/boxery-provision.ok") !== 0) {
			await rt.guest.run(ep, "sudo tail -30 /var/log/boxery-provision.log");
			fail(`installing ${provision} on ${name} failed (log above: /var/log/boxery-provision.log in the VM)`);
		}
		log(`${name}: ${provision} installed ${secs()}s after create`);
	}
	// A VM made from an image starts with another VM's disk. Whatever the backend did to give it its own
	// identity, make sure of the parts boxery's security depends on: exactly this host's keys (never the
	// source's lease holder), and nothing pushed by grants (tmpfs, so normally gone already).
	if (from) {
		try { await setPetKeys(rt, name); } catch { fail(`could not reset ssh keys on ${name}`); }
		await rt.guest.run(ep, `rm -rf "${linux.grantsDir}"`);
	}
	if (kind === "desktop" && await step("desktop", () => rt.guest.run(ep, NOVNC)) !== 0) log("warning: noVNC not answering yet");
	// The stock image's first-boot updates may want a reboot (a new kernel): do it now, so a new headless VM
	// starts current instead of an outdated guest (#215). A desktop or image VM's disk was updated before.
	let built = await refreshBuild(rt, name, ep); // what it was built with (from an image or fork: its source's software)
	if (provision && built?.reboot_required && await step("reboot", () => rebootIfRequired(rt, name, ep))) {
		ep = await rt.vms.sshEndpoint(name, { quiet: true });
		built = await refreshBuild(rt, name, ep);
	}
	rt.done(action);
	log(`${name} ready (${kind}, ${secs()}s)`);
	if (!forked) warnOutdated(rt, name, built, kind === "desktop" && !from ? "the desktop base" : from);
	return `${name} ${ep.host}:${ep.port}`;
}

/** Say when VM NAME is an outdated guest the moment it exists, because SOURCE (its image, or "the desktop
 *  base") is, and what to do (#215). @param {Runtime} rt @param {string} name @param {BuildRecord | null} rec
 *  @param {string} source */
function warnOutdated(rt, name, rec, source) {
	const { status, reasons } = guestChecker(rt)(rec, { image: true }); // what it was built with; a reboot is the guest's own
	if (status !== "outdated" || !source) return;
	const fix = source === "the desktop base" ? `; to make new desktop VMs current, rebuild the base (${hint("build-base")}) once no VM depends on it` : "";
	log(`warning: ${name} is an outdated guest (${reasons.join(", ")}), as ${source} is; update it with: ${hint(`patch ${name}`)}${fix}`);
}

/** @param {Runtime} rt @param {string[]} args */
export async function newVm(rt, args) {
	print(await createVm(rt, parseNewArgs(args)));
}

// ---------------------------------------------------------------- fork
// fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]: capture SRC once (it keeps running; Lima restarts it), then
// boot every DST from that image with its own identity (hostname, proxy token, ssh keys, network). Prints
// "DST ADDR" per fork, like new. The capture is temporary: forks never depend on it. Forks get SRC's
// recorded size unless --shape or a size flag is given (flags override SRC's size field by field).
/** @param {Runtime} rt @param {string[]} args */
export async function fork(rt, args) {
	let src = "", shape = "";
	const dsts = /** @type {string[]} */ ([]), flags = /** @type {string[]} */ ([]);
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (["--cpus", "--mem", "--disk"].includes(a)) { flags.push(a, validNum(a, v)); i++; }
		else if (a === "--shape") { if (!SHAPE_NAME.test(v ?? "")) fail(`invalid shape name '${v ?? ""}'`); shape = v; i++; }
		else if (a.startsWith("-")) fail(`unknown flag ${a}`);
		else if (!src) src = a;
		else dsts.push(a);
	}
	if (!src || !dsts.length) fail(hostUsage("fork"));
	validName(src);
	if (!await rt.vms.exists(src)) fail(`no such vm: ${src}`);
	inheritedType(rt.db(), src); // a guest OS this boxery doesn't know fails here, before the capture
	// Size: --shape, else SRC's recorded size, else (VMs made before shapes) its size per the backend.
	const { size: rec } = vmRecord(rt.db(), src);
	/** @type {number[] | null} */
	let sz = rec ? [rec.cpus, rec.mem, rec.disk] : null;
	if (!rec && await rt.vms.has("backend_size")) sz = await rt.vms.size(src, { quiet: true }).catch(() => null);
	/** @type {string[]} */
	let sizing = [], label = "";
	if (shape) { shapeSize(rt.shapes(), shape); sizing = ["--shape", shape]; }
	else if (sz?.every((n) => Number.isInteger(n) && n >= 0)) {
		/** @type {Partial<Record<string, number>>} */
		const size = { "--cpus": sz[0], "--mem": sz[1], "--disk": sz[2] };
		for (let i = 0; i < flags.length; i += 2) delete size[flags[i]];
		sizing = Object.entries(size).flatMap(([f, n]) => [f, String(n)]);
		if (!flags.length && rec) label = rec.shape ?? ""; // an exact copy of SRC's size keeps SRC's shape name
	}
	for (const d of dsts) {
		validName(d);
		if (await rt.vms.exists(d)) fail(`${d} already exists`);
		if (dsts.filter((x) => x === d).length !== 1) fail(`duplicate fork name ${d}`);
	}
	const image = `${src}@fork-${stamp()}-${randomBytes(3).toString("hex")}`;
	const cleanup = rt.intent("fork-image", image);
	const t0 = performance.now(), secs = () => Math.floor((performance.now() - t0) / 1000);
	await captureVm(rt, src, image);
	log(`captured ${src} in ${secs()}s; booting ${dsts.length} fork(s)`);
	// Boot the forks in parallel under this operation's locks; print results in argument order. A failed
	// fork leaves its create intent behind, so the supervisor removes it after this worker exits.
	const results = await Promise.allSettled(dsts.map((d) => createVm(rt, { ...parseNewArgs([d, ...sizing, ...flags, "--from", image]), ...(label ? { sameAs: label } : {}), forked: true })));
	let rc = 0;
	results.forEach((r, i) => {
		if (r.status === "fulfilled") {
			print(r.value);
		} else {
			rc = 1;
			if (!r.reason?.reported) process.stderr.write(`boxery-host: ${r.reason?.message ?? r.reason}\n`);
			log(`fork ${dsts[i]} failed`);
		}
	});
	await rt.vms.call("backend_image_rm", [image]);
	// Once for all the forks, naming SRC: patching it first gives current forks (#215).
	const { status, reasons } = guestChecker(rt)(buildRecord(rt.conf, image), { image: true });
	if (status === "outdated" && results.some((r) => r.status === "fulfilled")) log(`warning: ${src} is an outdated guest (${reasons.join(", ")}), and so are its forks; update them with: ${hint("patch NAME")} (patch ${src} first to fork current copies)`);
	deleteBuildRecord(rt.conf, image);
	rt.done(cleanup);
	log(`forked ${src} → ${dsts.join(" ")} in ${secs()}s`);
	if (rc) throw Object.assign(new Error("fork failed"), { exitCode: rc, reported: true });
}

// ---------------------------------------------------------------- rm, start, stop
/** @param {Runtime} rt @param {string[]} args */
export async function rm(rt, [name]) {
	validName(name);
	if (rt.poolRow(name)) fail(`${name} is a pool VM; run: ${hint(`pool rm ${name}`)} (after its lease ends)`);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	const action = rt.intent("remove", name);
	await rt.vms.call("backend_rm", [name]);
	deleteVmRecord(rt.db(), name); deleteBuildRecord(rt.conf, name, true);
	// Forks and image readers hold this source's lock until all copies are independent.
	await cleanupVmImages(rt, name);
	rt.deleteToken(name);
	rt.clearEdge(name);
	deleteHostKey(rt.conf, name);
	rt.done(action);
	log(`${name} removed with its snapshots (proxy token revoked)`);
}

/** How a stop's result shows in backend_list ("" while it isn't stopped). exe.dev's stop pauses; on the
 *  other backends a paused VM is still active (libvirt pauses a domain on an I/O error), so it isn't
 *  stopped there. @param {Runtime} rt @param {string} state */
const stoppedAs = (rt, state) => (state === "shut off" ? "stopped" : state === "paused" && rt.backend === "exe" ? "paused" : "");
/** NAME's row in the backend's inventory. undefined if it can't be read: start and stop then leave it to
 *  the backend, as before. @param {Runtime} rt @param {string} name */
async function inventoryEntry(rt, name) {
	try { return (await rt.vms.list({ quiet: true })).find((v) => v.name === name); } catch { return undefined; }
}

/** @param {Runtime} rt @param {string[]} args */
export async function start(rt, [name]) {
	validName(name);
	// Checked here, not left to the backend: `limactl start` of an unknown instance creates one (#209).
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	// Agents retry, so a VM that already runs is success, the same on every backend (#214); it still has to
	// answer ssh. One whose tunnel isn't up goes to the backend: its start brings the tunnel back.
	const vm = await inventoryEntry(rt, name);
	if (vm?.state === "running" && (!vm.tunnel || vm.tunnel === "up")) {
		await rt.waitSsh(name, await rt.vms.waitEndpoint(name));
		log(`${name} is already running`);
		return;
	}
	await rt.vms.call("backend_start", [name]);
	const ep = await rt.vms.waitEndpoint(name);
	await rt.waitSsh(name, ep);
	if (rt.backend !== "openshell") await refreshBuild(rt, name, ep); // a restart may have been what the guest's updates were waiting for
	if (rt.backend !== "openshell" && !rt.poolRow(name)) {
		await setPetKeys(rt, name);
		if (typeof rt.token(name) !== "string") await issueToken(rt, name); // left the pool while stopped
	}
	log(`${name} started`);
}

/** Stop NAME and wait until it is off: some backends only ask the guest to shut down (libvirt, cloud-hypervisor),
 *  and a `stop && start` must not find it still running (#214). @param {Runtime} rt @param {string[]} args */
export async function stop(rt, [name]) {
	validName(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	const vm = await inventoryEntry(rt, name);
	// A stopped VM whose tunnel is still up (stopped outside boxery) goes to the backend, which ends the tunnel.
	const was = stoppedAs(rt, vm?.state ?? "");
	if (was && (!vm?.tunnel || vm.tunnel === "down")) { log(`${name} is already ${was}`); return; }
	await rt.vms.call("backend_stop", [name]);
	const wait = Number(rt.env?.BOXERY_STOP_WAIT) > 0 ? Number(rt.env?.BOXERY_STOP_WAIT) : 120, t0 = performance.now();
	for (let announced = false; ;) {
		const now = await inventoryEntry(rt, name);
		if (!now) { log(`${name} shutting down`); return; } // can't tell: as before
		const as = stoppedAs(rt, now.state);
		if (as) { log(`${name} ${as}`); return; }
		if (performance.now() - t0 >= wait * 1000) fail(`${name} is still ${now.state || "running"} ${wait}s after it was asked to shut down; run stop again, or look at the guest's console`);
		if (!announced) { log(`${name} shutting down`); announced = true; }
		await sleep(1000);
	}
}

// ---------------------------------------------------------------- resize
const RESIZE_USAGE = hostUsage("resize");
/** @param {Runtime} rt @param {string[]} argv */
export async function resize(rt, [name, ...args]) {
	if (!name || name.startsWith("-")) fail(RESIZE_USAGE);
	/** @type {SizeFlags} */
	const want = { cpus: "", mem: "", disk: "" };
	for (let i = 0; i < args.length; i += 2) {
		if (!["--cpus", "--mem", "--disk"].includes(args[i])) fail(RESIZE_USAGE);
		want[/** @type {keyof SizeFlags} */ (args[i].slice(2))] = validNum(args[i], args[i + 1]);
	}
	if (!want.cpus && !want.mem && !want.disk) fail(RESIZE_USAGE);
	validName(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	if (want.cpus && !(Number(want.cpus) >= 1)) fail("--cpus must be at least 1");
	if (want.mem && !(Number(want.mem) >= 512)) fail("--mem must be at least 512 MiB");
	if (!await rt.vms.has("backend_resize")) fail(`the ${rt.backend} backend cannot resize VMs`);
	rt.requireLock(name);
	await resizeVm(rt, name, want);
}

// Like start/stop, the result is the hypervisor's state: an interrupted resize is not rolled back.
/** @param {Runtime} rt @param {string} name @param {SizeFlags} want */
async function resizeVm(rt, name, want) {
	let before;
	try { before = await rt.vms.size(name); } catch { fail(`cannot read the size of ${name}`); }
	const [c, m, d] = before;
	if (want.disk && Number(want.disk) < d) fail(`${name}: disk can only grow (it is ${d} GiB)`);
	const change = [want.cpus, want.mem, want.disk].map((v, i) => (v && Number(v) !== before[i] ? v : ""));
	if (change.every((v) => !v)) { log(`${name} already has ${c} vCPU, ${m} MiB, ${d} GiB`); return; }
	const was = (await rt.vms.list()).find((v) => v.name === name)?.state;
	await rt.vms.call("backend_resize", [name, ...change]);
	if (was === "running") {
		await rt.waitSsh(name, await rt.vms.waitEndpoint(name));
		if (!rt.poolRow(name)) await setPetKeys(rt, name);
	}
	let after;
	try { after = await rt.vms.size(name); } catch { fail(`${name} was resized, but its new size cannot be read`); }
	const [cpus, mem, disk] = after;
	setVmSize(rt.db(), name, { shape: null, cpus, mem, disk }); // no longer its shape's size: custom
	log(`${name} resized: ${c} vCPU, ${m} MiB, ${d} GiB → ${cpus} vCPU, ${mem} MiB, ${disk} GiB`);
}
