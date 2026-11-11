// Scoped bearer tokens for the HTTP MCP server (#3): the store and what a scope allows. The store is
// $BOXERY_HOME/mcp-tokens.json (0600) on the machine running the server, beside the host registry it reads;
// a host never sees it. Each entry keeps a SHA-256 of its secret (32 random bytes, so no key stretching is
// needed), a label, an optional expiry, its scope, and the VMs created through it ("owned", each with the
// ssh host key it had then, so a VM later made under the same name by someone else isn't owned).
// Read as the proxy reads tokens.json: a stat per call, parsed again only when the file changes, so
// `boxery mcp-token rm` and expiry count from the next request. Written under a lock file, then renamed.
// No imports beyond node: builtins and fsutil: the CLI, the MCP server and core/mcp-auth.mjs share it.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeAtomic } from "./fsutil.mjs";

/** Tool → its actions (tools with an `action` enum), or null (no actions). From core/boxery-tools.mjs TOOLS.
 *  @typedef {Record<string, readonly string[] | null>} Catalog */
/** tools: tool → true (every action) or the actions allowed. hosts: host names (null: the server's own host).
 *  vms: name patterns (`*` matches any run of characters). admin: host-wide work (build-base, adding and
 *  removing hosts, pool leases, any host command not listed in core/mcp-auth.mjs).
 *  @typedef {{ tools: Record<string, true | string[]>, hosts: string[] | null, vms: string[], admin: boolean }} Scope */
/** A VM created through a token: its host, name, and ssh host key line hash then (null: the backend
 *  manages host keys itself, or the host predates pinned keys, so the name alone identifies it).
 *  @typedef {{ host: string, vm: string, key: string | null }} Owned */
/** @typedef {{ id: string, label: string, hash: string, created: number, expires: number | null, scope: Scope, owned: Owned[] }} TokenEntry */

export const TOKEN_PREFIX = "bxm_";
export const VALID_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VALID_PATTERN = /^[a-z*][a-z0-9*-]{0,30}$/;
const VALID_HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Host-wide actions only an admin token may take: they change the host for everyone, or hold pool VMs. */
export const ADMIN_ACTIONS = { vm_manage: ["build-base", "host_add", "host_rm"], vm_lease: ["acquire", "renew", "release", "list"] };
/** Tools that only look (their MCP annotation readOnlyHint). */
export const READ_ONLY_TOOLS = ["vm_read", "vm_screenshot", "vm_info"];

export const storeFile = () => path.join(path.resolve(process.env.BOXERY_HOME ?? path.join(homedir(), ".boxery")), "mcp-tokens.json");
const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");
/** sha256 of an ssh host key line, as Owned.key keeps it (whitespace-normalized). @param {string} line */
export const keyHash = (line) => sha(line.trim().split(/\s+/).slice(-2).join(" "));

// ---------------------------------------------------------------- scope

/** `*` as "any run of characters", the rest literal. @param {string} pattern @param {string} name */
export const matches = (pattern, name) => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\-]/g, "\\$&")).join(".*")}$`).test(name);

/** Is TOOL's ACTION (null for tools without actions) allowed? Anything not listed is refused.
 *  @param {Scope} scope @param {string} tool @param {string | null | undefined} action */
export function toolAllowed(scope, tool, action) {
	const t = Object.hasOwn(scope.tools, tool) ? scope.tools[tool] : undefined;
	if (t === undefined) return false;
	if (action != null && !scope.admin && /** @type {Record<string, string[]>} */ (ADMIN_ACTIONS)[tool]?.includes(action)) return false;
	if (t === true) return true;
	return action != null && t.includes(action);
}

/**
 * The tools part of a scope from --tools / --read-only (else every tool; admin actions still need --admin).
 * spec: "vm_bash,vm_manage:new,vm_manage:snap". Unknown tools or actions are errors, not ignored.
 * @param {Catalog} catalog @param {{ tools?: string | null, readOnly?: boolean }} opts @returns {Scope["tools"]}
 */
export function toolsScope(catalog, { tools, readOnly = false } = {}) {
	if (tools != null && readOnly) throw new Error("use either --tools or --read-only");
	/** @type {Scope["tools"]} */
	const out = {};
	if (readOnly) {
		for (const t of READ_ONLY_TOOLS) if (Object.hasOwn(catalog, t)) out[t] = true;
		return out;
	}
	if (tools == null) {
		for (const t of Object.keys(catalog)) out[t] = true;
		return out;
	}
	for (const item of tools.split(",").map((s) => s.trim()).filter(Boolean)) {
		const [tool, action, ...rest] = item.split(":");
		if (rest.length || !Object.hasOwn(catalog, tool)) throw new Error(`unknown tool in --tools: ${item} (tools: ${Object.keys(catalog).join(", ")})`);
		const actions = catalog[tool];
		if (action === undefined) { out[tool] = true; continue; }
		if (!actions?.includes(action)) throw new Error(`${tool} has no action ${action}${actions ? ` (actions: ${actions.join(", ")})` : ""}`);
		const cur = out[tool];
		if (cur !== true) out[tool] = [...(cur ?? []), action];
	}
	if (!Object.keys(out).length) throw new Error("--tools allows nothing");
	return out;
}

/** --vm patterns, checked. @param {string[]} patterns */
export function vmPatterns(patterns) {
	for (const p of patterns) if (!VALID_PATTERN.test(p)) throw new Error(`invalid --vm pattern: ${p} (a VM name, * for any characters)`);
	return [...new Set(patterns)];
}

/** --host names, checked (whether they're registered is the caller's to check). @param {string[]} hosts */
export function hostNames(hosts) {
	for (const h of hosts) if (!VALID_HOST_NAME.test(h)) throw new Error(`invalid --host: ${h}`);
	return hosts.length ? [...new Set(hosts)] : null;
}

/** "30d", "12h", "90m", "never" → seconds, or null for never. @param {string} ttl */
export function parseTtl(ttl) {
	if (ttl === "never") return null;
	const m = /^([1-9][0-9]{0,5})([mhd])$/.exec(ttl);
	if (!m) throw new Error(`invalid --ttl: ${ttl} (like 90m, 12h, 30d, or never)`);
	return Number(m[1]) * { m: 60, h: 3600, d: 86_400 }[/** @type {"m" | "h" | "d"} */ (m[2])];
}

/** One line for a person or the agent: what a scope allows. @param {Scope} s @param {string} defaultHost */
export function describeScope(s, defaultHost) {
	const tools = Object.entries(s.tools).map(([t, a]) => (a === true ? t : `${t} (${a.join(", ")})`)).join(", ");
	const vms = [...s.vms.map((p) => `${p}`), "the VMs created with this token"].join(", ");
	return `tools: ${tools}; VMs: ${vms}; hosts: ${(s.hosts ?? [defaultHost]).join(", ")}${s.admin ? "; admin" : ""}`;
}

// ---------------------------------------------------------------- store

/** @type {{ key: string, entries: TokenEntry[] } | null} */
let cache = null;
/** Every entry, as the file is now ([] when there is none). Throws on a file that isn't a token store. @returns {TokenEntry[]} */
export function readStore(file = storeFile()) {
	let st;
	try { st = statSync(file, { bigint: true }); } catch { cache = null; return []; }
	const key = `${file}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
	if (cache?.key !== key) {
		const j = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(j?.tokens)) throw new Error(`${file} is not a boxery MCP token store`);
		cache = { key, entries: j.tokens };
	}
	return cache.entries;
}

