// Who an operation acts for, checked where boxery acts: before every ssh to a VM and every host command
// (core/profile.mjs hostRun), not only when a tool starts. A tool's arguments name VMs in many ways
// (vm, VM@SNAP, HOST/VM:path, fork targets, generated names); checking where the name finally reaches ssh or
// the host means a new way of naming one can't slip past (OWASP: deny by default, check every request).
//
// The grant rides in an AsyncLocalStorage beside the current host (core/boxery-core.mjs), so it follows a
// call into timers and child-process callbacks. The HTTP MCP server runs every session's work inside its grant
// and calls enforce(): from then on an operation with no grant at all is refused (a code path that lost its
// context fails closed). stdio MCP, pi and the CLI never call enforce() and are unaffected.
// (Imports boxery-core and profile, which import this module: fine while nothing here runs at load.)
import { AsyncLocalStorage } from "node:async_hooks";
import { hostBackend } from "./boxery-core.mjs";
import { describeScope, editStore, keyHash, matches, recordOwned, tokenById, toolAllowed } from "./mcp-tokens.mjs";
import { hostRun } from "./profile.mjs";
/** @import { HostProfile } from "./boxery-core.mjs" */
/** @import { Owned, TokenEntry } from "./mcp-tokens.mjs" */

/** A session's grant: everything (the legacy token, --no-auth, stdio), or token ID's scope. defaultHost: the
 *  server's startup host, the only one a token without --host reaches. leased: VMs the session holds a lease on.
 *  @typedef {{ kind: "unscoped" } | { kind: "token", id: string, label: string, defaultHost: string, leased?: (host: string, vm: string) => boolean }} Grant */

export const UNSCOPED = /** @type {Grant} */ (Object.freeze({ kind: "unscoped" }));
/** Backends that manage VM host keys themselves (backend_platform_host_key in host/backends/*.sh): a key there
 *  changes legitimately, so a VM created through a token is identified by its name alone. */
export const PLATFORM_KEY_BACKENDS = ["boat", "openshell"];

const context = /** @type {AsyncLocalStorage<Grant>} */ (new AsyncLocalStorage());
let enforcing = false;
/** From now on (this process), an operation outside any grant is refused. */
export const enforce = () => { enforcing = true; };
/** @template T @param {Grant} grant @param {() => T} fn @returns {T} */
export const withGrant = (grant, fn) => context.run(grant, fn);

/** A refusal the agent can act on. The same words whether or not the VM exists, so it reveals nothing. */
export class OutOfScope extends Error {}
/** @param {Grant & { kind: "token" }} g @param {string} what */
const refuse = (g, what) => new OutOfScope(`${what} is outside this token's scope (token '${g.label}'); ask the user for a token that covers it`);

/** @returns {Grant} */
function grantNow() {
	const g = context.getStore();
	if (g) return g;
	if (enforcing) throw new Error("boxery: refused: this operation has no MCP authorization context (please report this as a bug)");
	return UNSCOPED;
}
/** The token's entry as the store has it now: a removed or expired token stops working mid-session too.
 *  @param {Grant & { kind: "token" }} g @returns {TokenEntry} */
function entryOf(g) {
	const e = tokenById(g.id);
	if (!e) throw new OutOfScope(`token '${g.label}' was removed; ask the user for a new one`);
	if (e.expires != null && e.expires <= Date.now() / 1000) throw new OutOfScope(`token '${g.label}' expired; ask the user for a new one`);
	return e;
}
/** @param {TokenEntry} e @param {Grant & { kind: "token" }} g */
const hostsOf = (e, g) => e.scope.hosts ?? [g.defaultHost];

// ---------------------------------------------------------------- VM identity

