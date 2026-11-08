// VM lifecycle on the controller side: what `boxery new|fork|rm|start|stop|resize|snap|revert|snap-rm|
// build-base` and the listings do, shared by the CLI (controller/cli.mjs), the MCP server and the pi
// extension. The host does the work (boxery-host, through core/profile.mjs hostRun); this side keeps
// what lives on this machine in step: shared ssh connections (closed when a VM restarts or goes),
// ssh_config, grants (pushed again when a restart drops them) and the grants a removed VM had.
// Approval of grants (new --grant, fork --grants) belongs to the front-ends; these take approved specs.
import { rmSync } from "node:fs";
import path from "node:path";
import { VALID_NAME, assertImage, assertName, assertSnap, currentHost } from "./boxery-core.mjs";
import { addGrants, listGrants, reapplyPushed } from "./grant-operations.mjs";
import { closeMaster, hostRun, profileConfig, writeSshConfig } from "./profile.mjs";
/** @import { GrantSpec } from "./boxery-core.mjs" */
/** @import { HostRunOpts } from "./profile.mjs" */

/** What the CLI and the tools pass down. log: diagnostics for a person (warnings, the boxery: lines of a
 *  grant re-apply). say: results beside the host's (what granting or re-applying grants did; default: log).
 *  @typedef {Pick<HostRunOpts, "signal" | "timeout" | "stdin" | "stdout" | "stderr" | "onData"> & { log?: (line: string) => void, say?: (line: string) => void }} LifecycleOpts */

/** @param {string | undefined | null} s */
const needSnap = (s) => assertSnap(s);

/** boxery-host ARGS for lifecycle: diagnostics pass through like the CLI's (stderr) unless piped.
 *  @param {string[]} args @param {LifecycleOpts} [opts] */
const host = (args, { log: _log, say: _say, ...opts } = {}) => hostRun(args, { timeout: 0, ...opts });
/** @param {LifecycleOpts} opts */
const sayer = (opts) => opts.say ?? opts.log;

/** Pushed (tmpfs) grants are gone after a restart: push them again. quiet: only boxery: lines are logged.
 *  Never fails the operation. @param {string} vm @param {LifecycleOpts} opts @param {{ always?: boolean, quiet?: boolean }} [how] */
const reapply = (vm, opts, { always = false, quiet = true } = {}) =>
	reapplyPushed(vm, { always, interactiveCommands: opts.stdin === "inherit", log: (l) => opts.log?.(l), say: quiet ? undefined : (t) => sayer(opts)?.(t) });

/** A VM operation that restarts or replaces it: its shared connection is stale before and after.
 *  @param {string} vm @param {string[]} args @param {LifecycleOpts} opts */
async function around(vm, args, opts) {
	await closeMaster(vm);
	try { return await host(args, opts); } finally { await closeMaster(vm); }
}

/** Shape and size flags for new/fork/resize (validated: they reach the host as argv).
 *  @param {{ shape?: string | null, cpus?: number | string | null, mem?: number | string | null, disk?: number | string | null }} s */
function sizeArgs({ shape, cpus, mem, disk }) {
	const out = [];
	if (shape != null && shape !== "") {
		if (!VALID_NAME.test(shape)) throw new Error(`invalid shape name: ${shape}`);
		out.push("--shape", shape);
	}
	for (const [k, v] of Object.entries({ cpus, mem, disk })) {
		if (v == null || v === "") continue;
		if (!/^[0-9]+$/.test(String(v))) throw new Error(`--${k} must be a number`);
		out.push(`--${k}`, String(v));
	}
	return out;
}

/**
 * Create VM NAME. grants: approved specs, saved and applied once it exists.
 * @param {string} name @param {{ shape?: string | null, cpus?: number | string | null, mem?: number | string | null, disk?: number | string | null,
 *   from?: string | null, headless?: boolean, distro?: string | null, layers?: string | null, grants?: GrantSpec[] }} [spec] @param {LifecycleOpts} [opts]
 */
