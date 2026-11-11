// The command contracts in controller/cli.mjs's COMMANDS (Contract: scope, help convention, payload, terminal),
// and that the dispatch reads them: routing is checked word by word against the real CLI with no host
// configured (an empty BOXERY_HOME), so nothing here reaches a host, a profile or a grant. End-to-end behaviour
// with stub hosts is test/cli-families.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "boxery-contracts-"));
after(() => rmSync(home, { recursive: true, force: true }));
const { COMMANDS, PRE_HOST, actionContract, contractOf } = await import("../controller/cli.mjs");

/** The controller with an empty BOXERY_HOME: no default host, none registered. @param {string[]} args */
function boxery(...args) {
	const r = spawnSync(path.join(ROOT, "controller/boxery"), args, { encoding: "utf8", input: "", timeout: 10_000, env: { ...process.env, HOME: path.join(home, "home"), BOXERY_HOME: home, SSH_AUTH_SOCK: "", NO_COLOR: "1" } });
	return { code: r.status, out: r.stdout, err: r.stderr };
}
const NO_HOST = /no host configured/;

/** Every command that has its own entry (not an alias), with its contract. */
const commands = Object.entries(COMMANDS).flatMap(([name, e]) => ("alias" in e ? [] : [/** @type {const} */ ([name, e, contractOf(name)])]));
/** Every family action: [family, action, definition, its contract]. */
const actions = Object.entries(COMMANDS).flatMap(([f, e]) => ("actions" in e && e.actions ? Object.entries(e.actions).map(([a, x]) => /** @type {const} */ ([f, a, x, actionContract(x)])) : []));
const SCOPES = ["host", "controller", "registry"], HELP = ["legacy", "leading", "self"], PAYLOAD = ["argv", "shell", "task", "agent"], TERMINAL = ["stdin", "approval"];

test("every command has exactly one way to run, and a contract that says only what it means", () => {
	for (const [name, e, c] of commands) {
		const ways = ["run", "local", "actions"].filter((k) => k in e && /** @type {Record<string, unknown>} */ (e)[k]);
		if (c.scope === "controller") assert.deepEqual(ways, ["local"], `${name}: a controller command runs only its local handler`);
		else if ("actions" in e) assert.deepEqual(ways, ["actions"], `${name}: a family has actions, not a handler`);
		else assert.deepEqual(ways.filter((w) => w === "run"), ["run"], `${name}: has no handler`);
		assert.ok(SCOPES.includes(c.scope) && c.scope !== "registry", `${name}: scope ${c.scope}`);
		assert.ok(HELP.includes(c.help), `${name}: help ${c.help}`);
		assert.ok(!c.payload || PAYLOAD.includes(c.payload), `${name}: payload ${c.payload}`);
		assert.ok(!c.terminal || TERMINAL.includes(c.terminal), `${name}: terminal ${c.terminal}`);
		if (c.scope === "controller") assert.ok(c.noHost || c.help === "self", `${name}: a controller command either refuses --host or ignores it knowingly (help renders anything)`);
		else assert.equal(c.noHost, undefined, `${name}: only a command with no host to select refuses --host`);
		if (c.hostOptional) assert.ok("local" in e && "run" in e, `${name}: hostOptional needs both a local handler and a host handler`);
		if (c.allHosts) assert.ok("run" in e, `${name}: allHosts needs a handler to tell`);
		if (c.help === "leading") assert.ok(c.payload === "argv" || c.payload === "shell", `${name}: it owns the words after its name, so it declares a payload`);
		if (c.vmAtHost) assert.ok(c.payload, `${name}: NAME@HOST belongs to a command with payload`);
		if ("actions" in e) assert.equal(Object.keys(c).filter((k) => !["scope", "help"].includes(k)).length, 0, `${name}: a family's actions carry the contracts`);
	}
	assert.deepEqual(contractOf("list"), contractOf("ls"), "an alias has its command's contract");
});

test("only host-wide listings opt into all-host dispatch, inherited by family actions", () => {
	assert.deepEqual(commands.filter(([, , c]) => c.allHosts).map(([name]) => name).sort(),
		["ls", "leases", "pool", "images", "version", "shapes", "capabilities", "backends", "upgrade-host", "runners"].sort());
	for (const [family, action] of [["lease", "ls"], ["snapshot", "images"], ["host", "capabilities"], ["host", "backends"], ["host", "upgrade"]]) {
		const entry = COMMANDS[family];
		assert.ok("actions" in entry && entry.actions);
		assert.equal(actionContract(entry.actions[action]).allHosts, true, `${family} ${action}`);
	}
});

