// boxery's help can't drift from its code. Each command's help (controller/cli.mjs COMMANDS) must name exactly
// the --flags its handler compares against, examples must use real commands and documented flags, docs links
// must point at real headings, and no module keeps its own usage text. A help change shows in the golden file
// test/fixtures/boxery-help.txt (BOXERY_UPDATE_GOLDEN=1 npm test rewrites it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { COMMANDS } = await import("../controller/cli.mjs");
const { actionHelp, renderTop } = await import("../controller/usage.mjs");
const { HELP: OPENSHELL_HELP } = await import("../controller/setup-openshell.mjs");
const { HOST_COMMANDS } = await import("../host/help.mjs");
/** @typedef {import("../help/index.mjs").Help} Help */
const src = (/** @type {string} */ f) => readFileSync(path.join(ROOT, f), "utf8");

// Where a handler's flags are parsed, when the probe below can't follow it from the handler.
const PARSED_IN = {
	setup: [["controller/hosts.mjs", "setupNamed"], ["controller/hosts.mjs", "setupFlags"]],
	host: [["controller/hosts.mjs", "hostCommand"], ["controller/hosts.mjs", "hostLs"], ["controller/hosts.mjs", "setupFlags"]],
	grants: [["controller/grants.mjs", "grantsCommand"]],
	grant: [["core/grant-approval.mjs", "parseGrantArgs"]],
	runners: [["controller/runners-once.mjs", "runnersOnce"]],
	version: [["controller/cli.mjs", "cmdVersion"]],
	"mcp-token": [["controller/mcp-tokens.mjs", "mcpTokenCommand"]],
};
// Flags in a handler that aren't its own options: arguments it gives ssh, gh or the VM helper.
const NOT_OPTIONS = {
	ssh: ["-t"], attach: ["-t", "--bg"], forward: ["-o"], // --bg belongs to the suggested run command
	jobs: ["--text"], kill: ["--text"],
	runners: ["-c", "--hostname", "--jq", "--input"], // gh api
	run: ["-h", "--help", "-f", "-c"], // help before NAME; -f/-c belong to suggested logs/shell commands
};
// Commands whose flags the host parses (passed through): their help is checked against the host's usage text.
const HOST_PARSED = { patch: "patch", "upgrade-host": "upgrade", backends: "backends", capabilities: "capabilities", snaps: "snaps", images: "images", pool: "pool", runners: "runners" };

/** The text of function NAME (or `case "NAME": {`) in TEXT, by brace matching. @param {string} text @param {string} name */
function body(text, name) {
	const m = new RegExp(`(?:function ${name}\\b[^{]*|case "${name}":\\s*)\\{`).exec(text);
	if (!m) return "";
	let i = m.index + m[0].length, d = 1;
	for (; i < text.length && d; i++) { if (text[i] === "{") d++; else if (text[i] === "}") d--; }
	return text.slice(m.index, i);
}