export async function newVm(name, { from, headless, distro, layers, grants = [], ...size } = {}, opts = {}) {
	assertName(name);
	if (from != null) assertImage(from);
	if (distro != null && !["ubuntu", "arch"].includes(distro)) throw new Error("--distro must be ubuntu or arch");
	if (distro && from) throw new Error("--distro cannot be combined with --from");
	if (layers != null && !/^[a-z0-9,-]+$/.test(layers)) throw new Error(`invalid layer list: ${layers}`);
	const out = await host(["new", name, ...(headless ? ["--headless"] : []), ...(distro ? ["--distro", distro] : []), ...(layers != null ? ["--layers", layers] : []), ...sizeArgs(size), ...(from ? ["--from", from] : [])], opts);
	if (grants.length) sayer(opts)?.(await addGrants(name, grants, { interactiveCommands: opts.stdin === "inherit" }));
	return out;
}

/**
 * Copy SRC into new VMs DSTS. grants: approved specs (SRC's, for --grants) given to each fork.
 * The forks that were made keep them even if another fork failed; then this throws the host's error.
 * @param {string} src @param {string[]} dsts @param {{ shape?: string | null, cpus?: number | string | null, mem?: number | string | null, disk?: number | string | null,
 *   grants?: GrantSpec[] }} [spec] @param {LifecycleOpts} [opts]
 */
export async function forkVm(src, dsts, { grants = [], ...size } = {}, opts = {}) {
	assertName(src);
	if (!dsts.length) throw new Error("fork needs at least one destination");
	dsts.forEach(assertName);
	/** @type {unknown} */
	let failure, out = "";
	try { out = await host(["fork", src, ...dsts, ...sizeArgs(size)], opts); } catch (e) { failure = e; }
	if (grants.length) for (const d of dsts) {
		try { sayer(opts)?.(await addGrants(d, grants, { interactiveCommands: opts.stdin === "inherit" })); }
		catch { opts.log?.(`boxery: could not apply grants to ${d}`); }
	}
	if (failure) throw failure;
	return out;
}

/** Remove VM NAME, its grants and edge marker; ssh_config forgets it. @param {string} name @param {LifecycleOpts} [opts] */
export async function rmVm(name, opts = {}) {
	assertName(name);
	const out = await around(name, ["rm", name], opts);
	const grants = path.join(currentHost().dir, "grants");
	rmSync(path.join(grants, name), { force: true });
	rmSync(path.join(grants, `.${name}.edge`), { force: true });
	await writeSshConfig();
	return out;
}

/** @param {string} name @param {LifecycleOpts} [opts] */
export async function startVm(name, opts = {}) {
	assertName(name);
	const out = await around(name, ["start", name], opts);
	await reapply(name, opts, { quiet: false }); // (start shows what it pushed, as it always has)
	return out;
}

/** @param {string} name @param {LifecycleOpts} [opts] */
export const stopVm = (name, opts = {}) => around(assertName(name), ["stop", name], opts);

/** Change a VM's size (it restarts if running; disk only grows).
 *  @param {string} name @param {{ cpus?: number | string | null, mem?: number | string | null, disk?: number | string | null }} size @param {LifecycleOpts} [opts] */
export async function resizeVm(name, size, opts = {}) {
	assertName(name);
	const out = await around(name, ["resize", name, ...sizeArgs(size)], opts);
	await reapply(name, opts);
	return out;
}

/** @param {string} name @param {string | null} [snap] @param {LifecycleOpts} [opts] */
export const snapVm = (name, snap, opts = {}) => host(["snap", assertName(name), ...(snap ? [needSnap(snap)] : [])], opts);

/** Back to snapshot SNAP. Its tmpfs comes back too: grants are always reconciled to the current ones.
 *  @param {string} name @param {string} snap @param {LifecycleOpts} [opts] */
export async function revertVm(name, snap, opts = {}) {
	assertName(name); needSnap(snap);
	const out = await around(name, ["revert", name, snap], opts);
	await reapply(name, opts, { always: true });
	return out;
}

/** @param {string} name @param {string} snap @param {LifecycleOpts} [opts] */
export const snapRm = (name, snap, opts = {}) => host(["snap-rm", assertName(name), needSnap(snap)], opts);

