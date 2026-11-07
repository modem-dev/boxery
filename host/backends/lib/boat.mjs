// boat.dev's REST API for host/backends/boat.sh: requests, replies, pagination and polling, in Node (no jq).
// boat.sh keeps the backend contract, ssh and the tunnels (lib/remote.sh), and calls this as
//   node boat.mjs COMMAND ARG…   (settings in BOXERY_BOAT_*; the API key in BOAT_API_KEY or $BOAT_DIR/api-key)
// Results on stdout (one value per line, or TSV), diagnostics on stderr as `boxery-host: …`, exit 1 on
// failure. curl sends the requests, as before: it honours the user's proxy settings (Node's fetch doesn't by
// default), and the key and body go to it as a config on its stdin (-K -), never its command line or disk.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
const DIR = env.BOXERY_BOAT_DIR || path.join(env.HOME ?? "", ".local/share/boxery/boat");
const PREFIX = env.BOXERY_BOAT_PREFIX || "";
const API = env.BOXERY_BOAT_API || "https://boat.dev/api/v1";
const ORG = env.BOXERY_BOAT_ORG || "";
const TTL = env.BOXERY_BOAT_TTL || "";
/** A whole-number setting, like ${VAR:-default}: empty counts as unset; anything else that isn't one is an error.
 *  @param {string} name @param {number} def */
const whole = (name, def) => { const v = env[name]; if (!v) return def; if (!/^[0-9]+$/.test(v)) throw new Error(`${name} must be a whole number`); return Number(v); };
let POLL = 5, TRIES = 180, RETRIES = 5;
const STATES = "init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error";

class Fail extends Error {}
/** @param {string} message @returns {never} */
const fail = (message) => { throw new Fail(message); };
const sleep = (/** @type {number} */ s) => new Promise((r) => setTimeout(r, s * 1000));

function apiKey() {
	if (env.BOAT_API_KEY) return env.BOAT_API_KEY;
	const f = path.join(DIR, "api-key");
	if (!existsSync(f) || !readFileSync(f, "utf8").trim()) fail("no boat API key: set BOAT_API_KEY and run boxery-host init --backend boat");
	return readFileSync(f, "utf8").trim();
}

/** A value for a curl config file: "…", with \\ and \" escaped (JSON text has no raw newlines). @param {string} v */
const cfgValue = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

/** One HTTP request through curl: {code, body, local}. local: curl itself failed (not boat): code "000".
 *  The key and the body reach curl as a config on its stdin (-K -): never on its command line or on disk.
 *  @param {string} method @param {string} p @param {string} body @param {string} header @param {string} key
 *  @returns {Promise<{ code: string, body: string, local?: boolean }>} */
function curl(method, p, body, header, key) {
	return new Promise((resolve) => {
		const args = ["-sS", "--max-time", "120", "-X", method, "-H", "Accept: application/json", "-w", "\n%{http_code}"];
		if (ORG) args.push("-H", `X-Boat-Org: ${ORG}`);
		if (header) args.push("-H", header);
		if (body) args.push("-H", "Content-Type: application/json");
		args.push("-K", "-", `${API}${p}`);
		const config = `header = ${cfgValue(`Authorization: Bearer ${key}`)}\n${body ? `data-binary = ${cfgValue(body)}\n` : ""}`;
		const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", (e) => resolve({ code: "000", body: `cannot run curl: ${e.message}`, local: true }));
		child.on("close", (code) => {
			const i = out.lastIndexOf("\n"), status = out.slice(i + 1).trim(), reply = i < 0 ? "" : out.slice(0, i);
			if (code !== 0) return resolve({ code: "000", body: (err || reply).trim() });
			resolve({ code: status, body: reply });
		});
		child.stdin?.on("error", () => {}); child.stdin?.end(config);
	});
}

/**
 * METHOD PATH [BODY [HEADER]] → the reply's JSON. Fails (with boat's message) on HTTP ≥ 400 or {"ok": false}.
 * Retries what boat says is safe to retry: 429 rate_limited and 503 (nothing was created), and 5xx on GET/DELETE.
 * @param {string} method @param {string} p @param {unknown} [body] @param {string} [header] @returns {Promise<any>}
 */
