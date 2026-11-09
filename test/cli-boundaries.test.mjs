// Durable behavior checks derived from the command contracts, with fully stubbed host/SSH transports.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { cliSandbox } from "./fixtures/cli-sandbox.mjs";

const s = cliSandbox();
process.env.BOXERY_HOME = s.home;
const { COMMANDS, actionContract, contractOf } = await import("../controller/cli.mjs");
const python = !spawnSync("python3", ["--version"]).error;
/** @typedef {{words: string[], command: string, contract: ReturnType<typeof contractOf>}} Route */
/** All leaf spellings, including legacy commands, aliases and family actions. @type {Route[]} */
const routes = [];
for (const [name, entry] of Object.entries(COMMANDS)) {
	const command = "alias" in entry ? entry.alias : name;
	const target = COMMANDS[command];
	if ("run" in target && target.run) routes.push({ words: [name], command, contract: contractOf(name) });
	if (!("actions" in entry) || !entry.actions) continue;
	for (const [action, a] of Object.entries(entry.actions)) routes.push({ words: [name, action], command: a.command ?? name, contract: actionContract(a) });
}
const payload = ["--help", "-h", "--host", "beta", "mail@example.org", "", "two words", "x'; touch SHOULD_NOT_RUN; '", "$(touch SHOULD_NOT_RUN)", "$HOME", "a\nb"];
const sshTargetTail = (/** @type {string[]} */ args) => args.slice(args.indexOf("demo.boxery") + 1);
const noEffects = () => { assert.deepEqual(s.ssh(), []); assert.deepEqual(s.host(), []); };
beforeEach(() => s.reset());
after(() => s.close());

/** Conditional-approval grammar cannot be inferred from one policy field; additions must supply a fixture.
 *  @type {Record<string, string[]>} */
const approvalArgs = {
	new: ["fresh", "--grant", "ssh-agent"],
	fork: ["source", "dest", "--grants"],
	grant: ["demo", "env:LIST_TOKEN", "--cmd", "printenv LIST_TOKEN"],
	"agent-forward": ["demo", "on"],
};
const stdinArgs = { attach: ["demo", "shell", "work"] };
const aliasArgs = { ls: ["--json"] };

test("policy fixture coverage is exact, so new terminal/payload commands cannot silently escape", () => {
	const handlers = (/** @type {string} */ policy) => [...new Set(routes.filter((r) => r.contract.terminal === policy).map((r) => r.command))].sort();
	assert.deepEqual(handlers("approval"), Object.keys(approvalArgs).sort());
	assert.deepEqual(handlers("stdin"), Object.keys(stdinArgs).sort());
	assert.deepEqual([...new Set(Object.values(COMMANDS).flatMap((e) => "alias" in e ? [e.alias] : []))].sort(), Object.keys(aliasArgs).sort());
	assert.deepEqual([...new Set(routes.flatMap((r) => r.contract.payload ? [r.contract.payload] : []))].sort(), ["agent", "argv", "shell", "task"]);
});

for (const r of routes.filter((r) => r.contract.terminal === "approval")) {
	test(`${r.words.join(" ")} cannot approve grants through stdin or an inherited opt-out`, () => {
		s.grant("source", "llm\tchatgpt\t\n");
		const before = s.state();
		const result = s.run([...r.words, ...approvalArgs[r.command]], { GRANT_CONFIRM: "off", LIST_TOKEN: "SHOULD_NOT_BE_RESOLVED" }, "yes\n");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /grants need a person/);
		assert.doesNotMatch(result.stderr, /SHOULD_NOT_BE_RESOLVED/);
		assert.deepEqual(s.state(), before);
		noEffects();
	});
	test(`${r.words.join(" ")} declining on a real terminal leaves the host and store untouched`, { skip: !python && "needs python3 for a real terminal" }, () => {
		s.grant("source", "llm\tchatgpt\t\n");
		const before = s.state();
		const result = s.pty([...r.words, ...approvalArgs[r.command]], "n");
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /Allow access\? \[y\/N\]/);
		assert.match(result.output, /grant declined/);
		assert.deepEqual(s.state(), before);
		noEffects();
	});
}

for (const r of routes.filter((r) => r.contract.terminal === "stdin")) {
	test(`${r.words.join(" ")} requires stdin TTY before any VM connection`, () => {
		const before = s.state();
		const result = s.run([...r.words, ...stdinArgs[r.command]]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /needs a terminal/);
		assert.deepEqual(s.state(), before);
		noEffects();
	});
	test(`${r.words.join(" ")} preserves exit codes and signals on a real terminal`, { skip: !python && "needs python3 for a real terminal" }, () => {
		for (const [extra, code] of /** @type {[NodeJS.ProcessEnv, number][]} */ ([[{ BOXERY_TEST_EXIT: "42" }, 42], [{ BOXERY_TEST_SIGNAL: "SIGTERM" }, -15]])) {
			const result = s.pty([...r.words, ...stdinArgs[r.command]], "", extra);
			assert.equal(result.code, code, result.output);
			assert.equal(s.ssh().at(-1).profile, s.profile("alpha"));
			assert.match(s.ssh().at(-1).args.at(-1), /tmux attach -t 'work'/, "the final attach, not an earlier reconcile, produced the status");
		}
	});
}

