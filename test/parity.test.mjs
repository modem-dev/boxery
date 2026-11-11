// CLI ↔ agent-tool parity. Agents get the vm_* tools (core/boxery-tools.mjs, shared by MCP and pi);
// people and scripts get controller/boxery. Each side must account for the other: a new tool or
// action fails here until it names its CLI command (or says why there is none), and so does a new
// CLI command. Where both exist, prefer one implementation (boxery cp runs vm_copy's own code).
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS } from "../core/boxery-tools.mjs";

class NoCli { constructor(why) { this.why = why; } }
const none = (why) => new NoCli(why);
const DESKTOP = none("people drive the desktop and Chrome themselves: boxery desktop NAME");
const NO_CURRENT = none("the CLI has no current VM; every command names its VM");

// tool → CLI command, or {action: CLI command} for tools with an `action` enum.
const CLI_FOR_TOOL = {
	vm_bash: "run",
	vm_jobs: { start: "run --bg", list: "job ls", logs: "job logs", wait: "job wait", kill: "job kill" },
	vm_read: "run", // boxery run NAME cat PATH, or boxery cp NAME:PATH ./
	vm_write: "cp",
	vm_edit: none("people edit in their editor, over boxery ssh or after boxery cp"),
	vm_copy: "cp",
	vm_sync: "sync",
	vm_screenshot: DESKTOP,
	vm_click: DESKTOP,
	vm_type: DESKTOP,
	vm_key: DESKTOP,
	vm_scroll: DESKTOP,
	vm_browser: DESKTOP,
	vm_manage: {
		new: "new", fork: "fork", rm: "rm", start: "start", stop: "stop", resize: "resize",
		snap: "snapshot create", "snap-rm": "snapshot rm", revert: "snapshot restore", use: NO_CURRENT, none: NO_CURRENT, "build-base": "host build-base",
		host: none("the CLI has no session host; every command takes --host, and the default is the user's (boxery host use)"),
		host_add: "host add", host_rm: "host rm",
	},
	vm_info: { list: "ls", shapes: "shapes", grants: "access ls", snaps: "snapshot ls", images: "snapshot images", version: "version", hosts: "host ls", capabilities: "host capabilities" },
	vm_lease: { acquire: "lease acquire", renew: "lease renew", release: "lease release", list: "lease ls" },
	vm_grant: "access grant", // the agent asks; the user approves in a prompt, then it runs boxery access grant
};

// CLI commands no tool maps to, and why agents don't get them. A family action is its command's (below): an older
// spelling is listed for what it runs, and a family when none of its actions maps to a tool.
const CLI_ONLY = {
	agent: "persistent tmux sessions for people (attach, prompt, ls); agents run commands with vm_bash and vm_jobs",
	help: "usage text",
	setup: "configuring the VM host is the user's setup",
	backends: "catalog for user setup; agents inspect their configured host with vm_info capabilities",
	backend: "refreshes the backend recorded in the user's profile (vm_info hosts reads that record)",
	"upgrade-host": "upgrading the host is the user's to run (vm_info version tells agents to ask)",
	revoke: "only the user takes access away (agents can only ask for it, with vm_grant)",
	"agent-forward": "only the user changes what a VM may access",
	ssh: "interactive shell (agents use vm_bash)",
	attach: "interactive tmux session",
	desktop: "opens noVNC in the user's browser (agents use the computer-use tools)",
	forward: "binds a port on the user's machine",
	prompt: "starts a pi task in the VM; agents run commands with vm_jobs",
	sessions: "lists the VM's tmux sessions: attach's, and one per background job (prompt and run --bg)",
	"proxy-log": "host-wide LLM/edge request log, for the user",
	pool: "host admin",
	runners: "host admin: GitHub Actions runners on the pool, with a GitHub token that stays on the host",
	pin: "which ssh host key a VM is trusted with is the user's decision (--from-guest trusts the network once)",
	patch: "rewrites a VM's software and may restart it under running agents; the user's to run (vm_info list shows outdated VMs)",
	"mcp-token": "minting MCP access is the user's decision; an agent never mints or widens its own token",
};

// controller/cli.mjs's command table: every command, including those handled before a host is selected
// (help, setup). Aliases (list → ls) are the same command. A family's action runs an existing command's handler:
// `boxery job ls` is `jobs`, so a tool maps to either spelling and reaches the same command.
const { COMMANDS } = await import("../controller/cli.mjs");
function cliCommands() {
	return new Set(Object.keys(COMMANDS).filter((c) => !("alias" in COMMANDS[c])));
}
/** The commands "boxery WORDS" dispatches to: the command, or a family and the command its action runs; null if there is no such action. @param {string} cli */
function dispatched(cli) {
	const [first, action] = cli.split(" ");
	const e = COMMANDS[first];
	if (!e || !("actions" in e) || !e.actions) return cliCommands().has(first) ? [first] : null;
	if (!action || !Object.hasOwn(e.actions, action)) return null;
	const c = e.actions[action].command;
	return c ? [first, c] : [first];
}

const mapped = () =>
	TOOLS.flatMap((t) => {
		const v = CLI_FOR_TOOL[t.name];
		if (typeof v === "object" && !(v instanceof NoCli)) return Object.entries(v).map(([action, cli]) => [`${t.name} ${action}`, cli]);
		return [[t.name, v]];
	});

