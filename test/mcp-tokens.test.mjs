// Scoped MCP tokens (#3): the store and scope rules (core/mcp-tokens.mjs), and the guards that keep every
// place boxery acts behind core/mcp-auth.mjs. The HTTP server's use of them is in test/mcp.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { INFO_ACTIONS, LEASE_ACTIONS, MANAGE_ACTIONS, TOOLS, toolCatalog } from "../core/boxery-tools.mjs";
import { HOST_COMMANDS as GUARDED, PLATFORM_KEY_BACKENDS } from "../core/mcp-auth.mjs";
import { ADMIN_ACTIONS, createToken, keyHash, matches, parseTtl, readStore, recordOwned, removeToken, toolAllowed, toolsScope, verifyToken, vmPatterns } from "../core/mcp-tokens.mjs";
import { HOST_COMMANDS } from "../host/help.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const dir = mkdtempSync(path.join(tmpdir(), "boxery-mcp-tokens-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const store = path.join(dir, "mcp-tokens.json");
const all = toolsScope(toolCatalog());
/** @param {Partial<import("../core/mcp-tokens.mjs").Scope>} s */
const scope = (s = {}) => ({ tools: all, hosts: null, vms: [], admin: false, ...s });

test("a token is shown once and stored hashed, 0600; verify finds it, refuses others, reports expiry", () => {
	const { secret, entry } = createToken("ci", scope(), {}, store);
	assert.match(secret, /^bxm_[A-Za-z0-9_-]{43}$/);
	const text = readFileSync(store, "utf8");
	assert.ok(!text.includes(secret.slice(4)), "the secret itself is never written");
	assert.equal(statSync(store).mode & 0o777, 0o600);
	assert.equal(/** @type {any} */ (verifyToken(secret, {}, store)).entry.id, entry.id);
	for (const bad of [`${secret}x`, secret.slice(0, -1), "bxm_", "", null, 42, secret.replace("bxm_", "")]) assert.equal(verifyToken(bad, {}, store), null, String(bad));
	const old = createToken("old", scope(), { ttl: 60, now: 1000 }, store);
	assert.deepEqual(verifyToken(old.secret, {}, store), { expired: "old" });
	assert.equal(createToken("never", scope(), { ttl: null }, store).entry.expires, null);
	assert.throws(() => createToken("ci", scope(), {}, store), /a token labelled ci exists/);
	assert.throws(() => createToken("Bad Label", scope(), {}, store), /invalid label/);
});

test("rm takes effect at the next verify (the store is re-read when it changes)", () => {
	const { secret } = createToken("gone", scope(), {}, store);
	assert.ok(verifyToken(secret, {}, store));
	assert.equal(removeToken("gone", store), true);
	assert.equal(verifyToken(secret, {}, store), null);
	assert.equal(removeToken("gone", store), false);
});

test("a store that isn't one refuses everyone instead of failing open", () => {
	const broken = path.join(dir, "broken.json");
	writeFileSync(broken, '{"tokens": "nope"}');
	assert.throws(() => readStore(broken), /not a boxery MCP token store/);
	assert.equal(verifyToken("bxm_x", {}, broken), null);
});

test("owned VMs: recorded per host and name, replacing an older record of the same VM", () => {
	const { entry } = createToken("owner", scope(), {}, store);
	recordOwned(entry.id, [{ host: "h", vm: "a", key: "k1" }], store);
	recordOwned(entry.id, [{ host: "h", vm: "a", key: "k2" }, { host: "h2", vm: "a", key: null }], store);
	assert.deepEqual(readStore(store).find((e) => e.id === entry.id)?.owned, [{ host: "h", vm: "a", key: "k2" }, { host: "h2", vm: "a", key: null }]);
	assert.equal(keyHash("demo.boxery ssh-ed25519 AAAAC3 \n"), keyHash("ssh-ed25519   AAAAC3"), "the key, not the host label or spacing");
});