/** Host key hashes by host/vm, for a few seconds: a check per ssh would otherwise cost a host call each. */
const keys = new Map();
const KEY_TTL_MS = 10_000;
/** VM's current ssh host key hash on HOST (null: none, or the host can't say). @param {HostProfile} host @param {string} vm @param {boolean} [fresh] */
async function currentKey(host, vm, fresh = false) {
	const k = `${host.name}/${host.dir}/${vm}`;
	const hit = keys.get(k);
	if (!fresh && hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key;
	const line = await hostRun(["known-hosts", vm], { host, timeout: 20_000 }).catch(() => "");
	const key = line.trim() ? keyHash(line.split("\n")[0]) : null;
	keys.set(k, { at: Date.now(), key });
	return key;
}

/** Is VM on HOST in token entry E's scope? Patterns, the session's leases, then VMs created through the token,
 *  if still the same VM (its host key unchanged). @param {Grant & { kind: "token" }} g @param {TokenEntry} e @param {HostProfile} host @param {string} vm */
async function vmInScope(g, e, host, vm) {
	if (e.scope.vms.some((p) => matches(p, vm))) return true;
	if (g.leased?.(host.name, vm)) return true;
	const o = e.owned.find((x) => x.host === host.name && x.vm === vm);
	if (!o) return false;
	return o.key == null || (await currentKey(host, vm)) === o.key;
}

// ---------------------------------------------------------------- checks at the point of action

/** Before ssh to VM on HOST. @param {HostProfile} host @param {string} vm */
export async function authorizeVm(host, vm) {
	const g = grantNow();
	if (g.kind === "unscoped") return;
	const e = entryOf(g);
	if (!hostsOf(e, g).includes(host.name)) throw refuse(g, `host ${host.name}`);
	if (!(await vmInScope(g, e, host, vm))) throw refuse(g, `VM '${vm}' on host ${host.name}`);
}

/** Before work that changes the host for everyone (adding or removing a host registration). @param {string} what */
export function authorizeAdmin(what) {
	const g = grantNow();
	if (g.kind === "unscoped" || entryOf(g).scope.admin) return;
	throw refuse(g, what);
}

/**
 * The boxery-host commands the core sends, by what they touch. `read`: host-wide listings (tools filter what
 * they show by scope). `vm`: VM argv[1]. `new`: creates argv[1] (from --from VM@SNAP, a VM to read).
 * `fork`: reads argv[1], creates the names after it. Anything else (build-base, pool leases, setup) is admin.
 */
export const HOST_COMMANDS = /** @type {const} */ ({
	ls: "read", images: "read", shapes: "read", capabilities: "read", version: "read", help: "read", backend: "read", "known-hosts": "read",
	rm: "vm", start: "vm", stop: "vm", resize: "vm", snap: "vm", "snap-rm": "vm", revert: "vm", snaps: "vm", "edge-set": "vm",
	new: "new", fork: "fork",
});
/** fork's new VMs: the names after the source, up to the first flag. @param {string[]} args */
const forkTargets = (args) => { const out = []; for (const a of args.slice(2)) { if (a.startsWith("-")) break; out.push(a); } return out; };

/** Before boxery-host ARGS on HOST. @param {HostProfile} host @param {string[]} args */
export async function authorizeHostCommand(host, args) {
	const g = grantNow();
	if (g.kind === "unscoped") return;
	const e = entryOf(g);
	const [cmd] = args;
	const kind = Object.hasOwn(HOST_COMMANDS, cmd) ? HOST_COMMANDS[/** @type {keyof typeof HOST_COMMANDS} */ (cmd)] : "admin";
	if (kind === "admin") {
		if (!e.scope.admin) throw refuse(g, `host command '${cmd}'`);
		return;
	}
	if (!hostsOf(e, g).includes(host.name)) throw refuse(g, `host ${host.name}`);
	const vm = async (/** @type {string | undefined} */ name) => {
		if (!name || !(await vmInScope(g, e, host, name))) throw refuse(g, `VM '${name ?? ""}' on host ${host.name}`);
	};
	if (kind === "vm" || kind === "fork") await vm(args[1]);
	if (kind === "new") {
		const i = args.indexOf("--from");
		if (i >= 0) await vm(String(args[i + 1] ?? "").split("@")[0]);
	}
}

/** After boxery-host ARGS succeeded on HOST: VMs a token created become its own (with their host keys), and a
 *  VM it removed stops being. @param {HostProfile} host @param {string[]} args */
export async function afterHostCommand(host, args) {
	const g = grantNow();
	const [cmd] = args;
	const names = cmd === "new" ? [args[1]] : cmd === "fork" ? forkTargets(args) : cmd === "rm" ? [args[1]] : [];
	for (const n of names) keys.delete(`${host.name}/${host.dir}/${n}`);
	if (g.kind === "unscoped" || !names.length) return;
	if (cmd === "rm") {
		// So a VM later made under that name isn't the token's.
		editStore((entries) => {
			const e = entries.find((t) => t.id === g.id);
			if (e) e.owned = e.owned.filter((o) => !(o.host === host.name && o.vm === args[1]));
		});
		return;
	}
	const platform = PLATFORM_KEY_BACKENDS.includes(hostBackend(host) ?? "");
	/** @type {Owned[]} */
	const owned = [];
	for (const vm of names) owned.push({ host: host.name, vm, key: platform ? null : await currentKey(host, vm, true) });
	recordOwned(g.id, owned);
}

// ---------------------------------------------------------------- for the tool layer

/** May the current grant use TOOL (ACTION)? Throws the refusal the agent sees. @param {string} tool @param {string | null | undefined} action */
export function authorizeTool(tool, action) {
	const g = grantNow();
	if (g.kind === "unscoped") return;
	const e = entryOf(g);
	if (!toolAllowed(e.scope, tool, action)) throw refuse(g, action ? `${tool} ${action}` : tool);
}

/** May the current grant use host NAME at all? (vm_manage host, the host argument.) @param {string} name */
export function authorizeHostName(name) {
	const g = grantNow();
	if (g.kind === "unscoped") return;
	if (!hostsOf(entryOf(g), g).includes(name)) throw refuse(g, `host ${name}`);
}

/** For listings: does VM on host HOST belong in what the current grant sees? (Patterns, leases and owned
 *  names; a name it can see but no longer owns is refused when used.) @param {string} host @param {string} vm */
export function visibleVm(host, vm) {
	const g = grantNow();
	if (g.kind === "unscoped") return true;
	let e;
	try { e = entryOf(g); } catch { return false; }
	return hostsOf(e, g).includes(host) && (e.scope.vms.some((p) => matches(p, vm)) || !!g.leased?.(host, vm) || e.owned.some((o) => o.host === host && o.vm === vm));
}
/** @param {string} host */
export function visibleHost(host) {
	const g = grantNow();
	if (g.kind === "unscoped") return true;
	try { return hostsOf(entryOf(g), g).includes(host); } catch { return false; }
}

/** The current grant's tool filter: (tool, actions) → whether any action of it is allowed. */
export function toolFilter() {
	const g = grantNow();
	if (g.kind === "unscoped") return () => true;
	const e = tokenById(g.id);
	return (/** @type {string} */ tool, /** @type {readonly string[] | null} */ actions) => !!e && (actions ? actions.some((a) => toolAllowed(e.scope, tool, a)) : toolAllowed(e.scope, tool, null));
}

/** One line for the agent's instructions: what this connection may do (empty when unscoped). */
export function describeGrant() {
	const g = grantNow();
	if (g.kind === "unscoped") return "";
	const e = tokenById(g.id);
	return e ? `This connection uses token '${g.label}', which allows only: ${describeScope(e.scope, g.defaultHost)}. Other tools, VMs and hosts are refused; don't work around that, ask the user.` : "";
}