/** Change the store under its lock (one writer at a time; readers see the old or the new file whole).
 *  @template T @param {(entries: TokenEntry[]) => T} change @returns {T} */
export function editStore(change, file = storeFile()) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	let fd;
	for (let i = 0; ; i++) {
		try { fd = openSync(lock, "wx", 0o600); break; }
		catch (e) {
			if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
			// A lock older than 30 s belongs to a process that died holding it.
			try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true }); } catch { /* gone */ }
			if (i >= 200) throw new Error(`${lock} is held; retry`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		const entries = structuredClone(readStore(file));
		const out = change(entries);
		writeAtomic(file, `${JSON.stringify({ tokens: entries }, null, 1)}\n`, { mode: 0o600 });
		return out;
	} finally {
		closeSync(fd);
		rmSync(lock, { force: true });
	}
}

/**
 * A new token LABEL with SCOPE. Returns the secret (shown once; only its hash is kept).
 * @param {string} label @param {Scope} scope @param {{ ttl?: number | null, now?: number }} [opts] @returns {{ secret: string, entry: TokenEntry }}
 */
export function createToken(label, scope, { ttl = 30 * 86_400, now = Math.floor(Date.now() / 1000) } = {}, file = storeFile()) {
	if (!VALID_LABEL.test(label)) throw new Error(`invalid label: ${label} (lowercase letters, digits, . _ -)`);
	const secret = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	const entry = { id: randomBytes(8).toString("hex"), label, hash: sha(secret), created: now, expires: ttl == null ? null : now + ttl, scope, owned: [] };
	editStore((entries) => {
		if (entries.some((e) => e.label === label)) throw new Error(`a token labelled ${label} exists; remove it first (boxery mcp-token rm ${label})`);
		entries.push(entry);
	}, file);
	return { secret, entry };
}

/** Remove token LABEL. Returns whether it existed. @param {string} label */
export const removeToken = (label, file = storeFile()) => editStore((entries) => {
	const i = entries.findIndex((e) => e.label === label);
	if (i >= 0) entries.splice(i, 1);
	return i >= 0;
}, file);

/**
 * The entry SECRET belongs to: {entry} if it's valid now, {expired: label} if it was, null otherwise.
 * Looked up by hash: comparing hashes of a 256-bit secret leaks nothing useful through timing.
 * @param {unknown} secret @returns {{ entry: TokenEntry } | { expired: string } | null}
 */
export function verifyToken(secret, { now = Math.floor(Date.now() / 1000) } = {}, file = storeFile()) {
	if (typeof secret !== "string" || !secret.startsWith(TOKEN_PREFIX)) return null;
	const h = sha(secret);
	let entries;
	try { entries = readStore(file); } catch { return null; } // a broken store refuses everyone
	const entry = entries.find((e) => e.hash === h);
	if (!entry) return null;
	return entry.expires != null && entry.expires <= now ? { expired: entry.label } : { entry };
}

/** The current entry with ID (null once removed). @param {string} id */
export function tokenById(id, file = storeFile()) {
	try { return readStore(file).find((e) => e.id === id) ?? null; } catch { return null; }
}

/** Record VMs created through token ID (replacing older records of the same host and name).
 *  @param {string} id @param {Owned[]} vms */
export const recordOwned = (id, vms, file = storeFile()) => editStore((entries) => {
	const e = entries.find((t) => t.id === id);
	if (!e) return;
	e.owned = [...e.owned.filter((o) => !vms.some((v) => v.host === o.host && v.vm === o.vm)), ...vms];
}, file);