for (const r of routes.filter((r) => r.contract.payload)) {
	test(`${r.words.join(" ")} respects its ${r.contract.payload} payload boundary`, { skip: r.contract.payload === "agent" && !python && "needs python3 for a real terminal" }, () => {
		s.grant("demo", "llm\tchatgpt\t\n");
		const before = s.state();
		if (r.contract.payload === "agent") {
			const result = s.pty([...r.words, "demo", "shell", "work.session-1"]);
			assert.equal(result.code, 0, result.output);
			assert.match(s.ssh().at(-1).args.at(-1), /tmux attach -t 'work.session-1'/);
		} else {
			const args = r.contract.payload === "argv" ? ["demo", "--", "printf", "[%s]", ...payload]
				: r.contract.payload === "shell" ? ["demo", "printf", ...payload] : ["demo", ...payload];
			const result = s.run([...r.words, ...args]);
			assert.equal(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stdout, /^Usage:/);
			const tail = sshTargetTail(s.ssh().at(-1).args);
			if (r.contract.payload === "shell") assert.deepEqual(tail, ["printf", ...payload]);
			else if (r.contract.payload === "task") assert.equal(Buffer.from(/echo (\S+) \| base64 -d/.exec(tail[0])?.[1] ?? "", "base64").toString(), payload.join(" "));
			else {
				// Parse the actual remote line with a capture-only printf function in the fake VM home.
				const script = `printf() { command printf '%s\\0' "$@"; }\n${tail[0]}`;
				const captured = execFileSync("/bin/sh", ["-c", script], { env: s.env, cwd: s.root, timeout: 10_000 });
				assert.deepEqual(captured.toString().split("\0").slice(0, -1), ["[%s]", ...payload]);
			}
		}
		assert.ok(s.ssh().length > 0, "the payload reached SSH");
		assert.ok(s.ssh().every((call) => call.profile === s.profile("alpha")), "--host in payload never reroutes the command");
		assert.equal(existsSync(path.join(s.root, "SHOULD_NOT_RUN")), false);
		assert.equal(existsSync(path.join(s.env.HOME, "project", "SHOULD_NOT_RUN")), false);
		// Connections reconcile existing grants and remember the empty HTTP-edge set; permissions stay identical.
		const expected = r.contract.payload === "shell" || r.contract.payload === "agent" ? [...before, "profiles/alpha/grants/.demo.edge="] : before;
		assert.deepEqual(s.state().sort(), expected.sort());
	});
}

for (const r of routes.filter((r) => r.contract.payload === "agent")) {
	const validSessions = new Set(["--help", "-h", "--host", "beta"]);
	test(`${r.words.join(" ")} rejects invalid session payloads before TTY checks or effects`, () => {
		const before = s.state();
		for (const session of payload.filter((word) => !validSessions.has(word))) {
			const result = s.run([...r.words, "demo", "shell", session]);
			assert.equal(result.status, 1, `${JSON.stringify(session)}: ${result.stderr}`);
			assert.match(result.stderr, /invalid session name:/);
			noEffects();
			assert.deepEqual(s.state(), before);
		}
	});
	test(`${r.words.join(" ")} keeps dash-leading valid session names quoted`, { skip: !python && "needs python3 for a real terminal" }, () => {
		for (const session of validSessions) {
			s.clear();
			const result = s.pty([...r.words, "demo", "shell", session]);
			assert.equal(result.code, 0, result.output);
			assert.ok(s.ssh().at(-1).args.at(-1).includes(`tmux attach -t '${session}'`));
			assert.equal(s.ssh().at(-1).profile, s.profile("alpha"));
		}
	});
}

test("single help-looking payload words follow each route's declared convention", () => {
	s.grant("demo", "llm\tchatgpt\t\n");
	for (const r of routes.filter((r) => r.contract.payload)) for (const flag of ["--help", "-h"]) {
		s.clear();
		const result = s.run([...r.words, "demo", flag]);
		if (r.contract.help === "legacy") {
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /^Usage:/);
			noEffects();
		} else if (r.contract.payload === "agent") {
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, /unknown agent:/);
			noEffects();
		} else {
			assert.equal(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stdout, /^Usage:/);
			const tail = sshTargetTail(s.ssh().at(-1).args);
			if (r.contract.payload === "task") assert.equal(Buffer.from(/echo (\S+) \| base64 -d/.exec(tail[0])?.[1] ?? "", "base64").toString(), flag);
			else assert.ok(tail.some((word) => word.includes(flag)), `${r.words.join(" ")}: the flag reached SSH`);
		}
	}
});

