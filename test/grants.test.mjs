// Real CLI + controlling-terminal tests; all profiles, stores and transports are temporary.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { hostTransport } from "./fixtures/host-transport.mjs";
// Match canonical file-grant paths even when the OS temp directory is itself a symlink (macOS).
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "boxery-grant-test-")));
const profile = path.join(root, "profile"), bin = path.join(root, "bin");
mkdirSync(bin);
const registryRoot = path.join(root, "registry");
process.env.BOXERY_HOME = registryRoot;
registerHost(process.env.BOXERY_HOME, "local", profile);
hostTransport(root, [profile]);
const config = readFileSync(path.join(profile, "config"), "utf8");
const hostScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/host.calls'\ncase "$1" in edge-set) cat >/dev/null ;; ls) if [ "\${2:-}" = --json ]; then cat '${root}/inventory.json'; else cat '${root}/inventory.txt'; fi ;; esac\nexit 0\n`;
writeFileSync(path.join(root, "grant-host"), hostScript);
writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do [ "$a" != -O ] || exit 0; done\ncat > '${root}/apply.script'\n`);
chmodSync(path.join(bin, "ssh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const core = await import("../core/boxery-core.mjs");
const grants = await import("../core/grants.mjs");
const cli = path.resolve(import.meta.dirname, "../controller/boxery");
const store = path.join(profile, "grants/demo");
/** @param {string[]} args @param {string} [input] @param {NodeJS.ProcessEnv} [extra] */
function headless(args, input = "", extra = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(cli, args, { env: { ...process.env, ...extra }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		let output = "", stdout = "", stderr = "";
		p.stdout.on("data", (d) => { stdout += d; output += d; }); p.stderr.on("data", (d) => { stderr += d; output += d; });
		p.on("error", reject); p.on("close", (code) => resolve({ code, output, stdout, stderr }));
		p.stdin.on("error", () => {}); p.stdin.end(input);
	});
}
/** @param {string[]} args @param {string} answer */
function terminal(args, answer) {
	return JSON.parse(execFileSync("python3", [path.join(import.meta.dirname, "fixtures/grant-pty.py"), answer, cli, ...args], { env: process.env, encoding: "utf8", timeout: 20_000 }));
}
beforeEach(() => {
	rmSync(store, { force: true });
	writeFileSync(path.join(profile, "config"), config);
	writeFileSync(path.join(profile, "ssh_config"), "# fixture\n");
	writeFileSync(path.join(root, "grant-host"), hostScript);
	writeFileSync(path.join(registryRoot, "host-registry/local"), `${profile}\n`);
	writeFileSync(path.join(root, "inventory.json"), '[\n{"name":"demo"}\n]\n');
	writeFileSync(path.join(root, "inventory.txt"), 'NAME STATE\ndemo running\n');
	rmSync(path.join(root, "host.calls"), { force: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("CLI without a controlling TTY refuses, including y on stdin and inherited opt-outs", async () => {
	for (const input of ["", "y\n", "yes\nyes\n"]) {
		const r = await headless(["grant", "demo", "ssh-agent"], input, { GRANT_CONFIRM: "off", BOXERY_ASSUME_YES: "1" });
		assert.notEqual(r.code, 0);
		assert.match(r.output, /grants need a person[\s\S]*vm_grant[\s\S]*boxery --host local grant demo ssh-agent/);
		assert.equal(existsSync(store), false);
	}
});

test("agent-forward on, creation grants and fork --grants also refuse without a person", async () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	for (const args of [["agent-forward", "demo", "on"], ["new", "demo", "--grant", "ssh-agent"], ["new", "demo", "--agent-forward"], ["fork", "source", "demo", "--grants"]]) {
		const r = await headless(args, "y\n");
		assert.notEqual(r.code, 0, args.join(" "));
		assert.match(r.output, /grants need a person/);
		assert.equal(existsSync(store), false);
		assert.equal(existsSync(path.join(root, "host.calls")), false, "no VM is created before approval");
	}
});

test("real PTY: No and empty answer decline; Yes applies; CLI and vm_grant share exact prompt text", async () => {
	for (const answer of ["n", ""]) {
		const no = terminal(["grant", "demo", "ssh-agent"], answer);
		assert.notEqual(no.code, 0); assert.equal(existsSync(store), false);
	}
	const yes = terminal(["grant", "demo", "ssh-agent"], "y");
	assert.equal(yes.code, 0, yes.output);
	assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/m);
	rmSync(store);
	let prompt = "";
	await core.grantRequest("demo", { spec: "ssh-agent" }, { approve: async (text) => { prompt = text; return "decline"; } });
	assert.equal(yes.output.slice(0, yes.output.indexOf("\n\nAllow access?")), prompt);
	assert.equal(existsSync(store), false);
});

test("real PTY: Ctrl-C at the approval prompt ends the command at once; the terminal status says blocked, not working", () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	process.env.BOXERY_STATUS = "1";
	try {
		for (const args of [["new", "demo", "--grant", "ssh-agent"], ["fork", "source", "demo", "--grants"]]) {
			// (The fixture would raise after 15 s if Ctrl-C only ran a handler once the blocking read returned.)
			const r = terminal(args, "\x03");
			assert.ok(r.code < 0, `${args[0]}: ended by the signal, not exit ${r.code}\n${r.output}`);
			assert.match(r.output, /\x1b\]7501;state=working:app=boxery:msg=[A-Za-z0-9+/=]+\x1b\\[\s\S]*\x1b\]7501;state=blocked:kind=permission:app=boxery:msg=/);
			assert.equal(existsSync(path.join(root, "host.calls")), false, "nothing was created");
		}
	} finally { delete process.env.BOXERY_STATUS; }
});

test("real PTY: creation and fork grants ask before lifecycle effects", () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	for (const args of [["new", "demo", "--grant", "ssh-agent"], ["new", "demo", "--agent-forward"], ["fork", "source", "demo", "--grants"]]) {
		const no = terminal(args, "n");
		assert.notEqual(no.code, 0);
		assert.equal(existsSync(path.join(root, "host.calls")), false);
		assert.equal(existsSync(store), false);
		const yes = terminal(args, "yes");
		assert.equal(yes.code, 0, yes.output);
		assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/m);
		assert.match(readFileSync(path.join(root, "host.calls"), "utf8"), /^(new demo|fork source demo)/);
		rmSync(store); rmSync(path.join(root, "host.calls"));
	}
});

test("invalid spec in a batch is rejected before any grant or prompt", async () => {
	const r = await headless(["grant", "demo", "ssh-agent", "env:1BAD"]);
	assert.notEqual(r.code, 0);
	assert.doesNotMatch(r.output, /grants need a person/);
	assert.equal(existsSync(store), false);
});

test("vm_grant approval applies in-process; decline changes nothing; no CLI spawn even for listing", async () => {
	process.env.GRANT_TEST_VALUE = "secret value";
	const a = { spec: "env:GRANT_TEST_VALUE", reason: "test" };
	const no = await core.grantRequest("demo", a, { approve: async () => "decline" });
	assert.match(no.text, /declined/); assert.equal(existsSync(store), false);
	const yes = await core.grantRequest("demo", a, { approve: async () => "accept" });
	assert.match(yes.text, /The user approved/);
	assert.match(readFileSync(store, "utf8"), /^env\tGRANT_TEST_VALUE\t/m);
	assert.match(readFileSync(path.join(root, "apply.script"), "utf8"), /put_env 'GRANT_TEST_VALUE' /);
	const before = readFileSync(store, "utf8");
	await core.grantRequest("demo", { spec: "ssh-agent" }, { approve: async () => "decline" });
	assert.equal(readFileSync(store, "utf8"), before);
});

test("both paths enforce deny directories, aliases and BOXERY_* variables, even with config opt-out", async () => {
	writeFileSync(path.join(profile, "secret"), "private");
	const link = path.join(root, "alias"); symlinkSync(path.join(profile, "secret"), link);
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	for (const spec of [`file:${profile}/secret`, `file:${link}`, "env:BOXERY_MCP_TOKEN"]) {
		const r = await headless(["grant", "demo", spec]);
		assert.notEqual(r.code, 0); assert.doesNotMatch(r.output, /grants need a person/);
		await assert.rejects(core.grantRequest("demo", { spec }, { approve: async () => { throw new Error("must not prompt"); } }), /can't be (granted|requested)/);
	}
	assert.equal(existsSync(store), false);
});

test("CLI and tool file grants canonicalize parent-directory aliases", async () => {
	const source = path.join(root, "grant-source"), alias = path.join(root, "grant-directory-alias");
	mkdirSync(source); symlinkSync(source, alias);
	const real = path.join(source, "dev.env"), requested = path.join(alias, "dev.env");
	writeFileSync(real, "A=1\n");
	const parsed = core.parseGrantRequest({ spec: `file:${requested}` });
	assert.equal(parsed.local, real);
	assert.equal(parsed.requested, requested);
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	const applied = await headless(["grant", "demo", `file:${requested}`]);
	assert.equal(applied.code, 0, applied.output);
	assert.equal(readFileSync(store, "utf8"), `file\t${real}\tproject/dev.env\n`);
});

test("a requested symlink stays pinned to the approved real path", async () => {
	const first = path.join(root, "first.env"), second = path.join(root, "second.env"), alias = path.join(root, "dev-link");
	writeFileSync(first, "FIRST"); writeFileSync(second, "SECOND"); symlinkSync(first, alias);
	await core.grantRequest("demo", { spec: `file:${alias}` }, { approve: async () => { rmSync(alias); symlinkSync(second, alias); return "accept"; } });
	assert.match(readFileSync(store, "utf8"), new RegExp(`file\\t${first}\\tproject/dev-link`));
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("FIRST").toString("base64")));
});

test("file-only automation opt-out; list/apply/revoke need no confirmation", async () => {
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	assert.equal((await headless(["grant", "demo", "ssh-agent"])).code, 0);
	writeFileSync(path.join(profile, "config"), config);
	for (const args of [["grants", "demo"], ["grants", "demo", "--json"], ["grants", "demo", "apply"], ["agent-forward", "demo", "off"], ["revoke", "demo", "all"]]) {
		const r = await headless(args);
		assert.equal(r.code, 0, r.output); assert.doesNotMatch(r.output, /Allow access|grants need a person/);
	}
});

test("pinned --profile-dir keeps listing and reapplying after the registry changes or is removed", async () => {
	const registry = path.join(registryRoot, "host-registry/local");
	const other = path.join(root, "moved-profile");
	mkdirSync(other, { recursive: true });
	hostTransport(root, [other]);
	writeFileSync(path.join(other, "ssh_config"), "# other profile\n");
	writeFileSync(path.join(root, "grant-host"), hostScript);
	writeFileSync(path.join(other, "grants/demo"), "env\tOTHER_PROFILE\t\n");
	writeFileSync(store, "env\tPINNED_PROFILE\t\n");
	process.env.PINNED_PROFILE = "original-profile";
	for (const moved of [true, false]) {
		if (moved) writeFileSync(registry, `${other}\n`); else rmSync(registry);
		const prefix = ["--host", "local", "--profile-dir", profile];
		const listed = await headless([...prefix, "ls", "--json"]);
		assert.equal(listed.code, 0, listed.output);
		assert.equal(JSON.parse(listed.stdout)[0].grants[0].var, "PINNED_PROFILE");
		const denied = await headless([...prefix, "grant", "demo", `file:${profile}/config`]);
		assert.notEqual(denied.code, 0);
		assert.match(denied.output, /can't be granted/);
		const applied = await headless([...prefix, "grants", "demo", "apply"]);
		assert.equal(applied.code, 0, applied.output);
		assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("original-profile").toString("base64")));
	}
});

test("ls --json fails without emitting malformed JSON if grant lookup fails", async () => {
	writeFileSync(store, "unknown-kind\t\t\n");
	const r = await headless(["ls", "--json"]);
	assert.notEqual(r.code, 0);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /unknown stored grant kind/);
	const noNode = path.join(root, "no-node"); mkdirSync(noNode);
	writeFileSync(path.join(noNode, "node"), '#!/bin/sh\nexit 17\n'); chmodSync(path.join(noNode, "node"), 0o755);
	const missing = await headless(["ls", "--json"], "", { PATH: `${noNode}:${process.env.PATH}` });
	assert.equal(missing.code, 17); assert.equal(missing.stdout, "");
});

test("text ls is drawn from ls --json: grants, pool leases and outdated guests in STATUS; --running filters", async () => {
	writeFileSync(store, "env\tSHOWN\t\n");
	writeFileSync(path.join(root, "inventory.json"), `[
{"name":"demo","state":"running","ssh_addr":"10.0.0.2:22","disk_size":40,"disk_used":1.25,"shape":"standard","desktop":true,"guest":{"status":"current","checked_at":1}},
{"name":"pool1","state":"shut off","desktop":false,"lease":{"state":"free"},"guest":{"status":"outdated","reasons":["layers changed"]}},
{"name":"pool2","state":"running","lease":{"state":"leased","holder":"ben@mac","expires_at":${Math.floor(Date.now() / 1000) + 7300}},"guest":{"status":"current"}}
]\n`);
	const r = await headless(["ls"]);
	assert.equal(r.code, 0, r.output);
	assert.match(r.stdout, /^NAME +STATE +SSH +DISK +SHAPE +KIND +STATUS\n/);
	assert.match(r.stdout, /^demo +running +10\.0\.0\.2:22 +1\.3\/40GiB +standard +desktop +grants env:SHOWN$/m);
	assert.match(r.stdout, /^pool1 +shut off +- +- +- +headless +pool free; outdated guest \(layers changed\)$/m);
	assert.match(r.stdout, /^pool2 +running .* leased by ben@mac, 2h left$/m);
	assert.match(r.stderr, /guest software not checked yet: pool2 \(ls --refresh reads it\)/);
	assert.match(r.stderr, /outdated guest software on pool1; update with: boxery patch NAME\|--all/);
	const running = await headless(["ls", "--running"]);
	assert.equal(running.code, 0, running.output);
	assert.doesNotMatch(running.stdout, /pool1/);
	assert.match(running.stdout, /^pool2 /m);
	const json = await headless(["ls", "--json", "--running"]);
	assert.deepEqual(JSON.parse(json.stdout).map((/** @type {{ name: string }} */ v) => v.name), ["demo", "pool2"]);
	writeFileSync(path.join(root, "inventory.json"), "[]\n");
	assert.equal((await headless(["ls"])).stdout, "(no VMs)\n");
});

test("revoke warns when nothing matched instead of claiming access was removed", async () => {
	writeFileSync(store, "env\tKEPT\t\n");
	const typo = await headless(["revoke", "demo", "env:TYPO"]);
	assert.equal(typo.code, 0, typo.output);
	assert.match(typo.output, /no grant env:TYPO/);
	assert.doesNotMatch(typo.output, /revoked env:TYPO/);
	assert.equal(readFileSync(store, "utf8"), "env\tKEPT\t\n");
	const out = await grants.revokeGrants("demo", ["env:KEPT", "env:KEPT"]);
	assert.match(out, /revoked env:KEPT[\s\S]*no grant env:KEPT/);
	assert.equal(existsSync(store), false);
});

test("an incomplete registry entry does not block apply or hide its directory from symlink checks", async () => {
	const broken = path.join(root, "incomplete-profile"), registry = path.join(registryRoot, "host-registry/broken");
	mkdirSync(broken); writeFileSync(path.join(broken, "secret"), "DO-NOT-PUSH");
	writeFileSync(registry, `${broken}\n`);
	const alias = path.join(root, "legacy-link"); symlinkSync(path.join(broken, "secret"), alias);
	process.env.RECONCILE_VALUE = "existing";
	writeFileSync(store, `env\tRECONCILE_VALUE\t\nhttp\tapi.example.com\tbearer;;printf token\nfile\t${alias}\tproject/secret\n`);
	try {
		assert.throws(() => core.registeredHosts(), /incomplete profile/);
		const out = await grants.applyGrants("demo");
		assert.match(out, /now leads through a symlink[\s\S]*skipped/);
		const script = readFileSync(path.join(root, "apply.script"), "utf8");
		assert.match(script, /put_env 'RECONCILE_VALUE'/);
		assert.match(script, /put_edge 'api.example.com'/);
		assert.ok(!script.includes(Buffer.from("DO-NOT-PUSH").toString("base64")));
		assert.match(readFileSync(path.join(root, "host.calls"), "utf8"), /edge-set demo/);
	} finally { rmSync(registry); }
});

test("a post-commit ssh_config failure explicitly reports saved but not fully applied", { skip: process.getuid?.() === 0 && "root ignores the read-only directory" }, async () => {
	chmodSync(profile, 0o555); // ssh_config can't be replaced
	try {
		const out = await grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })]);
		assert.match(out, /are saved, but the change is not fully applied \(refreshing SSH configuration: .*(EACCES|permission denied)/is);
	} finally { chmodSync(profile, 0o755); }
	assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/);
});

test("cancellation after commit finishes SSH configuration and application", async () => {
	// The host answers the known-hosts probe only once released: cancellation lands mid-reconfiguration.
	const ready = path.join(root, "config-ready"), release = path.join(root, "config-release");
	rmSync(path.join(profile, "host-pins-keys"));
	writeFileSync(path.join(root, "grant-host"), `#!/bin/sh\ncase "$1" in help) : > '${ready}'; while [ ! -f '${release}' ]; do sleep 0.01; done; echo '  known-hosts NAME' ;; edge-set) cat >/dev/null ;; esac\n`);
	const abort = new AbortController();
	const pending = grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })], { signal: abort.signal });
	try {
		for (let i = 0; !existsSync(ready) && i < 500; i++) await core.sleep(10);
		assert.equal(existsSync(ready), true);
		assert.equal(existsSync(store), true);
		abort.abort(); writeFileSync(release, "");
		assert.doesNotMatch(await pending, /not fully applied/);
		assert.match(readFileSync(path.join(profile, "ssh_config"), "utf8"), /^Host demo\.boxery\n {2}ForwardAgent yes$/m);
	} finally { writeFileSync(release, ""); await pending; writeFileSync(path.join(profile, "host-pins-keys"), ""); rmSync(ready, { force: true }); rmSync(release, { force: true }); }
});

