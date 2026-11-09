// The command families (boxery snapshot|agent|job|access|lease|host ACTION) against the real CLI, with isolated
// profiles, a stub boxery-host and a stub ssh: nothing here reaches a real host, VM, profile or credential.
// Each family action runs the same handler as its older spelling, so every pair below must do exactly the same.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { hostTransport, hostCalls } from "./fixtures/host-transport.mjs";
import { registerHost } from "./fixtures/register-host.mjs";

const root = mkdtempSync(path.join(tmpdir(), "boxery-families-"));
const home = path.join(root, "registry"), bin = path.join(root, "bin"), unconfigured = path.join(root, "unconfigured");
const profile = (/** @type {string} */ name) => path.join(root, "profiles", name);
const cli = path.resolve(import.meta.dirname, "../controller/boxery");
mkdirSync(bin);
mkdirSync(unconfigured);
for (const name of ["alpha", "beta"]) {
	registerHost(home, name, profile(name));
	writeFileSync(path.join(profile(name), "ssh_config"), "# fixture\n  KnownHostsCommand /bin/sh -c fixture\n");
}
hostTransport(root, [profile("alpha"), profile("beta")]);
const inventory = JSON.parse(readFileSync(path.join(root, "host.ls.json"), "utf8"));
inventory.push({ ...inventory[0], name: "demo" });
writeFileSync(path.join(root, "host.ls.json"), JSON.stringify(inventory));
// ssh: records its arguments and answers with them as JSON (or BOXERY_SSH_REPLY), exits BOXERY_SSH_EXIT, or dies by BOXERY_SSH_SIGNAL.
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.BOXERY_SSH_LOG, JSON.stringify({ args, profile: process.env.BOXERY_STUB_PROFILE }) + '\\n');
if (process.env.BOXERY_SSH_SIGNAL) process.kill(process.pid, process.env.BOXERY_SSH_SIGNAL);
console.log(process.env.BOXERY_SSH_REPLY ?? JSON.stringify({ args, profile: process.env.BOXERY_STUB_PROFILE }));
process.exit(Number(process.env.BOXERY_SSH_EXIT ?? 0));
`);
chmodSync(path.join(bin, "ssh"), 0o755);
const sshLog = path.join(root, "ssh.calls");
const env = { ...process.env, HOME: path.join(root, "home"), BOXERY_HOME: home, PATH: `${bin}:${process.env.PATH}`, BOXERY_SSH_LOG: sshLog, NO_COLOR: "1" };
/** @param {string[]} args @param {NodeJS.ProcessEnv} [extra] */
const run = (args, extra = {}) => {
	const options = { env: { ...env, ...extra }, encoding: /** @type {const} */ ("utf8"), timeout: 20_000, input: "", cwd: root, detached: true };
	const r = spawnSync(cli, args, options);
	return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
};
const sshCalls = () => (existsSync(sshLog) ? readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = () => hostCalls(root);
/** The words a started job runs: the NUL-separated, base64 argv that `start` sends the VM helper. @param {{ args: string[] }} call */
const jobArgv = (call) => {
	const m = /\bstart (\S+) \S+ \S+ --text$/.exec(call.args.at(-1) ?? "");
	assert.ok(m, `not a job start: ${call.args.at(-1)}`);
	return Buffer.from(m[1], "base64").toString().split("\0").slice(0, -1);
};

// (the first call to a host also probes its features with `help`, once: not part of a command)
/** Everything a command can have left in the registry and the profiles. @param {string} dir @returns {string[]} */
function tree(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const f = path.join(dir, e.name);
		// (a lease's key is made anew each time: its name is what counts)
		return e.isDirectory() ? [`${f}/`, ...tree(f)] : [`${f}=${/\.(key|pub)$/.test(f) ? "" : readFileSync(f, "utf8")}`];
	}).sort();
}
const state = () => [...tree(home), ...tree(path.join(root, "profiles"))];
/** What differs between two runs of the same command by the clock alone. @param {unknown} v */
const clockless = (v) => JSON.stringify(v).replace(/task-\d{8}-\d{6}/g, "task-ID").replace(/\\?"expires_(?:at|in)\\?":\d+/g, "expires:N").replace(/\b\d{1,4}s\b/g, "Ns").replace(/until [^"]*/g, "until D").replace(/expires=\d+/g, "expires=N");
// The first command on a profile regenerates its ssh_config (and drops a stale ssh connection), whatever the command is:
// do that once here, so what the tests compare is each command's own.
for (const args of [["leases"], ["--host", "beta", "leases"]]) assert.equal(run(args).status, 0);
beforeEach(() => {
	writeFileSync(path.join(home, "default-host"), "alpha\n");
	for (const f of [sshLog, path.join(root, "host.calls"), path.join(root, "renew-fails")]) rmSync(f, { force: true });
	for (const name of ["alpha", "beta"]) { rmSync(path.join(profile(name), "leases"), { recursive: true, force: true }); rmSync(path.join(profile(name), "grants"), { recursive: true, force: true }); mkdirSync(path.join(profile(name), "grants")); }
});
after(() => rmSync(root, { recursive: true, force: true }));

/** @typedef {{ family: string[], older: string[], prep?: string[], env?: NodeJS.ProcessEnv }} Pair */
/** @type {Pair[]} */
const PAIRS = [
	{ family: ["snapshot", "create", "demo", "s1"], older: ["snap", "demo", "s1"] },
	{ family: ["snapshot", "create", "demo"], older: ["snap", "demo"] },
	{ family: ["snapshot", "ls", "demo"], older: ["snaps", "demo"] },
	{ family: ["snapshot", "ls", "demo", "--json"], older: ["snaps", "demo", "--json"] },
	{ family: ["snapshot", "restore", "demo", "s1"], older: ["revert", "demo", "s1"] },
	{ family: ["snapshot", "rm", "demo", "s1"], older: ["snap-rm", "demo", "s1"] },
	{ family: ["snapshot", "images"], older: ["images"] },
	{ family: ["snapshot", "images", "--json"], older: ["images", "--json"] },
	{ family: ["snapshot", "create", "demo", "bad name"], older: ["snap", "demo", "bad name"] }, // the same refusal
	{ family: ["--host", "beta", "snapshot", "ls", "demo"], older: ["--host", "beta", "snaps", "demo"] },
	{ family: ["agent", "attach", "demo"], older: ["attach", "demo"] },
	{ family: ["agent", "attach", "demo", "opencode", "work"], older: ["attach", "demo", "opencode", "work"] },
	{ family: ["agent", "attach", "demo", "pi", "bad/session"], older: ["attach", "demo", "pi", "bad/session"] },
	{ family: ["agent", "prompt", "demo", "fix", "the tests"], older: ["prompt", "demo", "fix", "the tests"] },
	{ family: ["agent", "prompt", "demo"], older: ["prompt", "demo"] },
	{ family: ["agent", "ls", "demo"], older: ["sessions", "demo"] },
	{ family: ["agent", "ls", "demo", "--json"], older: ["sessions", "demo", "--json"], env: { BOXERY_SSH_REPLY: "work\t1\t1700000000\t0" } },
	{ family: ["job", "ls", "demo"], older: ["jobs", "demo"] },
	{ family: ["job", "ls", "demo", "--json"], older: ["jobs", "demo", "--json"] },
	{ family: ["job", "ls", "demo", "--prune", "--older-than", "7d"], older: ["jobs", "demo", "--prune", "--older-than", "7d"] },
	{ family: ["job", "logs", "demo", "job-1", "-f", "--lines", "5", "--strip-ansi"], older: ["logs", "demo", "job-1", "-f", "--lines", "5", "--strip-ansi"] },
	{ family: ["job", "logs", "demo", "job-1", "--bogus"], older: ["logs", "demo", "job-1", "--bogus"] },
	{ family: ["job", "wait", "demo", "job-1", "--timeout", "5", "--json"], older: ["wait", "demo", "job-1", "--timeout", "5", "--json"], env: { BOXERY_SSH_REPLY: '{"state":"exited","exit_code":7}' } },
	{ family: ["job", "kill", "demo", "job-1", "--grace", "1"], older: ["kill", "demo", "job-1", "--grace", "1"] },
	{ family: ["access", "ls", "demo"], older: ["grants", "demo"] },
	{ family: ["access", "ls", "demo", "--json"], older: ["grants", "demo", "--json"] },
	{ family: ["access", "apply", "demo"], older: ["grants", "demo", "apply"] },
	{ family: ["access", "apply", "demo", "--quiet"], older: ["grants", "demo", "apply", "--quiet"] },
	{ family: ["access", "revoke", "demo", "github"], older: ["revoke", "demo", "github"] },
	{ family: ["access", "grant", "demo", "ssh-agent"], older: ["grant", "demo", "ssh-agent"] }, // no terminal: the same refusal
	{ family: ["access", "grant", "demo", "github", "--readonly"], older: ["grant", "demo", "github", "--readonly"] },
	{ family: ["access", "grant", "demo", "env:API_TOKEN", "--cmd", "printf 'a b'"], older: ["grant", "demo", "env:API_TOKEN", "--cmd", "printf 'a b'"] },
	{ family: ["lease", "acquire", "--ttl", "600", "--wait", "3", "--holder", "me@test"], older: ["acquire", "--ttl", "600", "--wait", "3", "--holder", "me@test"] },
	{ family: ["lease", "acquire", "--ttl", "x"], older: ["acquire", "--ttl", "x"] },
	{ family: ["lease", "renew", "pool-1", "--ttl", "900"], older: ["renew", "pool-1", "--ttl", "900"], prep: ["acquire"] },
	{ family: ["lease", "release", "pool-1"], older: ["release", "pool-1"], prep: ["acquire"] },
	{ family: ["lease", "ls"], older: ["leases"], prep: ["acquire"] },
	{ family: ["lease", "ls", "--json"], older: ["leases", "--json"], prep: ["acquire"] },
	{ family: ["host", "build-base"], older: ["build-base"] },
	{ family: ["host", "upgrade", "--check"], older: ["upgrade-host", "--check"] },
	{ family: ["host", "proxy-log", "5"], older: ["proxy-log", "5"] },
	{ family: ["host", "backends", "--json"], older: ["backends", "--json"] },
	{ family: ["host", "capabilities", "--json"], older: ["capabilities", "--json"] },
	{ family: ["host", "capabilities", "--check"], older: ["capabilities", "--check"] },
	{ family: ["host", "backend"], older: ["backend"] },
	{ family: ["--host", "beta", "host", "upgrade", "--check"], older: ["--host", "beta", "upgrade-host", "--check"] },
];

test("every family action does what its older spelling does: output, status, ssh and host calls, saved state", () => {
	for (const { family, older, prep, env: extra } of PAIRS) {
		/** @param {string[]} args */
		const observe = (args) => {
			rmSync(sshLog, { force: true }); rmSync(path.join(root, "host.calls"), { force: true });
			if (prep) run(prep, extra); // (a lease to renew; its own calls aren't compared)
			rmSync(sshLog, { force: true }); rmSync(path.join(root, "host.calls"), { force: true });
			const r = run(args, extra);
			// (a usage error names the command as it was typed: the families' own spelling is checked below)
			return clockless({ r: { ...r, stderr: r.stderr.replace(/^boxery: usage: [\s\S]*$/, "boxery: usage: …") }, ssh: sshCalls(), host: calls().filter((c) => !c.endsWith(": help")).sort(), state: state() });
		};
		const a = observe(family), b = observe(older);
		assert.equal(a, b, `boxery ${family.join(" ")} differs from boxery ${older.join(" ")}`);
	}
});

test("exit statuses and fatal signals pass through the families as through the older spellings", () => {
	for (const [family, older, extra, want] of /** @type {[string[], string[], NodeJS.ProcessEnv, number][]} */ ([
		[["agent", "ls", "demo"], ["sessions", "demo"], { BOXERY_SSH_EXIT: "42" }, 42],
		[["agent", "ls", "demo"], ["sessions", "demo"], { BOXERY_SSH_EXIT: "5" }, 5],
		[["job", "ls", "demo"], ["jobs", "demo"], { BOXERY_SSH_EXIT: "9" }, 9],
		[["job", "wait", "demo", "job-1"], ["wait", "demo", "job-1"], { BOXERY_SSH_REPLY: '{"state":"exited","exit_code":7}' }, 7],
		[["job", "wait", "demo", "job-1"], ["wait", "demo", "job-1"], { BOXERY_SSH_REPLY: '{"state":"running"}' }, 124],
		[["job", "wait", "demo", "job-1"], ["wait", "demo", "job-1"], { BOXERY_SSH_REPLY: '{"state":"lost"}' }, 125],
	])) {
		const a = run(family, extra), b = run(older, extra);
		assert.equal(a.status, want, `${family.join(" ")}: ${a.stderr}`);
		assert.deepEqual([a.status, a.signal, a.stdout, a.stderr], [b.status, b.signal, b.stdout, b.stderr], family.join(" "));
	}
	const a = run(["agent", "ls", "demo"], { BOXERY_SSH_SIGNAL: "SIGTERM" }), b = run(["sessions", "demo"], { BOXERY_SSH_SIGNAL: "SIGTERM" });
	assert.equal(a.signal, "SIGTERM", "ended by the signal that ended ssh");
	assert.deepEqual([a.signal, a.status], [b.signal, b.status]);
});

test("help and mistakes need no host: nothing is read, written or contacted", () => {
	rmSync(path.join(home, "default-host"));
	const before = state();
	const helps = [["help"], ["help", "--all"], ["snapshot", "--help"], ["snapshot", "create", "--help"], ["help", "snapshot", "restore"], ["host", "--help"], ["host", "upgrade", "--help"], ["host", "add", "-h"],
		["--host", "ghost", "access", "grant", "--help"], ["agent", "attach", "--help"], ["job", "logs", "--help"], ["lease", "-h"], ["access", "ls", "--help"], ["--host", "ghost", "host", "ls", "--help"]];
	for (const args of helps) {
		const r = run(args, { BOXERY_HOME: unconfigured });
		assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
		assert.match(r.stdout, /^(Usage:|boxery — )/);
		assert.equal(r.stderr, "");
	}
	const mistakes = [["snapshot"], ["snapshot", "frob"], ["access", "agent-forward", "demo"], ["job", "start", "demo", "x"], ["lease", "aquire"], ["help", "job", "frob"], ["agent"], ["access", "ls", "demo", "apply"]];
	for (const args of mistakes) {
		const r = run(args, { BOXERY_HOME: unconfigured });
		assert.notEqual(r.status, 0, args.join(" "));
		assert.match(r.stderr, /^boxery: /);
	}
	assert.equal(existsSync(sshLog), false);
	assert.equal(calls().length, 0);
	assert.deepEqual(readdirSync(unconfigured), [], "BOXERY_HOME stays empty");
	assert.deepEqual(state(), before);
});

test("malformed actions say what the family has, before any host, ssh or saved state is touched", () => {
	const before = state();
	/** @type {[string[], number, RegExp][]} */
	const cases = [
		[["snapshot"], 2, /^boxery: snapshot needs an action; actions: create, ls, restore, rm, images; see: boxery snapshot --help\n$/],
		[["snapshot", "restroe", "demo", "s1"], 2, /unknown snapshot action: restroe \(did you mean restore\?\); actions: create, ls, restore, rm, images/],
		[["snapshot", "snap", "demo"], 2, /unknown snapshot action: snap;/],
		[["agent", "attch", "demo"], 2, /did you mean attach\?/],
		[["job", "start", "demo", "sleep", "9"], 2, /unknown job action: start; actions: ls, logs, wait, kill/],
		[["access", "agent-forward", "demo", "on"], 2, /unknown access action: agent-forward; actions: grant, revoke, ls, apply/],
		[["lease", "pool-1"], 2, /unknown lease action: pool-1/],
		[["host", "frob"], 2, /unknown host action: frob; actions: add, ls, show, use, rm, build-base, upgrade/],
		[["--host", "beta", "host", "frob"], 2, /unknown host action: frob/],
		[["access", "ls", "demo", "apply"], 2, /^boxery: usage: boxery access ls NAME \[--json\]\n$/],
		[["access", "ls", "demo", "--quiet"], 2, /usage: boxery access ls NAME/],
		[["access", "ls", "demo", "--json", "--json"], 2, /usage: boxery access ls NAME/],
		[["access", "apply"], 2, /^boxery: usage: boxery access apply NAME \[--quiet\]\n$/],
		[["access", "apply", "demo", "--json"], 2, /usage: boxery access apply NAME/],
		[["access", "apply", "demo", "--quiet", "x"], 2, /usage: boxery access apply NAME/],
		[["access", "ls", "Demo"], 1, /invalid VM name: Demo/],
		[["job", "kill", "demo"], 2, /^boxery: missing job id \(see: boxery job ls NAME\)\n$/],
		[["job", "kill", "demo", "nope"], 1, /^boxery: invalid job id: nope \(see: boxery job ls NAME\)\n$/],
		[["job", "ls", "demo", "--frob"], 2, /^boxery: usage: boxery job ls NAME \[--json\]\n {7}boxery job ls NAME --prune/],
		[["lease", "ls", "--frob"], 2, /^boxery: usage: boxery lease ls \[--json\]\n$/],
		[["snapshot", "rm", "demo"], 2, /^boxery: usage: boxery snapshot rm NAME SNAP\n$/],
	];
	for (const [args, status, error] of cases) {
		const r = run(args);
		assert.equal(r.status, status, `${args.join(" ")}: ${r.stderr}`);
		assert.match(r.stderr, error, args.join(" "));
		assert.equal(r.stdout, "");
	}
	assert.equal(existsSync(sshLog), false, "no ssh");
	assert.deepEqual(calls().filter((c) => !/\b(version|help)\b/.test(c)), [], "no host commands");
	assert.deepEqual(state(), before);
});

test("host: registry refuses --host; read-only checks list hosts; explicit maintenance stays selected", () => {
	assert.equal(run(["host", "upgrade", "--check"]).status, 0);
	assert.deepEqual(calls().sort(), [`${profile("alpha")}: upgrade --check`, `${profile("beta")}: upgrade --check`]);
	rmSync(path.join(root, "host.calls"));
	assert.equal(run(["--host", "beta", "host", "upgrade", "--check"]).status, 0);
	assert.deepEqual(calls().map((c) => c.split(": ")[0]), [profile("beta"), profile("beta")]);
	rmSync(path.join(root, "host.calls"));
	assert.equal(run(["--host", "beta", "host", "capabilities", "--json"]).status, 0);
	assert.deepEqual(calls().map((c) => c.split(": ")), [[profile("beta"), "capabilities --json"]]);
	for (const action of ["proxy-log", "backend", "backends"]) {
		rmSync(path.join(root, "host.calls"));
		run(["--host", "beta", "host", action]);
		assert.deepEqual(calls().map((c) => c.split(": ")[0]), [profile("beta")], `${action} never uses the default host`);
	}
	rmSync(path.join(root, "host.calls"));
	// a host you name that isn't registered is the usual error, and a missing default is too
	assert.match(run(["--host", "nope", "host", "upgrade"]).stderr, /unknown host: nope/);
	rmSync(path.join(home, "default-host"));
	assert.match(run(["host", "upgrade"]).stderr, /no host configured/);
	assert.match(run(["host", "build-base"]).stderr, /no host configured/);
	assert.equal(run(["--host", "beta", "host", "build-base"]).status, 0, "--host replaces the missing default");
	assert.equal(existsSync(path.join(home, "default-host")), false, "--host never sets the default");
	writeFileSync(path.join(home, "default-host"), "alpha\n");
	rmSync(path.join(root, "host.calls"), { force: true });
	// registry: no host is contacted, --host is refused with the same message as before
	const ls = run(["host", "ls", "--json"]);
	assert.equal(ls.status, 0, ls.stderr);
	assert.deepEqual(JSON.parse(ls.stdout).map((/** @type {{ name: string, default: boolean }} */ h) => [h.name, h.default]), [["alpha", true], ["beta", false]]);
	assert.equal(run(["host"]).stdout, run(["host", "ls"]).stdout, "a bare host still lists");
	assert.equal(run(["host", "show", "beta"]).stdout, `${profile("beta")}\n`);
	assert.equal(run(["host", "use", "beta"]).status, 0);
	assert.equal(readFileSync(path.join(home, "default-host"), "utf8"), "beta\n");
	assert.equal(calls().length, 0, "registry actions contact no host");
	assert.equal(existsSync(sshLog), false);
	for (const args of [["host", "ls"], ["host"], ["host", "show", "alpha"], ["host", "use", "alpha"], ["host", "rm", "alpha"], ["host", "add", "x", "local"]]) {
		const r = run(["--host", "alpha", ...args]);
		assert.equal(r.status, 1, args.join(" "));
		assert.equal(r.stderr, "boxery: --host does not apply to host management\n", args.join(" "));
	}
	assert.equal(readFileSync(path.join(home, "default-host"), "utf8"), "beta\n");
	assert.ok(existsSync(path.join(home, "host-registry/alpha")), "nothing was removed");
});

test("access ls with stored records is read-only: no ssh, host call, grant change or apply", () => {
	// a stored grant that has a command for its secret: listing shows the command, never runs it or shows a value
	writeFileSync(path.join(profile("alpha"), "grants/demo"), "ssh-agent\t\t\nenv\tAPI_TOKEN\ttouch RAN_THE_COMMAND\n");
	const before = state();
	const listed = run(["access", "ls", "demo"]);
	assert.equal(listed.status, 0, listed.stderr);
	assert.deepEqual(listed.stdout, run(["grants", "demo"]).stdout);
	assert.match(listed.stdout, /^grants for demo:\n {2}ssh-agent {3}forward the user's local ssh agent\n {2}env:API_TOKEN {3}\(from: touch RAN_THE_COMMAND\)\n$/);
	const json = run(["access", "ls", "demo", "--json"]);
	assert.deepEqual(JSON.parse(json.stdout), [{ kind: "ssh-agent" }, { kind: "env", var: "API_TOKEN", cmd: "touch RAN_THE_COMMAND" }]);
	assert.equal(json.stdout, run(["grants", "demo", "--json"]).stdout);
	for (const extra of [["apply"], ["apply", "--quiet"], ["--quiet"], ["--json", "apply"], ["--json", "x"], ["on"], ["revoke"]]) {
		const r = run(["access", "ls", "demo", ...extra]);
		assert.equal(r.status, 2, extra.join(" "));
		assert.match(r.stderr, /usage: boxery access ls NAME \[--json\]/);
		assert.equal(r.stdout, "");
	}
	assert.equal(existsSync(sshLog), false, "listing never connects to the VM");
	assert.deepEqual(calls(), [], "listing never calls the host");
	assert.equal(existsSync(path.join(root, "RAN_THE_COMMAND")), false, "listing never runs a grant's command");
	assert.deepEqual(state().filter((l) => l.includes("grants/")), before.filter((l) => l.includes("grants/")), "the grant store is unchanged");
	// apply is the only family action that pushes them again, and it says so in its name
	assert.equal(run(["access", "apply", "demo"]).status, 0);
	assert.ok(sshCalls().length > 0, "apply connects to the VM");
	assert.equal(existsSync(path.join(root, "RAN_THE_COMMAND")), true, "and runs the grant's command to push its value");
});

test("access ls without records checks host inventory without applying grants", () => {
	const before = state();
	const empty = run(["access", "ls", "demo", "--json"]);
	assert.equal(empty.status, 0, empty.stderr);
	assert.deepEqual(JSON.parse(empty.stdout), []);
	for (const args of [["access", "ls", "ghost"], ["grants", "ghost"]]) {
		const missing = run(args);
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /no such vm: ghost on host alpha/);
		assert.equal(missing.stdout, "");
	}
	assert.deepEqual(calls(), Array(3).fill(`${profile("alpha")}: ls --json`));
	assert.equal(existsSync(sshLog), false, "inventory queries never connect to the VM");
	assert.deepEqual(state(), before, "no grant or profile state was changed");
});

test("agent attach keeps the terminal requirement and the agent allowlist", () => {
	for (const head of [["agent", "attach"], ["attach"]]) {
		const r = run([...head, "demo", "shell"]);
		assert.equal(r.status, 1, r.stderr);
		assert.match(r.stderr, /attach needs a terminal/);
		const bad = run([...head, "demo", "bogus'; touch pwned; '"]);
		assert.equal(bad.status, 2, bad.stderr);
		assert.match(bad.stderr, /unknown agent:/);
	}
	assert.equal(existsSync(sshLog), false);
	assert.deepEqual(calls(), []);
});

test("agent attach on a terminal preserves argv, exit status and signals", { skip: spawnSync("python3", ["--version"]).error && "needs python3 for a real terminal" }, () => {
	for (const [extra, code] of /** @type {[NodeJS.ProcessEnv, number][]} */ ([[{}, 0], [{ BOXERY_SSH_EXIT: "42" }, 42], [{ BOXERY_SSH_SIGNAL: "SIGTERM" }, -15]])) {
		const observe = (/** @type {string[]} */ head) => {
			rmSync(sshLog, { force: true });
			const r = JSON.parse(execFileSync("python3", [path.join(import.meta.dirname, "fixtures/grant-pty.py"), "", cli, ...head, "demo", "shell", "work"], { env: { ...env, ...extra }, cwd: root, encoding: "utf8", timeout: 20_000 }));
			assert.equal(r.code, code, r.output);
			return { r, ssh: sshCalls() };
		};
		const canonical = observe(["agent", "attach"]);
		assert.deepEqual(canonical, observe(["attach"]));
		assert.equal(canonical.ssh.at(-1).profile, profile("alpha"));
		assert.match(canonical.ssh.at(-1).args.at(-1), /tmux attach -t 'work'/);
	}
});

test("grant aliases require a controlling terminal even without Python installed", () => {
	for (const args of [["access", "grant", "demo", "ssh-agent"], ["grant", "demo", "ssh-agent"], ["agent-forward", "demo", "on"]]) {
		const r = run(args, { GRANT_CONFIRM: "off" }); // an inherited opt-out is not the profile's
		assert.equal(r.status, 1, args.join(" "));
		assert.match(r.stderr, /grants need a person/);
		assert.equal(existsSync(path.join(profile("alpha"), "grants/demo")), false);
	}
	assert.equal(existsSync(sshLog), false);
	assert.deepEqual(calls(), []);
});

test("grant approval, per-profile stores and lease isolation hold through the families", { skip: spawnSync("python3", ["--version"]).error && "needs python3 for a real terminal" }, () => {
	const pty = (/** @type {string[]} */ args, /** @type {string} */ answer) => JSON.parse(execFileSync("python3", [path.join(import.meta.dirname, "fixtures/grant-pty.py"), answer, cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 20_000 }));
	const store = (/** @type {string} */ name) => path.join(profile(name), "grants/demo");
	// a person who says no (or nothing) grants nothing; one who says yes grants to the selected profile only
	for (const answer of ["n", ""]) {
		const r = pty(["access", "grant", "demo", "ssh-agent"], answer);
		assert.notEqual(r.code, 0);
		assert.match(r.output, /Allow access\? \[y\/N\]/);
		assert.match(r.output, /grant declined; nothing was granted/);
		assert.equal(existsSync(store("alpha")), false);
	}
	const yes = pty(["--host", "beta", "access", "grant", "demo", "ssh-agent"], "y");
	assert.equal(yes.code, 0, yes.output);
	assert.equal(existsSync(store("alpha")), false, "alpha's grant store is untouched");
	assert.deepEqual(JSON.parse(run(["--host", "beta", "access", "ls", "demo", "--json"]).stdout), [{ kind: "ssh-agent" }]);
	assert.deepEqual(JSON.parse(run(["access", "ls", "demo", "--json"]).stdout), []);
	// revoking never asks
	assert.equal(run(["--host", "beta", "access", "revoke", "demo", "ssh-agent"]).status, 0);
	assert.deepEqual(JSON.parse(run(["--host", "beta", "access", "ls", "demo", "--json"]).stdout), []);
	// a lease belongs to the profile that acquired it
	const got = run(["--host", "beta", "lease", "acquire", "--ttl", "600"]);
	assert.equal(got.status, 0, got.stderr);
	assert.equal(readdirSync(path.join(profile("beta"), "leases")).filter((f) => f.endsWith(".lease")).length, 1);
	assert.equal(existsSync(path.join(profile("alpha"), "leases")), false);
	assert.deepEqual(JSON.parse(run(["lease", "ls", "--json"]).stdout), []);
	assert.equal(JSON.parse(run(["--host", "beta", "lease", "ls", "--json"]).stdout).length, 1);
	assert.match(run(["lease", "renew", "pool-1"]).stderr, /no local lease/, "alpha cannot renew beta's lease");
	assert.equal(run(["--host", "beta", "lease", "release", "pool-1"]).status, 0);
});

test("canonical prompt keeps single help flags as task text; the legacy help convention stays intact", () => {
	writeFileSync(path.join(profile("alpha"), "grants/demo"), "llm\tchatgpt\t\n");
	for (const flag of ["--help", "-h"]) {
		rmSync(sshLog, { force: true });
		const r = run(["agent", "prompt", "demo", flag], { BOXERY_SSH_REPLY: "\x1e{}\x1e{}\x1e{}" });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^started \S+ on demo — wait: boxery job wait demo \S+ {3}logs: boxery job logs demo \S+ -f$/m);
		assert.deepEqual(jobArgv(sshCalls().at(-1)), ["pi", "-p", flag], "pi -p TASK, started as a job");
		rmSync(sshLog, { force: true });
		const legacy = run(["prompt", "demo", flag]);
		assert.equal(legacy.status, 0, legacy.stderr);
		assert.match(legacy.stdout, /^Usage:/);
		assert.equal(existsSync(sshLog), false);
	}
});

test("payload words are not options: prompt text, run and ssh commands keep every character", () => {
	const words = ["fix", "--host", "beta", "a b", "@x", "-h", "--help", "$HOME; touch pwned", "'q'", ""];
	for (const head of [["agent", "prompt", "demo"], ["prompt", "demo"]]) {
		rmSync(sshLog, { force: true });
		const r = run([...head, ...words]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(jobArgv(sshCalls().at(-1)), ["pi", "-p", words.join(" ")], "the task, exactly");
		assert.equal(sshCalls().at(-1).profile, profile("alpha"), "--host inside the text selects nothing");
		assert.equal(existsSync("pwned"), false);
	}
	// run and ssh take the whole rest as the command to run in the VM, help flags included
	for (const args of [["run", "demo", "--help"], ["run", "demo", "-h"], ["run", "demo", "--", "--help"], ["ssh", "demo", "--help"], ["ssh", "demo", "-h"]]) {
		rmSync(sshLog, { force: true });
		const r = run(args);
		assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
		assert.doesNotMatch(r.stdout, /^Usage:/m, args.join(" "));
		assert.match(JSON.stringify(sshCalls().at(-1).args), /-h|--help/, `${args.join(" ")} reaches the VM`);
	}
	// a family's own help words only count at its own boundary: three words after the action are the command's
	assert.match(run(["job", "logs", "demo", "job-1", "--help"], { BOXERY_SSH_EXIT: "0" }).stderr, /usage: boxery job logs/);
});

test("older spellings still work without a warning; the families add no output of their own", () => {
	for (const args of [["snaps", "demo"], ["images"], ["sessions", "demo"], ["jobs", "demo"], ["grants", "demo"], ["leases"], ["backends"], ["capabilities"], ["proxy-log"], ["upgrade-host", "--check"], ["build-base"], ["list"]]) {
		const r = run(args);
		assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
		assert.doesNotMatch(r.stderr, /deprecat|renamed|use .* instead|boxery (snapshot|job|agent|access|lease|host) /i, args.join(" "));
	}
});