test("tools are denied by default; admin actions need --admin even when the tool is allowed", () => {
	const s = scope({ tools: toolsScope(toolCatalog(), { tools: "vm_bash,vm_manage:new,vm_manage:build-base,vm_lease" }) });
	assert.equal(toolAllowed(s, "vm_bash", null), true);
	assert.equal(toolAllowed(s, "vm_read", null), false);
	assert.equal(toolAllowed(s, "vm_manage", "new"), true);
	assert.equal(toolAllowed(s, "vm_manage", "rm"), false);
	assert.equal(toolAllowed(s, "vm_manage", "build-base"), false, "admin action without --admin");
	assert.equal(toolAllowed(s, "vm_lease", "acquire"), false);
	assert.equal(toolAllowed({ ...s, admin: true }, "vm_manage", "build-base"), true);
	assert.equal(toolAllowed({ ...s, admin: true }, "vm_lease", "acquire"), true);
	const ro = toolsScope(toolCatalog(), { readOnly: true });
	assert.deepEqual(Object.keys(ro).sort(), ["vm_info", "vm_read", "vm_screenshot"]);
	for (const t of Object.keys(ro)) assert.equal(TOOLS.find((x) => x.name === t)?.annotations.readOnlyHint, true, `${t} is annotated read-only`);
	assert.throws(() => toolsScope(toolCatalog(), { tools: "vm_nope" }), /unknown tool/);
	assert.throws(() => toolsScope(toolCatalog(), { tools: "vm_bash:x" }), /vm_bash has no action x/);
	assert.throws(() => toolsScope(toolCatalog(), { tools: "vm_bash", readOnly: true }), /either --tools or --read-only/);
});

test("every admin action is a real action, and every action of every tool is either allowed or admin", () => {
	for (const [tool, actions] of Object.entries(ADMIN_ACTIONS)) for (const a of actions) assert.ok(toolCatalog()[tool]?.includes(a), `${tool} ${a}`);
	assert.deepEqual(toolCatalog().vm_manage, MANAGE_ACTIONS);
	assert.deepEqual(toolCatalog().vm_info, INFO_ACTIONS);
	assert.deepEqual(toolCatalog().vm_lease, LEASE_ACTIONS);
});

test("VM patterns: * is any run of characters, everything else literal", () => {
	assert.ok(matches("demo-*", "demo-1") && matches("demo-*", "demo-") && matches("*", "x") && matches("a", "a"));
	assert.ok(!matches("demo-*", "xdemo-1") && !matches("demo", "demo-1") && !matches("a-b", "axb"));
	assert.throws(() => vmPatterns(["../x"]), /invalid --vm pattern/);
	assert.throws(() => vmPatterns(["Demo"]), /invalid --vm pattern/);
	assert.equal(parseTtl("never"), null);
	assert.equal(parseTtl("90m"), 5400);
	assert.equal(parseTtl("2d"), 172_800);
	for (const bad of ["", "0d", "1y", "-1d", "1.5h"]) assert.throws(() => parseTtl(bad), /invalid --ttl/, bad);
});

test("the guarded host commands are real boxery-host commands", () => {
	for (const c of Object.keys(GUARDED)) assert.ok(Object.hasOwn(HOST_COMMANDS, c), `core/mcp-auth.mjs guards ${c}, which boxery-host doesn't have`);
});

test("the backends identified by name alone are exactly those that manage host keys themselves", () => {
	const declaring = readdirSync(path.join(ROOT, "host/backends")).filter((f) => f.endsWith(".sh") && /^\s*backend_platform_host_key\b|backend_platform_host_key\(\)/m.test(readFileSync(path.join(ROOT, "host/backends", f), "utf8"))).map((f) => f.slice(0, -3)).sort();
	assert.deepEqual([...PLATFORM_KEY_BACKENDS].sort(), declaring);
});