test("cancellation while waiting for the store lock makes no change", async () => {
	const lock = path.join(profile, "grants/.demo.lock"); writeFileSync(lock, "");
	const abort = new AbortController();
	const pending = grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })], { signal: abort.signal });
	abort.abort(); rmSync(lock);
	await assert.rejects(pending, /aborted/);
	assert.equal(existsSync(store), false);
});

test("approved CLI env commands retain original stdin and visible stderr", async () => {
	const cmd = 'printf helper-prompt >&2; IFS= read -r token; printf %s "$token"';
	const pty = terminal(["grant", "demo", "env:FROM_PTY", "--cmd", cmd], "y\npty-value");
	assert.equal(pty.code, 0, pty.output); assert.match(pty.output, /helper-prompt/);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("pty-value").toString("base64")));
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	const r = await headless(["grant", "demo", "env:FROM_STDIN", "--cmd", cmd], "pipe-value\n");
	assert.equal(r.code, 0, r.output); assert.match(r.stderr, /helper-prompt/);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("pipe-value").toString("base64")));
	// Only keep one stdin-consuming grant for the reapply check.
	writeFileSync(store, `env\tFROM_STDIN\t${cmd}\n`);
	const reapplied = await headless(["grants", "demo", "apply"], "refreshed\n");
	assert.equal(reapplied.code, 0, reapplied.output);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("refreshed").toString("base64")));
	const failed = await headless(["grant", "demo", "env:FAILED_HELPER", "--cmd", 'echo credential-helper-failed >&2; exit 1']);
	assert.match(failed.stderr, /credential-helper-failed/);
});