test("every vm_* tool and action names its CLI command, or why it has none", () => {
	for (const t of TOOLS) {
		assert.ok(t.name in CLI_FOR_TOOL, `${t.name} is new: add it to CLI_FOR_TOOL in test/parity.test.mjs with its boxery command, or none("why")`);
		const actions = t.parameters.properties.action?.enum;
		const v = CLI_FOR_TOOL[t.name];
		if (actions && !(v instanceof NoCli)) {
			assert.ok(typeof v === "object", `${t.name} has actions: map each one`);
			assert.deepEqual(Object.keys(v).sort(), [...actions].sort(), `${t.name}: map exactly its actions (${actions.join(", ")})`);
		}
	}
	assert.deepEqual(Object.keys(CLI_FOR_TOOL).filter((n) => !TOOLS.some((t) => t.name === n)), [], "CLI_FOR_TOOL lists tools that no longer exist");
	for (const [tool, cli] of mapped()) {
		if (cli instanceof NoCli) assert.ok(cli.why.length > 10, `${tool}: say why there is no CLI command`);
		else assert.ok(dispatched(cli), `${tool} maps to "boxery ${cli}", which controller/boxery doesn't dispatch`);
	}
});

test("every CLI command maps to a vm_* tool or says why agents don't get it", () => {
	const reached = new Set(mapped().flatMap(([, cli]) => (cli instanceof NoCli ? [] : dispatched(cli) ?? [])));
	for (const c of cliCommands()) {
		assert.ok(reached.has(c) || c in CLI_ONLY, `boxery ${c} is new: map a vm_* tool to it in CLI_FOR_TOOL, or add it to CLI_ONLY with a reason`);
		assert.ok(!(reached.has(c) && c in CLI_ONLY), `boxery ${c} is mapped to a tool and listed in CLI_ONLY`);
	}
	for (const c of Object.keys(CLI_ONLY)) assert.ok(cliCommands().has(c), `CLI_ONLY lists boxery ${c}, which controller/boxery doesn't dispatch`);
});

test("every family action maps to a tool through its command, or its command says why agents don't get it", () => {
	const reached = new Set(mapped().flatMap(([, cli]) => (cli instanceof NoCli ? [] : dispatched(cli) ?? [])));
	for (const [family, e] of Object.entries(COMMANDS)) {
		if (!("actions" in e) || !e.actions) continue;
		for (const [action, a] of Object.entries(e.actions)) {
			const c = a.command ?? family;
			assert.ok(reached.has(c) || c in CLI_ONLY || family in CLI_ONLY || (!a.command && reached.has(family)), `boxery ${family} ${action} runs ${c}: map a tool to it or say why agents don't get it`);
		}
	}
	// the older spellings stay mapped: a tool reaches them through the family action that runs them
	for (const old of ["snap", "snaps", "revert", "snap-rm", "images", "jobs", "logs", "wait", "kill", "grants", "acquire", "renew", "release", "leases", "build-base", "capabilities"]) assert.ok(reached.has(old), `boxery ${old} is no longer reached by any tool's mapping`);
});

// Terminal status (OSC 7501, for Rex and other terminals that speak it): the long commands report working,
// done or error through one seam, controller/status.mjs, and declare it with a `status` on their COMMANDS
// entry. Every command either has one or is listed here with the reason it doesn't, so a new command has to
// take a side. A `status` is only for commands that run: families route to the command their action runs.
const QUICK = "returns in about a second: a done record would be noise";
const FAMILY = "a family: its actions run other commands, which declare their own status";
const INTERACTIVE = "interactive or a tunnel that runs until Ctrl-C: the program in it reports for itself (pi does), and there is nothing to finish";
const BEFORE_HOST = "handled before a host is selected, outside the seam";
const NO_STATUS = {
	rm: QUICK, pin: QUICK, shapes: QUICK, ls: QUICK, snaps: QUICK, "snap-rm": QUICK, images: QUICK, sessions: QUICK, jobs: QUICK, kill: QUICK,
	grant: QUICK, revoke: QUICK, grants: QUICK, "agent-forward": QUICK, renew: QUICK, release: QUICK, leases: QUICK, version: QUICK,
	backends: QUICK, capabilities: QUICK, backend: QUICK, "proxy-log": QUICK,
	prompt: "starts a background job and returns; the job isn't this process",
	ssh: INTERACTIVE, attach: INTERACTIVE, forward: INTERACTIVE, desktop: INTERACTIVE,
	host: FAMILY, snapshot: FAMILY, agent: FAMILY, job: FAMILY, access: FAMILY, lease: FAMILY,
	setup: BEFORE_HOST, help: BEFORE_HOST, "mcp-token": BEFORE_HOST,
};

test("every CLI command declares a terminal status, or says why it has none", () => {
	const declares = (/** @type {string} */ c) => "status" in COMMANDS[c] && !!COMMANDS[c].status;
	for (const c of cliCommands()) {
		assert.ok(declares(c) || c in NO_STATUS, `boxery ${c} is new: give its COMMANDS entry a status (controller/status.mjs), or add it to NO_STATUS in test/parity.test.mjs with a reason`);
		assert.ok(!(declares(c) && c in NO_STATUS), `boxery ${c} declares a status and is listed in NO_STATUS`);
	}
	for (const c of Object.keys(NO_STATUS)) assert.ok(cliCommands().has(c), `NO_STATUS lists boxery ${c}, which controller/cli.mjs doesn't have`);
	for (const c of cliCommands()) if (declares(c)) assert.ok("run" in COMMANDS[c], `boxery ${c} declares a status but has no run: only a command that runs can report`);
});