// Every place the core starts ssh to a VM or a host command, and what guards it. A new one fails here until it
// is checked by core/mcp-auth.mjs (or said here why it needs no check).
const SSH_SITES = {
	"core/boxery-core.mjs": { count: 2, guard: /await authorizeVm\(/g, why: "sshRun and vmProblem" },
	"core/grant-operations.mjs": { count: 1, guard: /await authorizeVm\(/g, why: "applyGrants" },
	"core/desktop.mjs": { count: 1, guard: /await authorizeVm\(/g, why: "the desktop tunnel" },
	"core/profile.mjs": { count: 2, guard: /await authorizeHostCommand\(/g, why: "hostRun (every host command); the other is ssh -O exit, which only closes a shared connection" },
	"core/copy-stream.mjs": { count: 0, guard: null, why: "its ssh carries no host context: copyTool checks both endpoints before streamCopy" },
	"core/sync.mjs": { count: 1, guard: /await authorizeVm\(/g, why: "git push over ssh" },
};
test("every ssh to a VM and every host command goes through core/mcp-auth.mjs", () => {
	for (const f of readdirSync(path.join(ROOT, "core")).filter((f) => f.endsWith(".mjs"))) {
		const text = readFileSync(path.join(ROOT, "core", f), "utf8");
		const n = (text.match(/(?:spawn|execFile)\("ssh"|spawn\(cmd, argv|GIT_SSH_COMMAND/g) ?? []).length;
		const site = /** @type {Record<string, { count: number, guard: RegExp | null }>} */ (SSH_SITES)[`core/${f}`];
		if (!site) { assert.equal(n, 0, `core/${f} starts ssh or a host command: guard it (core/mcp-auth.mjs) and list it in SSH_SITES`); continue; }
		assert.equal(n, site.count, `core/${f}: ssh/host command sites changed; check each is guarded and update SSH_SITES`);
		if (site.guard) assert.ok((text.match(site.guard) ?? []).length >= 1, `core/${f} has no ${site.guard} guard`);
	}
	const core = readFileSync(path.join(ROOT, "core/boxery-core.mjs"), "utf8");
	assert.match(core, /for \(const loc of \[src, dst\]\) if \(loc\.vm\) await authorizeVm\(loc\.host, loc\.vm\);\n[^\n]*\n?[^]*?streamCopy\(/, "copyTool checks both endpoints before streamCopy");
});

test("once enforced, an operation outside any grant is refused (fail closed); a scoped grant can't reach other VMs", () => {
	const home = mkdtempSync(path.join(tmpdir(), "boxery-mcp-auth-"));
	try {
		const { entry } = createToken("t", scope({ vms: ["mine-*"] }), {}, path.join(home, "mcp-tokens.json"));
		const script = `
			const auth = await import(${JSON.stringify(path.join(ROOT, "core/mcp-auth.mjs"))});
			const host = { name: "h", dir: "/nonexistent" };
			const out = [];
			const tryIt = async (label, fn) => { try { await fn(); out.push(label + ": ok"); } catch (e) { out.push(label + ": " + e.message); } };
			await tryIt("unscoped before enforce", () => auth.authorizeVm(host, "any"));
			auth.enforce();
			await tryIt("no grant", () => auth.authorizeVm(host, "any"));
			await tryIt("no grant, host command", () => auth.authorizeHostCommand(host, ["rm", "any"]));
			const g = { kind: "token", id: ${JSON.stringify(entry.id)}, label: "t", defaultHost: "h" };
			await auth.withGrant(g, async () => {
				await tryIt("pattern", () => auth.authorizeVm(host, "mine-1"));
				await tryIt("other VM", () => auth.authorizeVm(host, "theirs"));
				await tryIt("other host", () => auth.authorizeVm({ name: "h2", dir: "/x" }, "mine-1"));
				await tryIt("fork from other", () => auth.authorizeHostCommand(host, ["fork", "theirs", "mine-2"]));
				await tryIt("new from other's image", () => auth.authorizeHostCommand(host, ["new", "mine-3", "--from", "theirs@s1"]));
				await tryIt("new", () => auth.authorizeHostCommand(host, ["new", "mine-3"]));
				await tryIt("admin", () => auth.authorizeHostCommand(host, ["build-base"]));
				await tryIt("unknown command", () => auth.authorizeHostCommand(host, ["pool", "add", "mine-1"]));
				await tryIt("listing", () => auth.authorizeHostCommand(host, ["ls", "--json"]));
				out.push("visible: " + ["mine-1", "theirs"].filter((v) => auth.visibleVm("h", v)).join(","));
			});
			await auth.withGrant(auth.UNSCOPED, () => tryIt("legacy", () => auth.authorizeVm(host, "theirs")));
			console.log(out.join("\\n"));`;
		const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, BOXERY_HOME: home }, encoding: "utf8" });
		const refused = (/** @type {string} */ what) => new RegExp(`^${what}: .* is outside this token's scope \\(token 't'\\); ask the user`, "m");
		assert.match(out, /^unscoped before enforce: ok$/m, "stdio/pi/CLI: nothing changes until the HTTP server enforces");
		assert.match(out, /^no grant: boxery: refused: this operation has no MCP authorization context/m);
		assert.match(out, /^no grant, host command: boxery: refused/m);
		assert.match(out, /^pattern: ok$/m);
		for (const r of ["other VM", "other host", "fork from other", "new from other's image", "admin", "unknown command"]) assert.match(out, refused(r));
		assert.match(out, /^new: ok$/m);
		assert.match(out, /^listing: ok$/m);
		assert.match(out, /^visible: mine-1$/m);
		assert.match(out, /^legacy: ok$/m);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