test("multi-destination forks require every approval and revalidate source grants", () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	const no = terminal(["fork", "source", "one", "two", "--grants"], "y\nn");
	assert.notEqual(no.code, 0); assert.equal(existsSync(path.join(root, "host.calls")), false);
	assert.equal(existsSync(path.join(profile, "grants/one")), false);
	const yes = terminal(["fork", "source", "one", "two", "--grants"], "y\ny");
	assert.equal(yes.code, 0, yes.output);
	assert.equal(yes.output.split("Allow access? [y/N]").length - 1, 2);
	for (const vm of ["one", "two"]) assert.match(readFileSync(path.join(profile, `grants/${vm}`), "utf8"), /^ssh-agent\t/);
	rmSync(path.join(root, "host.calls"));
	writeFileSync(path.join(profile, "grants/source"), `file\t${root}/missing.env\tproject/.env\n`);
	const invalid = terminal(["fork", "source", "three", "--grants"], "y");
	assert.notEqual(invalid.code, 0); assert.match(invalid.output, /no such local file/);
	assert.equal(existsSync(path.join(root, "host.calls")), false);
});

test("file grants: REMOTE is relative to the guest's home, however it is spelled", () => {
	const file = path.join(root, "home.env"); writeFileSync(file, "A=1");
	for (const remote of [".config/x.env", "~/.config/x.env", "/home/agent/.config/x.env"]) {
		assert.equal(grants.parseGrantSpec({ spec: `file:${file}=${remote}` }, { cli: true }).remote, ".config/x.env", remote);
	}
	assert.throws(() => grants.parseGrantSpec({ spec: `file:${file}=/etc/x.env` }, { cli: true }), /relative to \/home\/agent/);
	writeFileSync(path.join(profile, "grants/homes"), `file\t${file}\tproject/.env\nfile\t${file}\t/home/agent/project/.env\n`);
	assert.deepEqual(grants.listGrants("homes").map((g) => g.remote), ["/home/agent/project/.env", "/home/agent/project/.env"]);
	rmSync(path.join(profile, "grants/homes"));
});