test("every family action runs a host command, or declares itself a registry action with its refusal", () => {
	for (const [f, a, x, c] of actions) {
		const label = `${f} ${a}`;
		if (x.scope === "registry") {
			assert.equal(x.command, undefined, `${label}: a registry action has no command`);
			assert.ok(x.noHost, `${label}: a registry action says what --host gets`);
			assert.equal(c.scope, "registry");
			assert.equal(f, "host", `${label}: only host manages the registry`);
		} else {
			assert.ok(x.command && Object.hasOwn(COMMANDS, x.command), `${label}: runs ${x.command}`);
			assert.equal(x.noHost, undefined, `${label}: it follows its command's host selection`);
			const target = COMMANDS[x.command];
			assert.ok("run" in target && target.run, `${label}: ${x.command} has no handler`);
			assert.equal(contractOf(x.command).scope, "host", `${label}: ${x.command} is not a host command`);
			assert.deepEqual({ ...c, help: undefined }, { ...contractOf(x.command), help: undefined }, `${label}: inherits ${x.command}'s contract`);
		}
		assert.equal(c.help, "leading", `${label}: an action only recognises a leading help flag`);
	}
	for (const [f, e] of Object.entries(COMMANDS)) {
		if (!("actions" in e) || !e.actions) continue;
		if ("defaultAction" in e && e.defaultAction !== undefined) assert.ok(Object.hasOwn(e.actions, e.defaultAction), `${f}: unknown default action ${e.defaultAction}`);
		assert.deepEqual(Object.entries(e.actions).filter(([, x]) => x.scope === "registry").length > 0, f === "host", `${f}: registry actions belong to host`);
	}
	assert.ok("actions" in COMMANDS.host);
	assert.equal(COMMANDS.host.defaultAction, "ls", "a bare `boxery host` lists hosts");
});

test("root flag aliases never resolve inherited object properties", () => {
	for (const word of ["constructor", "toString", "hasOwnProperty"]) {
		const r = boxery(word);
		assert.equal(r.code, 2, r.err);
		assert.match(r.err, new RegExp(`unknown command: ${word}`));
		assert.equal(r.out, "");
	}
});

test("PRE_HOST is the controller-scope commands: help, mcp-token (this machine's MCP tokens) and setup", () => {
	assert.deepEqual([...PRE_HOST].sort(), commands.filter(([, , c]) => c.scope === "controller").map(([n]) => n).sort());
	assert.deepEqual([...PRE_HOST].sort(), ["help", "mcp-token", "setup"]);
});

test("every host-scope command is dispatched to a host: --host ghost reaches the host lookup, whatever the words", () => {
	for (const [name, e, c] of commands) {
		if (c.scope !== "host" || "actions" in e) continue;
		const r = boxery("--host", "ghost", name, "demo");
		assert.equal(r.err, "boxery: unknown host: ghost\n", `${name}: ${r.err}`);
		assert.equal(r.out, "");
	}
	for (const [f, a, x, c] of actions) {
		if (c.scope === "registry") continue;
		const r = boxery("--host", "ghost", f, a, "demo");
		assert.equal(r.err, "boxery: unknown host: ghost\n", `${f} ${a} (${x.command}): ${r.err}`);
	}
});

test("registry actions refuse --host with the message they declare, before any host lookup", () => {
	for (const [f, a, x, c] of actions) {
		if (c.scope !== "registry") continue;
		const r = boxery("--host", "ghost", f, a);
		assert.equal(r.err, `boxery: ${x.noHost}\n`, `${f} ${a}`);
		assert.equal(r.code, 1);
	}
	assert.equal(boxery("--host", "ghost", "host").err, "boxery: --host does not apply to host management\n", "bare host is host ls");
	// ...and a controller command refuses it too, except help, which has nothing to select
	for (const [name, , c] of commands) {
		if (c.scope !== "controller") continue;
		const r = boxery("--host", "ghost", name);
		if (c.noHost) assert.equal(r.err, `boxery: ${c.noHost}\n`, name);
		else assert.equal(r.code, 0, `${name}: ${r.err}`);
	}
});