export async function api(method, p, body, header = "") {
	const key = apiKey();
	const text = body === undefined || body === "" ? "" : typeof body === "string" ? body : JSON.stringify(body);
	for (let attempt = 1; ; attempt++) {
		const { code, body: out, local } = await curl(method, p, text, header, key);
		if (local) fail(out); // (curl couldn't run: retrying won't help)
		/** @type {any} */
		let j = null, json = true;
		try { j = out.trim() ? JSON.parse(out) : {}; } catch { json = false; }
		// A 2xx that isn't boat's JSON (a login page, a proxy, a wrong BOXERY_BOAT_API) is a failure, not {}.
		if (/^2\d\d$/.test(code) && json && !(j && typeof j === "object" && j.ok === false)) return j ?? {};
		const c = j?.code ?? j?.error?.code ?? "error", m = j?.message ?? j?.error?.message ?? "";
		const msg = json && j ? `${c}: ${m}` : `not boat's JSON: ${out.replace(/\s+/g, " ").slice(0, 200)}`;
		if (attempt < RETRIES) {
			const retry = (code === "429" && /^(rate_limited|IP_RATE_LIMIT)/.test(msg)) || code === "503" || (/^5\d\d$/.test(code) && ["GET", "DELETE"].includes(method)) || (code === "000" && method === "GET");
			if (retry) { await sleep(attempt * 2); continue; }
		}
		fail(`boat ${method} ${p}: HTTP ${code} ${msg}`);
	}
}

const plainId = (/** @type {unknown} */ s) => typeof s === "string" && /^bx_[A-Za-z0-9]+$/.test(s);