test("prompt's pi check: only a provider routed through the host proxy needs its llm: grant", () => {
	const models = JSON.stringify({ providers: { "openai-codex": { baseUrl: "http://127.0.0.1:8088/chatgpt/backend-api" }, ollama: { baseUrl: "http://127.0.0.1:8088/ollama/v1" }, mine: { baseUrl: "https://llm.example.com/v1" } } });
	const settings = (/** @type {string} */ p) => JSON.stringify({ defaultProvider: p });
	assert.equal(grants.missingPiGrant("demo", { settings: settings("openai-codex"), models }), "llm:chatgpt");
	assert.equal(grants.missingPiGrant("demo", { settings: settings("openai-codex"), projectSettings: settings("ollama"), models }), "llm:ollama", "the project's settings win");
	for (const files of [{ settings: settings("mine"), models }, { settings: settings("anthropic"), models }, { settings: "", models }, { settings: "{not json", models }, { settings: settings("openai-codex"), models: "" }, { settings: settings("__proto__"), models }])
		assert.equal(grants.missingPiGrant("demo", files), null, JSON.stringify(files));
	mkdirSync(path.dirname(store), { recursive: true });
	writeFileSync(store, "llm\tollama\t\nssh-agent\t\t\n");
	assert.equal(grants.missingPiGrant("demo", { settings: settings("openai-codex"), models }), "llm:chatgpt", "another provider's grant doesn't count");
	writeFileSync(store, "llm\tchatgpt\t\n");
	assert.equal(grants.missingPiGrant("demo", { settings: settings("openai-codex"), models }), null);
	rmSync(store);
});

