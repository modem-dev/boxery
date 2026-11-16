// Opt-in real-backend checks. Only generated VM names are mutated; no init/build-base/grants/network
// setup, no existing VM names, and no paid model requests. Caller supplies the actual CLI transport.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

/** @typedef {(args: string[], options?: { cleanup?: boolean }) => Promise<string>} Command */
/** @param {{ host: string, distro?: string, run: Command, log?: (line: string) => void }} opts */
export async function lifecycleSmoke({ host, distro, run, log = console.error }) {
	if (!/^[a-z][a-z0-9-]{0,30}$/.test(host)) throw new Error("a valid explicit registered host is required");
	if (distro && !["ubuntu", "arch"].includes(distro)) throw new Error("live distro must be ubuntu or arch");
	const backend = (await run(["--host", host, "backend"])).trim();
	if (!["libvirt", "lima", "cloud-hypervisor", "exe"].includes(backend)) throw new Error(`live headless disk-image checks do not support ${backend}`);
	if (distro === "arch" && backend !== "lima") throw new Error("Arch live validation requires the experimental Lima feature");
	const nonce = randomBytes(5).toString("hex"), prefix = `live-${nonce}`;
	const a = `${prefix}-a`, b = `${prefix}-b`, c = `${prefix}-c`;
	const file = `.boxery-live-${nonce}`, tmpfs = `/dev/shm/boxery-live-${nonce}`;
	/** @type {string[]} */
	const attempted = [];
	/** @type {unknown[]} */
	const failures = [];
	const cli = (/** @type {string[]} */ args, options = {}) => run(["--host", host, ...args], options);
	const guest = (/** @type {string} */ vm, /** @type {string} */ script) => cli(["run", vm, "bash", "-euc", script]);
	const identity = async (/** @type {string} */ vm) => {
		const lines = (await guest(vm, "cat /etc/machine-id; cat /etc/ssh/boxery_host_ed25519_key.pub")).trim().split("\n");
		assert.match(lines[0], /^[a-f0-9]{32}$/);
		assert.match(lines[1], /^ssh-ed25519 /);
		return lines;
	};
	const distinct = (/** @type {string[]} */ source, /** @type {string[]} */ clone) => {
		assert.notEqual(source[0], clone[0], "clone must get a fresh machine ID");
		assert.notEqual(source[1], clone[1], "clone must get a fresh pinned SSH host key");
	};
	log(`LIVE ${host} (${backend}): will create ${a}, ${b}, ${c}; provider compute may be billed`);
	try {
		attempted.push(a);
		await cli(["new", a, "--headless", "--cpus", "1", "--mem", "2048", "--disk", "20", ...(distro ? ["--distro", distro] : [])]);
		const original = await identity(a);
		await guest(a, `test -f /etc/boxery/headless; test "$(stat -f -c %T /dev/shm)" = tmpfs; printf %s ${nonce} >${file}; printf %s ${nonce} >${tmpfs}`);
		await cli(["snap", a, "disk-only"]);
		attempted.push(b);
		await cli(["new", b, "--from", `${a}@disk-only`]);
		const cloned = await identity(b); distinct(original, cloned);
		await guest(b, `test -f /etc/boxery/headless; test "$(cat ${file})" = ${nonce}; test ! -e ${tmpfs}; printf clone-only >${file}; printf volatile >${tmpfs}`);
		await guest(a, `test "$(cat ${file})" = ${nonce}`);
		attempted.push(c);
		await cli(["fork", b, c]);
		const forked = await identity(c); distinct(original, forked); distinct(cloned, forked);
		await guest(c, `test "$(cat ${file})" = clone-only; test ! -e ${tmpfs}; printf fork-only >${file}`);
		await guest(b, `test "$(cat ${file})" = clone-only`);
		await cli(["stop", b]); await cli(["start", b]);
		await guest(b, `test "$(cat ${file})" = clone-only; test ! -e ${tmpfs}`);
		assert.deepEqual(await identity(b), cloned, "ordinary restart must preserve VM identity and its pinned key");
		log("PASS: SSH, headless marker, independent disks, disk-only snapshot/new-from/fork, fresh identities and restart");
	} catch (e) { failures.push(e); }
	finally {
		for (const name of attempted.reverse()) {
			try { await cli(["rm", name], { cleanup: true }); log(`removed ${name}`); }
			catch (e) { failures.push(new Error(`cleanup failed for ${host}/${name}: ${/** @type {Error} */ (e).message}`)); }
		}
	}
	if (failures.length) throw new AggregateError(failures, `live check failed; inspect generated ${prefix}-* resources if cleanup failed`);
}