test("every named alias matches its target on a valid, explicitly scoped operation", () => {
	const before = s.state();
	for (const [name, e] of Object.entries(COMMANDS)) {
		if (!("alias" in e)) continue;
		const args = ["--host", "beta"];
		const alias = s.run([...args, name, ...aliasArgs[e.alias]]), canonical = s.run([...args, e.alias, ...aliasArgs[e.alias]]);
		assert.equal(alias.status, 0, alias.stderr);
		assert.deepEqual([alias.status, alias.stdout, alias.stderr], [canonical.status, canonical.stdout, canonical.stderr]);
	}
	assert.deepEqual(s.state(), before);
	assert.ok(s.host().length > 0, "a valid alias must actually query the selected host");
	assert.ok(s.host().every((call) => call.startsWith(`${s.profile("beta")}: `)));
	assert.deepEqual(s.ssh(), []);
});

test("selected-host and registry routes reject bad selectors before any effects", () => {
	const before = s.state();
	for (const r of routes) {
		const result = s.run(["--host", "unknown", ...r.words, "demo"]);
		assert.equal(result.status, 1, `${r.words.join(" ")}: ${result.stderr}`);
		assert.match(result.stderr, r.contract.scope === "registry" ? /--host does not apply/ : /unknown host: unknown/, r.words.join(" "));
	}
	for (const [name, e] of Object.entries(COMMANDS)) {
		if (!("actions" in e) || !e.actions) continue;
		for (const action of ["frobnicate", "constructor", "__proto__"]) {
			const result = s.run([name, action]);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, /unknown .* action:/);
		}
	}
	noEffects();
	assert.deepEqual(s.state(), before);
});

test("emitted job hints execute against the same host through the public CLI", () => {
	for (const prefix of [[], ["--host", "beta"]]) {
		s.clear();
		const started = s.run([...prefix, "run", "--bg", "demo", "true"]);
		assert.equal(started.status, 0, started.stderr);
		const hints = /logs: (.+?)   wait: (.+)\n/.exec(started.stderr);
		assert.ok(hints, started.stderr);
		for (const line of hints.slice(1)) {
			const followed = s.shell(line);
			assert.equal(followed.status, 0, `${line}: ${followed.stderr}`);
		}
		for (const action of ["start", "logs", "wait"]) assert.ok(s.ssh().some((call) => call.args.at(-1).includes(` ${action} `)), `the ${action} operation reached SSH`);
		assert.ok(s.ssh().every((call) => call.profile === s.profile(prefix.length ? "beta" : "alpha")));
	}
	assert.equal(readFileSync(path.join(s.home, "default-host"), "utf8"), "alpha\n");
});

test("grant queries never resolve values, and empty/unreachable inventory has the documented scope", () => {
	const file = path.join(s.root, "source.txt"), marker = path.join(s.root, "QUERY_COMMAND_RAN");
	writeFileSync(file, "FILE_CONTENT_MUST_NOT_BE_READ");
	s.grant("demo", `env\tLIST_TOKEN\ttouch '${marker}'; printenv LIST_TOKEN\nfile\t${file}\tproject/source.txt\n`);
	const recorded = s.state();
	for (const words of [["access", "ls"], ["grants"]]) {
		const result = s.run([...words, "demo", "--json"], { LIST_TOKEN: "ENV_VALUE_MUST_NOT_BE_READ" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).length, 2);
		assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /FILE_CONTENT_MUST_NOT_BE_READ|ENV_VALUE_MUST_NOT_BE_READ/);
	}
	assert.equal(existsSync(marker), false);
	noEffects();
	assert.deepEqual(s.state(), recorded);
	rmSync(path.join(s.profile("alpha"), "grants/demo"));
	const emptyState = s.state();
	const empty = s.run(["access", "ls", "demo", "--json"]);
	assert.equal(empty.status, 0, empty.stderr);
	assert.deepEqual(JSON.parse(empty.stdout), []);
	const missing = s.run(["access", "ls", "ghost"]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no such vm: ghost/);
	assert.deepEqual(s.host(), Array(2).fill(`${s.profile("alpha")}: ls --json`));
	assert.deepEqual(s.ssh(), []);
	writeFileSync(s.hostbin, "#!/bin/sh\necho unreachable >&2\nexit 255\n");
	const unreachable = s.run(["access", "ls", "demo", "--json"]);
	assert.equal(unreachable.status, 0, unreachable.stderr);
	assert.deepEqual(JSON.parse(unreachable.stdout), []);
	assert.deepEqual(s.state(), emptyState);
	assert.deepEqual(s.ssh(), []);
	assert.equal(existsSync(marker), false);
});