test("a bare `boxery host` is `host ls`", () => {
	const ls = boxery("host", "ls"), bare = boxery("host");
	assert.equal(ls.code, 0, ls.err);
	assert.deepEqual(bare, ls);
	assert.deepEqual(boxery("host", "--help"), boxery("host", "-h"));
	assert.equal(boxery("snapshot").code, 2, "a family without a default action asks for one");
});

test("the help convention is the contract's: legacy shows help after one word, leading owns its payload", () => {
	for (const [name, e, c] of commands) {
		if ("actions" in e || c.help === "self") continue;
		const first = boxery(name, "--help");
		assert.match(first.out, new RegExp(`^Usage:\\n  boxery ${name}\\b`), `${name} --help`);
		const after = boxery(name, "demo", "--help");
		if (c.help === "legacy") assert.equal(after.out, first.out, `${name} demo --help is help (the older convention)`);
		else {
			assert.equal(after.out, "", `${name} demo --help: the words are the command's, not a help request`);
			assert.match(after.err, NO_HOST, name);
		}
	}
	for (const [f, a, , c] of actions) {
		if (c.scope === "registry") continue;
		const r = boxery(f, a, "demo", "--help");
		assert.doesNotMatch(r.out, /^Usage:/m, `${f} ${a} demo --help is not help`);
		assert.match(boxery(f, a, "--help").out, new RegExp(`^Usage:\\n  boxery ${f} ${a}\\b`), `${f} ${a} --help`);
	}
	// help itself: nothing after it is a help flag, so its own --help is an unknown command, as it always was
	assert.equal(boxery("help", "--help").code, 2);
	assert.equal(boxery("help", "help").out, boxery("--help", "help").out);
});

test("NAME@HOST is the contract's: only vmAtHost commands select a host from their first word", () => {
	for (const [name, e, c] of commands) {
		if (c.scope !== "host" || "actions" in e) continue;
		const r = boxery(name, "demo@lab");
		if (c.vmAtHost) assert.equal(r.err, "boxery: unknown host: lab\n", name);
		else assert.doesNotMatch(r.err, /unknown host: lab/, `${name} must leave demo@lab alone: ${r.err}`);
	}
	assert.match(boxery("--host", "ghost", "ssh", "demo@lab").err, /SSH target host lab conflicts with --host ghost/);
	assert.match(boxery("ssh", "demo@Bad").err, /invalid SSH target/);
});

test("version needs no host (hostOptional) but follows --host when one is given", () => {
	assert.equal(contractOf("version").hostOptional, true);
	for (const flag of ["version", "--version", "-V"]) {
		const r = boxery(flag);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /^controller  /);
	}
	assert.equal(JSON.parse(boxery("version", "--json").out).host, null);
	assert.equal(boxery("--host", "ghost", "version").err, "boxery: unknown host: ghost\n");
	assert.equal(boxery("version", "--bogus").code, 2);
	for (const [name, , c] of commands) if (name !== "version") assert.ok(!c.hostOptional, `${name}: only version runs without a host`);
});

test("approval and terminal contracts name the commands that reach grant approval or need a terminal", () => {
	const src = readFileSync(path.join(ROOT, "controller/cli.mjs"), "utf8");
	/** The text of function NAME in the source, by brace matching. @param {string} name */
	const body = (name) => {
		const m = new RegExp(`function ${name}\\b[^{]*\\{`).exec(src);
		if (!m) return "";
		let i = m.index + m[0].length, d = 1;
		for (; i < src.length && d; i++) { if (src[i] === "{") d++; else if (src[i] === "}") d--; }
		return src.slice(m.index, i);
	};
	/** A handler's source with the cmd* functions it calls. @param {string} name */
	const code = (name) => {
		const e = COMMANDS[name];
		let t = "run" in e && e.run ? e.run.toString() : "";
		for (const [, f] of t.matchAll(/\b(cmd[A-Z]\w*)\(/g)) t += body(f);
		return t;
	};
	const asksAPerson = commands.filter(([n, e]) => "run" in e && /\b(?:confirm|confirmCopy|grant|agentForward)\(/.test(code(n))).map(([n]) => n).sort();
	assert.deepEqual(commands.filter(([, , c]) => c.terminal === "approval").map(([n]) => n).sort(), asksAPerson, "a command that reaches grant approval says so (terminal: \"approval\")");
	assert.deepEqual(commands.filter(([, , c]) => c.terminal === "stdin").map(([n]) => n), ["attach"]);
	assert.match(body("cmdAttach"), /contractOf\("attach"\)\.terminal === "stdin"/, "attach's terminal check reads its contract");
});