/** Every sandbox of this host (all states, every page). An unreachable API is an error, never an empty account. */
export async function sandboxes() {
	/** @type {any[]} */
	const all = [];
	let cursor = "";
	for (;;) {
		const page = await api("GET", `/sandboxes?namePrefix=${PREFIX}&state=${STATES}&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
		if (!Array.isArray(page?.sandboxes)) fail(`unexpected GET /sandboxes reply from boat: ${JSON.stringify(page).slice(0, 200)}`);
		// The name filter is the API's; checked again here: only this host's sandboxes are ever touched.
		all.push(...page.sandboxes.filter((/** @type {any} */ s) => typeof s?.name === "string" && s.name.startsWith(PREFIX)));
		cursor = page.pageInfo?.nextCursor ?? "";
		if (typeof cursor !== "string" || !/^[A-Za-z0-9._~=-]+$/.test(cursor)) break;
	}
	return all;
}
/** The ids of sandboxes named NAME exactly (PREFIX + role/name). @param {string} name */
const idsNamed = async (name) => (await sandboxes()).filter((s) => s.name === name).map((s) => s.id).filter(plainId);
/** @param {string} id */
const sandbox = async (id) => { const r = await api("GET", `/sandboxes/${id}`); return r?.sandbox ?? r; };
/** @param {string} id */
const stateOf = async (id) => String((await sandbox(id))?.state ?? "");
/** This account's saved snapshots. A reply without the list is an error (an unknown answer, never "none").
 *  @returns {Promise<any[]>} */
const saved = async () => {
	const r = await api("GET", "/saved-snapshots");
	if (!Array.isArray(r?.snapshots)) fail(`unexpected GET /saved-snapshots reply from boat: ${JSON.stringify(r).slice(0, 200)}`);
	return r.snapshots;
};
/** @param {string} name */
const savedStatus = async (name) => String((await saved()).find((s) => s?.name === name)?.status ?? "");

/** Poll until sandbox ID runs commands (ready, idle, running). Fails on error, or when it stops. @param {string} id */
async function waitReady(id) {
	for (let i = 1; i <= TRIES; i++) {
		const st = await stateOf(id).catch(() => "");
		if (["ready", "idle", "running"].includes(st)) return;
		if (["error", "archived"].includes(st)) fail(`boat sandbox ${id} is ${st}`);
		await sleep(POLL);
	}
	fail(`timed out waiting for boat sandbox ${id} to start`);
}
/** @param {string} id */
async function waitStopped(id) {
	for (let i = 1; i <= TRIES; i++) {
		if (await stateOf(id).catch(() => "") === "archived") return;
		await sleep(POLL);
	}
	fail(`timed out waiting for boat sandbox ${id} to stop`);
}
/** Save sandbox ID as saved snapshot NAME and wait until it's ready. A failed save is removed. @param {string} id @param {string} name */
async function save(id, name) {
	await api("POST", "/saved-snapshots", { sandboxId: id, name });
	let st = "";
	for (let i = 1; i <= TRIES; i++) {
		const r = await api("GET", `/saved-snapshots/${name}`).catch(() => null);
		st = String(r?.snapshot?.status ?? r?.status ?? "");
		if (st === "ready") return;
		if (st === "failed") break;
		await sleep(POLL);
	}
	await api("DELETE", `/saved-snapshots/${name}`).catch(() => {});
	fail(`saving snapshot ${name} failed (${st || "timed out"})`);
}
const ttl = () => (TTL ? (/^[1-9][0-9]{0,6}$/.test(TTL) ? Number(TTL) : fail("BOXERY_BOAT_TTL must be a number of seconds (or empty: no auto-stop)")) : null);

/** POST /sandboxes as a boxery sandbox: named, no auto-stop unless BOXERY_BOAT_TTL, no account environment.
 *  The labels are informational (boat keeps them only on sandboxes not created from a saved snapshot).
 *  @param {string} role @param {string} name @param {string} type @param {string} [from] */
async function create(role, name, type, from = "") {
	const body = {
		type, ttlSeconds: ttl(), noEnv: true,
		name: role === "vm" ? `${PREFIX}vm-${name}` : `${PREFIX}${role}`,
		labels: { "boxery.host": PREFIX, "boxery.role": role, ...(role === "vm" ? { "boxery.vm": name } : {}) },
		...(from ? { from } : {}),
	};
	const r = await api("POST", "/sandboxes", body, `Idempotency-Key: boxery-${randomBytes(16).toString("hex")}`);
	const id = r?.sandbox?.id ?? r?.id;
	if (!plainId(id)) fail(`unexpected POST /sandboxes reply from boat: ${JSON.stringify(r).slice(0, 200)}`);
	return id;
}

/** Authorize KEYFILE's key on sandbox ID (running) and pin its address and host key in DIR: dest ("HOST PORT
 *  USER") and known_hosts. Only plain values: these become ssh arguments and a known_hosts line.
 *  @param {string} dir @param {string} id @param {string} keyFile */
async function sshKey(dir, id, keyFile) {
	const r = await api("POST", `/sandboxes/${id}/sshkey`, { key: readFileSync(keyFile, "utf8").trim() });
	const plain = (/** @type {unknown} */ s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(s);
	let h = "", p = "";
	if (plain(r?.sshEndpoint)) { const m = /^(.+):([0-9]{1,5})$/.exec(r.sshEndpoint); if (m) [h, p] = [m[1], m[2]]; }
	else { h = r?.machineIp ?? ""; p = "22"; }
	const u = plain(r?.sshUser) ? r.sshUser : "user";
	const k = typeof r?.hostKey === "string" && /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+$/.test(r.hostKey) ? r.hostKey : "";
	if (!plain(h) || !/^[0-9]+$/.test(p) || !k) fail(`boat sshkey for ${id}: no usable address or host key: ${JSON.stringify(r).slice(0, 200)}`);
	writeFileSync(path.join(dir, "known_hosts"), `${id} ${k}\n`);
	writeFileSync(path.join(dir, "dest"), `${h} ${p} ${u}\n`);
}

/** backend_list's part from boat: NAME<TAB>STATE<TAB>DISK_BYTES per VM (states in boxery's words; a
 *  reimage's leftover sandbox skipped; disk: the boat type's, from the VM's recorded size). */
async function list() {
	const re = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}vm-([a-z][a-z0-9-]*)$`);
	const rows = [];
	for (const s of await sandboxes()) {
		const n = re.exec(s.name)?.[1];
		if (!n) continue;
		const d = path.join(DIR, "vms", n);
		const cur = existsSync(path.join(d, "id")) ? readFileSync(path.join(d, "id"), "utf8").trim() : null;
		if (cur != null && cur !== s.id) continue;
		let disk = "";
		try { const k = readFileSync(path.join(d, "size"), "utf8").trim().split(/\s+/)[2]; if (/^[0-9]+$/.test(k)) disk = String(Number(k) * 1073741824); } catch { /* unknown */ }
		// (Only a plain word reaches the TSV: a state with a tab or newline would make a row of its own.)
		const st = /^[a-z_-]{1,32}$/.test(String(s.state ?? "")) ? String(s.state) : "unknown";
		const state = ["ready", "idle", "running"].includes(st) ? "running" : st === "archived" ? "shut off" : st === "archiving" ? "stopping" : /^(init|cloning|provision.*)$/.test(st) ? "starting" : st;
		rows.push(`${n}\t${state}\t${disk}`);
	}
	return rows.join("\n");
}

/** backend_images: IMAGE<TAB>CREATED<TAB>SIZE for this host's ready saved snapshots with a local record. */
async function images() {
	const rows = [];
	for (const s of await saved()) {
		if (typeof s?.name !== "string" || !s.name.startsWith(`${PREFIX}i-`) || s.status !== "ready") continue;
		const f = path.join(DIR, "images", s.name);
		if (!existsSync(f)) continue;
		const [image = "", k = ""] = readFileSync(f, "utf8").replace(/\n$/, "").split("\t");
		const created = String(s.createdAt ?? "").slice(0, 19).replace(/[^0-9A-Za-z:.+-]/g, "");
		rows.push(`${image}\t${created}\t${/^[0-9]{1,5}$/.test(k) ? `${k}GiB` : ""}`);
	}
	return rows.join("\n");
}

/** @type {Record<string, (...a: string[]) => Promise<unknown>>} */
const COMMANDS = {
	// GET /me: the key works (backend_check).
	check: async () => { const r = await api("GET", "/me"); if (!r || typeof r !== "object" || Array.isArray(r) || !Object.keys(r).length) fail(`unexpected GET /me reply from boat: ${JSON.stringify(r).slice(0, 200)}`); },
	"ids-named": async (name) => (await idsNamed(name)).join("\n"),
	"vm-ids": async (name) => (await idsNamed(`${PREFIX}vm-${name}`)).join("\n"),
	state: stateOf,
	delete: async (id) => { await api("DELETE", `/sandboxes/${id}`, "", `X-Ascii-Confirm-Delete: ${id}`); },
	"wait-ready": waitReady,
	"wait-stopped": waitStopped,
	stop: async (id) => { await api("POST", `/sandboxes/${id}/stop`, {}); },
	// resume ID [TYPE]: boat changes types on resume only.
	resume: async (id, type = "") => { await api("POST", `/sandboxes/${id}/resume`, { ttlSeconds: ttl(), ...(type ? { type } : {}) }); },
	create,
	save,
	"saved-status": savedStatus,
	"saved-rm": async (name) => { await api("DELETE", `/saved-snapshots/${name}`); },
	// has-base NAME: exit 0 ready, 1 not, 2 couldn't tell (the API failed).
	"has-base": async (name) => { process.exitCode = (await savedStatus(name)) === "ready" ? 0 : 1; },
	sshkey: sshKey,
	list,
	images,
	// api METHOD PATH [BODY [HEADER]] → the reply's JSON (tests and debugging).
	api: async (method, p, body = "", header = "") => JSON.stringify(await api(method, p, body, header)),
};

const [command = "", ...args] = process.argv.slice(2);
try {
	POLL = whole("BOXERY_BOAT_POLL", 5); TRIES = whole("BOXERY_BOAT_TRIES", 180); RETRIES = whole("BOXERY_BOAT_RETRIES", 5);
	if (!Object.hasOwn(COMMANDS, command)) fail(`boat.mjs: unknown command ${command}`);
	const out = await COMMANDS[command](...args);
	if (typeof out === "string" && out) process.stdout.write(`${out}\n`);
} catch (e) {
	process.stderr.write(`boxery-host: ${/** @type {Error} */ (e).message}\n`);
	process.exitCode = command === "has-base" ? 2 : 1;
}