test("prompt's pi check knows every proxy route the host seeds into pi, and every llm: provider", async () => {
	const { piModels } = await import("../host/seed.mjs");
	const seeded = /** @type {Record<string, { baseUrl: string }>} */ (piModels("vm:secret", [{ id: "m" }]).providers);
	assert.deepEqual(Object.keys(seeded).sort(), ["ollama", "openai-codex"]);
	for (const p of Object.keys(seeded))
		assert.match(grants.missingPiGrant("demo", { settings: JSON.stringify({ defaultProvider: p }), models: JSON.stringify({ providers: seeded }) }) ?? "", /^llm:(chatgpt|ollama)$/, p);
	for (const provider of grants.LLM_PROVIDERS) {
		assert.equal(grants.parseGrantSpec({ spec: `llm:${provider}` }).provider, provider);
		const models = JSON.stringify({ providers: { p: { baseUrl: `http://127.0.0.1:8088/${provider}/v1` } } });
		assert.equal(grants.missingPiGrant("demo", { settings: JSON.stringify({ defaultProvider: "p" }), models }), `llm:${provider}`);
	}
});

test("all grant kinds use the same prompt formatter and validation on both front-ends", () => {
	const file = path.join(root, "dev.env"); writeFileSync(file, "A=1");
	for (const spec of ["ssh-agent", "github", "env:EXAMPLE", `file:${file}=.config/dev.env`, "llm:chatgpt"]) {
		const agent = core.parseGrantRequest({ spec });
		const user = grants.parseGrantSpec({ spec }, { cli: true });
		assert.equal(grants.grantPrompt("demo", "local", user), grants.grantPrompt("demo", "local", agent));
	}
});