/** @param {LifecycleOpts} [opts] */
export const buildBase = (opts = {}) => host(["build-base"], opts);

/** Re-pin VM NAME's ssh host key on the host. @param {string} name @param {{ fromGuest?: boolean }} [how] @param {LifecycleOpts} [opts] */
export async function pinVm(name, { fromGuest = false } = {}, opts = {}) {
	assertName(name);
	await closeMaster(name);
	return host(["pin", name, ...(fromGuest ? ["--from-guest"] : [])], opts);
}

/** Pool administration passed through; a pool VM named in it gets its shared connection closed around it.
 *  @param {string[]} args @param {LifecycleOpts} [opts] */
export async function pool(args, opts = {}) {
	const vm = args[1];
	if (vm && VALID_NAME.test(vm)) return around(vm, ["pool", ...args], opts);
	return host(["pool", ...args], opts);
}

/**
 * Update running VMs' guest software (NAME, or --all). A restart drops the shared connection and the pushed
 * grants: both are renewed, for every VM it may have touched.
 * @param {string[]} args NAME|--all [--wait S] @param {LifecycleOpts} [opts]
 */
export async function patch(args, opts = {}) {
	const first = args[0] ?? "";
	let names;
	if (first === "--all") {
		// (Which VMs it may restart: their connections and grants are renewed after. A failed listing ends here.)
		// (ls --json alone: a VM's unreadable grant store mustn't keep the others from being patched.)
		const out = await hostRun(["ls", "--json"], { timeout: 120_000, signal: opts.signal });
		if (!out.startsWith("[")) throw new Error(`host returned no JSON for 'ls --json' (update boxery-host on ${(await profileConfig()).host})`);
		/** @type {Array<{ name?: unknown, state?: unknown }>} */
		const rows = JSON.parse(out);
		names = rows.filter((r) => r.state === "running" && typeof r.name === "string" && VALID_NAME.test(r.name)).map((r) => /** @type {string} */ (r.name));
	} else names = [assertName(first)];
	for (const n of names) await closeMaster(n);
	try { return await host(["patch", ...args], opts); }
	finally {
		for (const n of names) {
			await closeMaster(n);
			await reapply(n, opts);
		}
	}
}

/** VMs on the host with this machine's grants (docs/cli.md: boxery ls --json). refresh: read guest
 *  software from running VMs first. @param {{ refresh?: boolean }} [how] @param {LifecycleOpts} [opts] */
export async function listVms({ refresh = false } = {}, opts = {}) {
	const out = await hostRun(["ls", "--json", ...(refresh ? ["--refresh"] : [])], { timeout: 120_000, signal: opts.signal, stderr: opts.stderr, onData: opts.onData });
	if (!out.startsWith("[")) throw new Error(`host returned no JSON for 'ls --json' (update boxery-host on ${(await profileConfig()).host})`);
	/** @type {Array<Record<string, unknown> & { name: string, state?: string }>} */
	const rows = JSON.parse(out);
	return rows.map((r) => {
		if (!VALID_NAME.test(r.name)) throw new Error(`bad VM name from host: ${r.name}`);
		return { ...r, grants: listGrants(r.name) };
	});
}

/** A grant, short, for `boxery ls`: env:VAR, file:PATH (under the VM's home), http:HOST, llm:PROVIDER, ssh-agent.
 *  @param {ReturnType<typeof listGrants>[number]} g */
export const grantLabel = (g) => g.kind === "env" ? `env:${g.var}` : g.kind === "file" ? `file:${g.remote?.replace(/^\/home\/agent\//, "")}` : g.kind === "http" ? `http:${g.host}` : g.kind === "llm" ? `llm:${g.provider}` : g.kind;

/** A host listing as JSON (shapes, snaps NAME, images, capabilities, backends): `boxery-host ARGS --json`.
 *  @param {string[]} args @param {LifecycleOpts} [opts] */
export async function hostJson(args, opts = {}) {
	const out = await hostRun([...args, "--json"], { timeout: 120_000, signal: opts.signal });
	try { return JSON.parse(out); } catch { throw new Error(`boxery-host ${args.join(" ")} --json: not JSON: ${out.slice(0, 200)}`); }
}