/** The --flags NAME's code compares against: its handler, the cmd* functions it calls and the module functions it imports. @param {string} name */
function flagsInCode(name) {
	const e = COMMANDS[name];
	let t = "run" in e && e.run ? e.run.toString() : "";
	for (const [, f] of t.matchAll(/\b(cmd[A-Z]\w*)\(/g)) t += body(src("controller/cli.mjs"), f);
	for (const [, mod, f] of t.matchAll(/import\("\.\/([\w-]+)\.mjs"\)\)\.(\w+)\(/g)) t += body(src(`controller/${mod}.mjs`), f);
	// leaseCommand: only this command's case
	if (/leaseCommand\(s, "(\w+)"/.test(t)) t = body(src("controller/leases.mjs"), /** @type {RegExpExecArray} */ (/leaseCommand\(s, "(\w+)"/.exec(t))[1]);
	for (const [f, fn] of PARSED_IN[name] ?? []) t += body(src(f), fn);
	const skip = new Set(NOT_OPTIONS[name] ?? []);
	return new Set([...t.matchAll(/"(--?[a-z][a-z-]*)"/g)].map((m) => m[1]).filter((f) => !skip.has(f)));
}

/** The flags a command's help documents: in its usage lines and its options (details are prose: they may mention other commands' flags). @param {Help} h */
function flagsInHelp(h) {
	const text = [...h.usage, ...(h.flags ?? []).map(([f]) => f)].join(" ");
	return new Set([...text.matchAll(/(?<![\w-])(--?[a-z][a-z-]*)/g)].map((m) => m[1]).filter((f) => f !== "--"));
}

const commands = Object.entries(COMMANDS).flatMap(([n, e]) => ("help" in e ? [/** @type {const} */ ([n, e.help])] : []));
/** Every family and its actions: [family, action, the action's help, the command it runs]. */
const actions = Object.entries(COMMANDS).flatMap(([f, e]) => ("actions" in e && e.actions ? Object.entries(e.actions).map(([a, x]) => /** @type {const} */ ([f, a, /** @type {Help} */ (actionHelp(COMMANDS, f, a)), x.command])) : []));
/** What a help line's examples and see-also may be checked against: commands and family actions. */
const everyHelp = [...commands.map(([n, h]) => /** @type {const} */ ([n, h])), ...actions.map(([f, a, h]) => /** @type {const} */ ([`${f} ${a}`, h]))];

test("each command's help names exactly the flags its code reads", () => {
	for (const [name, h] of commands) {
		// (families have no handler of their own: their actions are checked below)
		if (name in HOST_PARSED || name === "help" || "actions" in COMMANDS[name]) continue;
		const code = flagsInCode(name), help = flagsInHelp(h);
		// (setup: OpenShell's options live in its own --help)
		const undocumented = [...code].filter((f) => !help.has(f) && !(name === "setup" && OPENSHELL_HELP.includes(f)));
		const unread = [...help].filter((f) => !code.has(f) && !["--help", "-h"].includes(f));
		assert.deepEqual(undocumented, [], `boxery ${name} reads ${undocumented.join(", ")} but its help doesn't say so (controller/cli.mjs)`);
		assert.deepEqual(unread, [], `boxery ${name}'s help documents ${unread.join(", ")}, which its code never reads`);
	}
});

test("pass-through commands document only flags boxery-host takes", () => {
	for (const [name, hostCmd] of Object.entries(HOST_PARSED)) {
		const mine = flagsInHelp(/** @type {{ help: Help }} */ (COMMANDS[name]).help);
		const host = flagsInHelp(/** @type {{ help: Help }} */ (HOST_COMMANDS[hostCmd]).help);
		const extra = [...mine].filter((f) => !host.has(f) && !(name === "runners" && f.startsWith("--") && /** @type {{ help: Help }} */ (COMMANDS.runners).help.usage[0].includes(f)));
		assert.deepEqual(extra, [], `boxery ${name} documents ${extra.join(", ")}, which boxery-host ${hostCmd} doesn't take`);
	}
});

test("a family's actions run existing commands, and document only flags those read", () => {
	assert.ok(actions.length >= 30, "the families lost their actions");
	for (const [f, a, h, command] of actions) {
		assert.match(h.usage[0], new RegExp(`^${f} ${a}\\b`), `${f} ${a}: its first usage line must start with it`);
		if (!command) continue; // host's registry actions: below
		assert.ok(Object.hasOwn(COMMANDS, command) && "run" in COMMANDS[command], `${f} ${a} runs ${command}, which has no handler in COMMANDS`);
		// (the flags are the command's own, or what the action's own usage, written for its arguments, takes from them)
		// (a pass-through command's flags are boxery-host's)
		const code = command in HOST_PARSED ? flagsInHelp(/** @type {{ help: Help }} */ (HOST_COMMANDS[HOST_PARSED[command]]).help) : flagsInCode(command), mine = flagsInHelp(h);
		const unread = [...mine].filter((x) => !code.has(x) && !["--help", "-h"].includes(x));
		assert.deepEqual(unread, [], `boxery ${f} ${a} documents ${unread.join(", ")}, which ${command}'s code never reads`);
		if (!/** @type {{ actions: Record<string, { help?: Help }> }} */ (COMMANDS[f]).actions[a].help?.usage) assert.deepEqual([...mine].sort(), [...flagsInHelp(/** @type {{ help: Help }} */ (COMMANDS[command]).help)].sort(), `${f} ${a} should document ${command}'s flags`);
	}
	// host's registry actions read the registry's flags between them
	const registry = new Set(actions.filter(([f, , , c]) => f === "host" && !c).flatMap(([, , h]) => [...flagsInHelp(h)]));
	assert.deepEqual([...registry].sort(), [...flagsInCode("host")].sort(), "host's registry actions' flags are not what controller/hosts.mjs reads");
	// no action names an alias (access ls and apply both run grants, kept apart by their arguments)
	for (const [f, e] of Object.entries(COMMANDS)) {
		if (!("actions" in e) || !e.actions) continue;
		const cmds = Object.values(e.actions).flatMap((x) => (x.command ? [x.command] : []));
		for (const c of cmds) assert.ok(!("alias" in COMMANDS[c]), `${f} runs ${c}, an alias`);
	}
});

test("older spellings are hidden from boxery help exactly when a family action runs them (attach and prompt stay)", () => {
	const folded = new Set(actions.flatMap(([, , , c]) => (c ? [c] : [])));
	for (const [name, h] of commands) {
		if ("actions" in COMMANDS[name]) { assert.equal(h.group, "families", `${name}: a family belongs to the families group`); continue; }
		const prominent = ["attach", "prompt"].includes(name);
		assert.equal(h.group === "legacy", folded.has(name) && !prominent || name === "agent-forward", `${name}: ${h.group === "legacy" ? "is hidden as an older spelling but no family action runs it" : "is run by a family action but listed as a command"}`);
	}
});

// ---------------------------------------------------------------- boxery-host (host/help.mjs)
// Where each host command's flags are parsed: [file, function] (functions found by name).
const HOST_PARSED_IN = {
	init: [["host/boxery-host", null]], // --backend: the entry point and init read BOXERY_BACKEND
	version: [["host/boxery-upgrade.mjs", "main"]], upgrade: [["host/boxery-upgrade.mjs", "parseArgs"]],
	backends: [["host/capabilities.mjs", "backends"]], capabilities: [["host/capabilities.mjs", "capabilities"]],
	profiles: [["host/setup.mjs", "profiles"]],
	new: [["host/vms.mjs", "parseNewArgs"]], fork: [["host/vms.mjs", "fork"]], resize: [["host/vms.mjs", "resize"]],
	ls: [["host/cli.mjs", "ls"]], shapes: [["host/cli.mjs", "shapes"]], snaps: [["host/cli.mjs", "snaps"]], images: [["host/cli.mjs", "images"]],
	patch: [["host/patch.mjs", "parsePatchArgs"]], pin: [["host/hostkeys.mjs", "pin"]],
	"edge-set": [["host/pool.mjs", "edgeSet"]],
	pool: [["host/pool.mjs", "poolLs"], ["host/pool.mjs", "poolRm"]],
	acquire: [["host/boxery-lifecycle.mjs", "acquire"]], renew: [["host/boxery-lifecycle.mjs", "renew"]],
	runners: [["host/runners.mjs", "configure"], ["host/runners.mjs", "status"]],
};
const HOST_LITERAL_ONLY = { init: ["--backend"] }; // parsed in Bash: checked by presence, not by function

test("each boxery-host command's help names exactly the flags its code reads", () => {
	// host/cli.mjs runs when imported: read its dispatch tables' keys from the source.
	const cli = src("host/cli.mjs");
	// (keys: a word at the start of a line or after ", " that a colon follows, or a bare shorthand key; not words in comments)
	const keys = (/** @type {string} */ table) => body(cli.replace(new RegExp(`const ${table} = \\{`), `function ${table}() {`), table).split("\n").map((l) => l.replace(/\/\/.*$/, ""))
		.flatMap((l) => [...l.matchAll(/(?:^\s*|,\s*)"?([a-z][a-z-]*)"?(?=\s*[:,]|\s*$)/g)].map((m) => m[1]));
	const dispatched = new Set([...keys("COMMANDS"), ...keys("MUTATING"), "connect", "version", "upgrade", "help"]);
	for (const n of dispatched) assert.ok(Object.hasOwn(HOST_COMMANDS, n), `boxery-host ${n} has no help in host/help.mjs`);
	for (const [name, e] of Object.entries(HOST_COMMANDS)) {
		if ("alias" in e) { assert.ok(Object.hasOwn(HOST_COMMANDS, e.alias), `boxery-host ${name} aliases a missing command`); continue; }
		assert.ok(dispatched.has(name), `host/help.mjs documents boxery-host ${name}, which host/cli.mjs doesn't dispatch`);
		const help = flagsInHelp(e.help);
		let code = new Set();
		for (const [file, fn] of HOST_PARSED_IN[name] ?? []) {
			let text = fn ? body(src(file), fn) : src(file);
			// fork's arguments are parsed up to its usage check; after that it builds new's arguments (--from IMAGE)
			if (name === "fork") text = text.slice(0, text.indexOf("hostUsage("));
			// (acquire and renew take --json through jsonFlag(), defined beside them)
			if (/\bjsonFlag\(args\)/.test(text)) text += /** @type {RegExpExecArray} */ (/const jsonFlag = .*$/m.exec(src(file)))[0];
			assert.ok(text, `${file}: no ${fn}`);
			for (const m of text.matchAll(/"(--?[a-z][a-z-]*)"/g)) code.add(m[1]);
		}
		if (name in HOST_LITERAL_ONLY) code = new Set(HOST_LITERAL_ONLY[name].filter((f) => src("host/boxery-host").includes(f) || src("host/setup.mjs").includes(f)));
		code.delete("--help"); code.delete("-h");
		const undocumented = [...code].filter((f) => !help.has(f)), unread = [...help].filter((f) => !code.has(f));
		assert.deepEqual(undocumented, [], `boxery-host ${name} reads ${undocumented.join(", ")} but host/help.mjs doesn't say so`);
		assert.deepEqual(unread, [], `boxery-host ${name}'s help documents ${unread.join(", ")}, which its code never reads`);
		assert.ok(e.help.summary.length <= 72, `boxery-host ${name}: summary over 72 characters`);
	}
});

test("no host module keeps its own usage text (internal entry points aside)", () => {
	for (const f of readdirSync(path.join(ROOT, "host")).filter((f) => f.endsWith(".mjs") && f !== "help.mjs")) {
		const hits = src(`host/${f}`).split("\n").filter((l) => /["'`]usage: (?!runners __once|boxery-leases\.mjs)/.test(l));
		assert.deepEqual(hits, [], `host/${f}: use hostUsage(COMMAND) from host/help.mjs, not a literal usage line`);
	}
});

test("examples run real commands with documented flags", () => {
	for (const [name, h] of everyHelp) {
		for (const [, line] of h.examples ?? []) {
			for (const part of line.split(/\s*&&\s*/)) {
				const words = part.split(/\s+/);
				assert.equal(words[0], "boxery", `${name} example: ${part}`);
				let i = 1;
				if (words[i] === "--host") i += 2;
				const cmd = words[i];
				assert.ok(Object.hasOwn(COMMANDS, cmd), `${name} example uses an unknown command: ${part}`);
				let target = /** @type {{ help: Help }} */ (COMMANDS[cmd]).help;
				// a family's action: its help, and its words start after it
				const entry = COMMANDS[cmd];
				if ("actions" in entry && entry.actions && words[i + 1] && !words[i + 1].startsWith("-")) {
					const found = actionHelp(COMMANDS, cmd, words[i + 1]);
					assert.ok(found, `${name} example: ${cmd} has no action ${words[i + 1]} (${part})`);
					target = /** @type {Help} */ (found); i++;
				}
				const documented = flagsInHelp(target);
				// boxery's own words: for run and ssh, up to the command they run in the VM.
				let own = words.slice(i + 1);
				if (cmd === "run" || cmd === "ssh") {
					const at = own.findIndex((w, j) => j > 0 && !w.startsWith("-") && own[j - 1] !== "--cwd");
					own = at < 0 ? own : own.slice(0, at);
				}
				for (const w of own) if (/^--?[a-z]/.test(w)) assert.ok(documented.has(w), `${name} example: ${cmd} doesn't document ${w} (${part})`);
			}
		}
	}
});

test("seeAlso names commands; docs links point at real headings", () => {
	const slug = (/** @type {string} */ t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s/g, "-");
	for (const [name, h] of everyHelp) {
		// (an action's see-also may be family actions: "access revoke")
		for (const c of h.seeAlso ?? []) assert.ok(Object.hasOwn(COMMANDS, c) || actions.some(([f, a]) => `${f} ${a}` === c), `${name}: seeAlso ${c} is not a command or a family action`);
		if (!h.docs) continue;
		const [file, anchor] = h.docs.split("#");
		assert.ok(readdirSync(path.join(ROOT, "docs")).includes(file), `${name}: docs/${file} doesn't exist`);
		if (anchor) {
			const slugs = src(`docs/${file}`).split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
			assert.ok(slugs.includes(anchor), `${name}: docs/${file} has no heading #${anchor}`);
		}
	}
});

test("all-host listing help explains how to retain one-host output", () => {
	for (const name of ["leases", "images", "version", "shapes", "capabilities", "backends", "pool", "runners"]) {
		const e = COMMANDS[name];
		assert.ok("help" in e);
		const details = (e.help.details ?? []).join(" ");
		assert.match(details, /--host NAME/, name);
		assert.match(details, /--json/, name);
	}
	assert.ok("help" in COMMANDS["upgrade-host"]);
	assert.match(COMMANDS["upgrade-host"].help.details?.join(" ") ?? "", /--check lists every host/);
});

test("summaries are one short line", () => {
	for (const [name, h] of everyHelp) {
		assert.ok(h.summary.length <= 66, `${name}: summary over 66 characters; put the rest in details`);
		assert.doesNotMatch(h.summary, /\n|\.$/, `${name}: summary is one line without a final period`);
		assert.match(h.usage[0], new RegExp(`^${name}\\b`), `${name}: its first usage line must start with ${name}`);
	}
});

test("no module keeps its own usage text", () => {
	for (const f of readdirSync(path.join(ROOT, "controller")).filter((f) => f.endsWith(".mjs") && f !== "usage.mjs")) {
		const hits = src(`controller/${f}`).split("\n").filter((l) => /["'`]usage: boxery (?!--host)/.test(l));
		assert.deepEqual(hits, [], `controller/${f}: use usage(COMMAND) from lib.mjs, not a literal usage line`);
	}
});

test("docs/cli.md's command reference is up to date (npm run docs:cli)", async () => {
	const { rendered } = await import("../scripts/docs-cli.mjs");
	const { text, next } = await rendered();
	assert.ok(text === next, "docs/cli.md: the command reference is out of date; run: npm run docs:cli");
});

// boxery help, and boxery help --all with every family action and older spelling.
for (const [file, args, all] of /** @type {const} */ ([["boxery-help.txt", ["help"], false], ["boxery-help-all.txt", ["help", "--all"], true]])) {
	const golden = path.join(ROOT, "test/fixtures", file);
	test(`boxery ${args.join(" ")} matches test/fixtures/${file} (BOXERY_UPDATE_GOLDEN=1 rewrites it)`, () => {
		const home = mkdtempSync(path.join(tmpdir(), "boxery-help-"));
		after(() => rmSync(home, { recursive: true, force: true }));
		const out = spawnSync(path.join(ROOT, "controller/boxery"), args, { encoding: "utf8", env: { ...process.env, BOXERY_HOME: home, NO_COLOR: "1" } }).stdout;
		assert.equal(out, renderTop(COMMANDS, all));
		if (process.env.BOXERY_UPDATE_GOLDEN) writeFileSync(golden, out);
		assert.equal(out, readFileSync(golden, "utf8"), `${args.join(" ")} changed: review it, then BOXERY_UPDATE_GOLDEN=1 node --test test/help-drift.test.mjs`);
	});
}
