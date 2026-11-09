// boxery: the controller CLI, on your machine. controller/boxery is the shim that starts it. Every command's
// work is shared with the MCP server and the pi extension (core/): lifecycle (core/lifecycle.mjs), leases
// (core/leases.mjs), grants (core/grants.mjs), copies (vm_copy) and the host profile (core/profile.mjs).
// What is only the CLI's lives here: argument parsing, the terminal (grant approval, ssh, attach, desktop),
// and output formats (docs/cli.md), which are the same as the Bash controller's were.
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOXERY_HOME, defaultHost, hostBackend, resolveHost, withHost } from "../core/boxery-core.mjs";
import * as lifecycle from "../core/lifecycle.mjs";
import { refreshSshConfig } from "../core/profile.mjs";
import { literal, literalArgs, remotePath } from "../core/ssh-config.mjs";
import { controllerVersion, hostVersion, skewNote, upgradeHint } from "../core/versions.mjs";
import { backendCommand, hostCommand, setupNamed } from "./hosts.mjs";
import { CliError, USAGE, VALID_SNAP, VALID_VM, commandLine, die, invokedAs, usage, hasRawBytes, hint, hostFailed, hostPass, inherit, needHost, needVm, note, rawTail, say, select, vmSsh, vmSshCapture, warn } from "./lib.mjs";
import { reporting } from "./status.mjs";
import { actionHelp, registerCommands, renderCommand, renderFamily, renderTop, resolve, routedThrough, unknownAction, unknownCommand } from "./usage.mjs";
/** @import { Selected } from "./lib.mjs" */
/** @import { StatusSpec } from "./status.mjs" */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Lifecycle options for the CLI: the host's output and stdin pass through; notes go to stderr. @returns {import("../core/lifecycle.mjs").LifecycleOpts} */
const passthrough = () => ({ stdin: "inherit", stdout: "inherit", stderr: "inherit", timeout: 0, log: note, say });
/** Run a lifecycle operation; its failure ends the command as the host's does. @param {() => Promise<unknown>} fn */
async function lc(fn) { try { await fn(); } catch (e) { hostFailed(e); } }

// ---------------------------------------------------------------- grants (approval is this front-end's)

/** The grant operations, in-process (controller/grants.mjs is their CLI shape). */
const grants = () => import("./grants.mjs");

// ---------------------------------------------------------------- commands

/** @typedef {(s: Selected, args: string[], how: Dispatch) => Promise<unknown>} Command */
// (Commands are typed one by one below: their returns are void.)

/** new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--from IMAGE] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdNew(s, args) {
	let name = "", from = null, headless = false, layers = null;
	/** @type {Record<string, string>} */
	const size = {};
	/** @type {string[]} */
	const specs = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--from") { if (v == null) die("--from needs a value", USAGE); if (!/^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v ?? "")) die(`invalid image name: ${v ?? ""} (use VM@SNAP)`); from = v; i++; }
		else if (a === "--grant") { if (v == null) die("--grant needs a value", USAGE); specs.push(v); i++; }
		else if (a === "--agent-forward") specs.push("ssh-agent");
		else if (a === "--headless") headless = true;
		else if (a === "--layers") { if (v == null) die("--layers needs a value", USAGE); if (!/^[a-z0-9,-]+$/.test(v)) die(`invalid layer list: ${v}`); layers = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value", USAGE); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`, USAGE); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a.startsWith("-")) die(`unknown flag ${a}`, USAGE);
		else name = a;
	}
	needVm(name);
	// Validate and approve the whole batch before creating anything.
	const approved = specs.length ? await (await grants()).confirm(s, name, specs) : [];
	await lc(() => lifecycle.newVm(name, { ...size, from, headless, layers, grants: approved }, passthrough()));
}

/** fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB] [--grants] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdFork(s, args) {
	let src = "", copyGrants = false;
	/** @type {string[]} */
	const dsts = [];
	/** @type {Record<string, string>} */
	const size = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`, USAGE); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value", USAGE); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (a === "--grants") copyGrants = true;
		else if (a.startsWith("-")) die(`unknown flag ${a}`, USAGE);
		else { needVm(a); if (!src) src = a; else dsts.push(a); }
	}
	if (!src || !dsts.length) usage("fork");
	const g = await grants();
	const approved = copyGrants ? await g.confirmCopy(s, src, dsts) : [];
	await lc(() => lifecycle.forkVm(src, dsts, { ...size, grants: approved }, passthrough()));
}

/** patch NAME|--all [--wait S] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdPatch(s, args) {
	if (args[0] !== "--all") needVm(args[0]);
	await lc(() => lifecycle.patch(args, passthrough()));
}

/** run [--bg] NAME [--bg] [--cwd DIR] [--] CMD [ARG...] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdRun(s, args) {
	let bg = false;
	if (args[0] === "--bg") { bg = true; args = args.slice(1); }
	if (!args.length || ["-h", "--help"].includes(args[0])) {
		const h = COMMANDS.run;
		if ("help" in h) process.stdout.write(renderCommand("run", h.help));
		if (!args.length) throw new CliError("", USAGE);
		return;
	}
	const name = needVm(args[0]);
	// The bytes of every word from NAME on, by position (the command line's own, for words that aren't UTF-8).
	const raw = rawTail(args);
	let cwd = "", i = 1;
	/** @type {Buffer} */
	let cwdRaw = Buffer.alloc(0);
	for (; i < args.length; i++) {
		if (args[i] === "--cwd") { if (!args[i + 1]) runUsage(name); cwd = args[++i]; cwdRaw = raw[i]; }
		else if (args[i] === "--bg") bg = true;
		else if (args[i] === "--") { i++; break; }
		else break;
	}
	const argv = args.slice(i), argvRaw = raw.slice(i);
	if (!argv.length) runUsage(name);
	if (bg) {
		await (await grants()).reapplyQuiet(s, name);
		const { startJob } = await import("./jobs.mjs");
		const id = await startJob(s, name, argvRaw, cwd ? cwdRaw : null);
		say(id);
		note(`boxery: started ${id} on ${name}   logs: ${hint("job logs", [name, id, "-f"])}   wait: ${hint("job wait", [name, id])}`);
		literalNote(name, argv);
		return;
	}
	let line = literalArgs(argv);
	if (!cwd) line = `cd ~/project 2>/dev/null; ${line}`;
	else if (cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/")) line = `cd -- ${remotePath(cwd)} && ${line}`;
	else line = `cd -- ${remotePath(`~/project/${cwd}`)} && ${line}`;
	// Bytes that aren't UTF-8 can't be in our ssh's argv (Node encodes it): send that line base64.
	if (hasRawBytes([...argvRaw, cwdRaw])) line = `eval "$(printf %s ${rawLine(argvRaw, cwd ? cwdRaw : null).toString("base64")} | base64 -d)"`;
	const rc = await vmSsh(s, [`${name}.boxery`, line]);
	// The usual mistake is a whole command line in one argument; say how to run it instead.
	if (rc === 127 && /\s/.test(argv[0])) warn(`hint: run takes the command and its arguments separately; for a shell line use: ${hint("run", [name, "bash", "-c", argv[0]])}`);
	literalNote(name, argv);
	if (rc) throw new CliError("", rc);
}

/** Whether run's own options ask for a background job: --bg first, or among the options right after NAME
 *  (before `--` and the command). Keep it in step with cmdRun's option loop below; test/status.test.mjs lists the cases.
 *  @param {string[]} args */
export function runsInBackground(args) {
	if (args[0] === "--bg") return true;
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--cwd") i++;
		else if (args[i] === "--bg") return true;
		else break;
	}
	return false;
}

/** @param {string} name @returns {never} */
const runUsage = (name) => usage("run", { hint: `a shell line: ${hint("run", [name, "bash", "-c", "A | B"])}; see: ${hint("help", ["run"])}` });

/** run's remote command line as bytes, for arguments that aren't UTF-8: the same line, built from bytes.
 *  @param {Buffer[]} argv @param {Buffer | null} cwd */
function rawLine(argv, cwd) {
	const lit = (/** @type {Buffer} */ b) => Buffer.concat([Buffer.from("'"), Buffer.from(b.toString("latin1").replaceAll("'", "'\\''"), "latin1"), Buffer.from("'")]);
	const words = Buffer.concat(argv.flatMap((a, i) => [Buffer.from(i ? " " : ""), lit(a)]));
	const starts = (/** @type {string} */ p) => cwd?.subarray(0, p.length).equals(Buffer.from(p));
	const cd = !cwd ? Buffer.from("cd ~/project 2>/dev/null; ")
		: cwd.equals(Buffer.from("~")) ? Buffer.from('cd -- "$HOME" && ')
		: starts("~/") ? Buffer.concat([Buffer.from('cd -- "$HOME"/'), lit(cwd.subarray(2)), Buffer.from(" && ")])
		: starts("/") ? Buffer.concat([Buffer.from("cd -- "), lit(cwd), Buffer.from(" && ")])
		: Buffer.concat([Buffer.from('cd -- "$HOME"/'), lit(Buffer.concat([Buffer.from("project/"), cwd])), Buffer.from(" && ")]);
	return Buffer.concat([cd, words]);
}

/** A literal ~ or $VAR is the one argv mistake that exits 0, so point at the shell form. Commands that take
 *  code ($NF in awk, $_ in perl, a bash -c line) are skipped. @param {string} name @param {string[]} argv */
function literalNote(name, argv) {
	if (["bash", "sh", "dash", "zsh", "awk", "gawk", "mawk", "perl", "jq", "sed", "python", "python3", "node", "ruby"].includes(path.basename(argv[0]))) return;
	const a = argv.find((x) => x === "~" || x.startsWith("~/") || /\$[A-Z]/.test(x) || x.includes("${"));
	if (a !== undefined) warn(`note: ${literal(a)} was passed literally (run does not expand ~ or $VAR); to expand it in the VM: ${hint("run", [name, "bash", "-c", "…"])}`);
}

/** attach NAME [pi|opencode|shell] [session] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdAttach(s, [name = "", tool = "pi", sess = tool]) {
	needVm(name);
	const run = /** @type {Record<string, string>} */ ({ pi: "pi", opencode: "opencode", shell: "bash -l" });
	if (!Object.hasOwn(run, tool)) die(`unknown agent: ${tool} (pi, opencode or shell)`, 2);
	if (!/^[A-Za-z0-9._-]+$/.test(sess)) die(`invalid session name: ${sess}`);
	// (Without one, tmux says only "open terminal failed: not a terminal".)
	if (contractOf("attach").terminal === "stdin" && !process.stdin.isTTY) die(`attach needs a terminal; for headless work use ${hint("prompt", [name])} "TASK" or ${hint("run", ["--bg", name])} CMD`);
	await (await grants()).reapplyQuiet(s, name);
	// tmux keeps the agent alive when you disconnect (laptop sleep, network change).
	const rc = await vmSsh(s, ["-t", `${name}.boxery`, `cd ~/project 2>/dev/null; tmux has-session -t '${sess}' 2>/dev/null || tmux new-session -d -s '${sess}' -c ~/project "bash -lc '${run[tool]}; exec bash -l'"; exec tmux attach -t '${sess}'`]);
	if (rc) throw new CliError("", rc);
}

/** desktop NAME [--no-open]: core/desktop.mjs's session, its tunnel in this terminal. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdDesktop(s, [vm, noOpen]) {
	const name = needVm(vm);
	const { openUrl, prepareDesktop, tunnelArgs } = await import("../core/desktop.mjs");
	/** @type {Awaited<ReturnType<typeof prepareDesktop>>} */
	let d;
	try { d = await prepareDesktop(name, { terminal: true }); } catch (e) { die(/** @type {Error} */ (e).message); }
	if (d.warning) warn(d.warning);
	say(`==> desktop for ${name} at ${d.url}  (Ctrl-C to close the tunnel)`);
	if (noOpen !== "--no-open") setTimeout(() => void openUrl(d.url).then((ok) => { if (!ok) say(`open: ${d.url}`); }), 1500).unref();
	await exitWith(inherit("ssh", tunnelArgs(name, d.port), { env: s.config.env }));
}

/** forward NAME PORT [LOCALPORT] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdForward(s, [name = "", rport = "", lport = rport]) {
	needVm(name);
	for (const p of [rport, lport]) if (!/^[0-9]{1,5}$/.test(p)) usage("forward");
	say(`==> localhost:${lport} -> ${name}:${rport}  (Ctrl-C to stop)`);
	await exitWith(vmSsh(s, ["-N", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${lport}:127.0.0.1:${rport}`, `${name}.boxery`]));
}
/** End the command with what P (a terminal command) exited with. @param {Promise<number>} p */
async function exitWith(p) { const rc = await p; if (rc) throw new CliError("", rc); }

/** sessions NAME [--json] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdSessions(s, [vm, flag]) {
	const name = needVm(vm);
	if (flag === undefined) return exitWith(vmSsh(s, [`${name}.boxery`, 'tmux ls 2>/dev/null || echo "(no tmux sessions)"']));
	if (flag !== "--json") usage("sessions");
	const r = await vmSshCapture(s, [`${name}.boxery`, "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}' 2>/dev/null; true"]);
	if (r.code !== 0) die(`cannot reach ${name}`);
	const num = (/** @type {string} */ v) => (/^-?[0-9]+$/.test(v) ? Number(v) : null);
	const rows = r.stdout.split("\n").filter(Boolean).map((l) => {
		const [sn, w = "", c = "", at = ""] = l.split("\t");
		// (control characters other than tab and newline were dropped, as the Bash JSON writer did)
		return JSON.stringify({ name: sn.replace(/[\u0001-\u0008\u000b-\u001f]/g, ""), windows: num(w), created: num(c), attached: !["", "0"].includes(at) });
	});
	say(rows.length ? `[\n${rows.join(",\n")}\n]` : "[]");
}

/** What prompt runs in the VM (pi's print mode) and the job-log flag it points at: constants, so the flags are not prompt's own. */
const PI_PRINT = ["pi", "-p"], LOG_FOLLOW = "-f";
/** prompt NAME "task" — a headless pi task, started as a background job (pi -p TASK in ~/project) @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdPrompt(s, [name = "", ...words]) {
	needVm(name);
	const prompt = words.join(" ");
	if (!prompt) usage("prompt");
	await needPiGrant(s, name);
	// A job, like run --bg: job ls, job logs -f, job wait (it exits with pi's status) and job kill work on it.
	const { startJob } = await import("./jobs.mjs");
	const id = await startJob(s, name, [...PI_PRINT, prompt].map((w) => Buffer.from(w)), null);
	say(`started ${id} on ${name} — wait: ${hint("job wait", [name, id])}   logs: ${hint("job logs", [name, id, LOG_FOLLOW])}`);
}

/** A VM has no LLM access until it is granted, and pi without it fails at once: say so before starting a
 *  task, with the grant to ask for. (OpenShell provides LLM access itself.) @param {Selected} s @param {string} name */
async function needPiGrant(s, name) {
	if (hostBackend(s.host) === "openshell") return;
	// pi's settings (the user's, then the project's) and its models, each after a \036: whatever a login
	// script prints first is before them.
	const r = await vmSshCapture(s, [`${name}.boxery`, "for f in ~/.pi/agent/settings.json ~/project/.pi/settings.json ~/.pi/agent/models.json; do printf '\\036'; cat \"$f\" 2>/dev/null; done; true"]);
	if (r.code) throw new CliError("", r.code); // (ssh said why)
	const [settings, projectSettings, models] = r.stdout.split("\x1e").slice(-3);
	const spec = (await import("../core/grants.mjs")).missingPiGrant(name, { settings, projectSettings, models });
	if (spec) die(`pi in ${name} needs ${spec}, which ${name} has not been granted; grant it first: ${hint("access grant", [name, spec])}`);
}

/** cp FROM TO: vm_copy's own code. Needs only the profile's ssh_config, not the host. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdCp(s, args) {
	if (args.length !== 2) usage("cp", { hint: "FROM/TO: local:PATH | NAME:PATH | HOST/NAME:PATH | PATH = local" });
	for (const a of args) if (a.startsWith("-")) die(`cp takes no options (directories copy recursively); for a local path starting with -, use local:${a}`);
	const { copy } = await import("./cp.mjs");
	await copy(s.host, args);
}

/** sync NAME [--from DIR] [--to PATH] [--json]: vm_sync's own code. Needs only the profile's ssh_config. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdSync(s, args) {
	let name = "", from, to, json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--from") { if (v == null) die("--from needs a directory"); from = v; i++; }
		else if (a === "--to") { if (v == null) die("--to needs a path"); to = v; i++; }
		else if (a === "--json") json = true;
		else if (a.startsWith("-")) die(`unknown flag ${a}`);
		else if (name) usage("sync");
		else name = a;
	}
	needVm(name);
	const { sync } = await import("./sync.mjs");
	await sync(s.host, name, { from, to, json });
}

/** version [--json] @param {Selected | null} s @param {string[]} args */
async function cmdVersion(s, args) {
	const json = args[0] === "--json";
	if (args.length && !json) usage("version");
	const c = controllerVersion(ROOT);
	let h = null, noteText = null;
	if (s?.config.host) {
		h = await withHost(s.host, hostVersion);
		noteText = h ? skewNote(c, h, s.host.name) : `host predates 'boxery-host version'; upgrade it by hand (git pull or npm update -g boxery-vm, then boxery-host init), after that: ${upgradeHint(s.host.name)}`;
	}
	if (json) return say(JSON.stringify({ controller: c, host: h ? { name: h.name, version: h.version, describe: h.describe, install: h.install } : null, behind: !!noteText }));
	say(`controller  ${c.version}${c.describe ? ` (${c.describe})` : ""}`);
	if (h) say(`host        ${h.version}${h.describe ? ` (${h.describe})` : ""}  ${h.install} install  [${s?.host.name}]`);
	else if (s?.config.host) say(`host        unknown  [${s.host.name}]`);
	if (noteText) warn(noteText);
}

/** upgrade-host [--check] [--ref REF] [--wait S] [--reinit] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdUpgradeHost(s, args) {
	needHost(s);
	if (!await withHost(s.host, hostVersion))
		die(`the boxery on ${s.config.host} predates 'upgrade'. Upgrade it once by hand: on ${s.config.host}, git pull --ff-only in the checkout (or npm update -g boxery-vm), then boxery-host init for each profile`);
	await hostPass(s, ["upgrade", ...args]);
}

/** ssh NAME [cmd...] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdSsh(s, [name = "", ...rest]) {
	needVm(name);
	await (await grants()).reapplyQuiet(s, name);
	await exitWith(vmSsh(s, ["-t", `${name}.boxery`, ...rest]));
}

/** @typedef {import("./usage.mjs").Help} Help */
/** What main() and the handlers read about a command, beside its handler: where it runs, what it owns of the
 *  words after its name, and what it needs of the terminal. Ordinary commands (a selected host, the legacy help
 *  convention) say nothing: CONTRACT_DEFAULTS. test/cli-contracts.test.mjs pins the table.
 *  - scope: `host` runs on the selected host; `controller` runs here (its `local` handler) and no host is
 *    selected; `registry` (a family action only) edits this machine's registry, though `host add DEST` contacts DEST.
 *  - noHost: the refusal when --host is given to a command that has no host to select.
 *  - hostOptional: with no --host and no default host, `local` runs instead of a handler needing a host.
 *  - allHosts: without --host, read-only text listings span hosts (all-hosts.mjs; ls uses its third argument).
 *    JSON, VM-name commands and mutating actions retain their selected-host handlers.
 *  - vmAtHost: the first word may be NAME@HOST, which selects HOST like --host.
 *  - help: how -h/--help is told from payload. `legacy`: a leading flag, or one word then the flag (snap demo
 *    --help). `leading`: only a leading flag; after that the words are the command's (run demo --help). `self`:
 *    the command renders help, so its words are never a help flag.
 *  - payload: words the command passes on instead of parsing. `argv`: exec'd as given. `shell`: joined and run by
 *    the VM's shell. `task`: free text for an agent. `agent`: an agent tool and session name.
 *  - terminal: `stdin`: needs a terminal on stdin (attach), whatever it is given. `approval`: asks a person on
 *    /dev/tty only when it grants something (controller/grants.mjs ask; GRANT_CONFIRM=off in the profile's config skips it).
 *  @typedef {{ scope: "host" | "controller" | "registry", help: "legacy" | "leading" | "self", noHost?: string, hostOptional?: true, allHosts?: true, vmAtHost?: true, payload?: "argv" | "shell" | "task" | "agent", terminal?: "stdin" | "approval" }} Contract */
/** How each command is dispatched unless its `contract` says otherwise. @type {Contract} */
const CONTRACT_DEFAULTS = { scope: "host", help: "legacy" };
/** What a handler is told about how it was reached. @typedef {{ allHosts: boolean }} Dispatch */
/** A family action: a command's handler (`command`; `args` turns the action's arguments into the command's), with its help.
 *  host's registry actions (add, ls, show, use, rm) have no command: they say `scope: "registry"` and `noHost`, and
 *  main() runs them before any host is selected. @typedef {import("../help/index.mjs").Action & { args?: (args: string[]) => string[], scope?: "registry", noHost?: string }} FamilyAction */
/** A command: its help, its contract and what it runs (with a selected host). Aliases name their command. A
 *  `controller` command (help, setup) has no `run`, only `local`, which main() runs without selecting a host; so
 *  does version without a host. A family has `actions` instead of `run` (and `defaultAction` for a bare `boxery FAMILY`):
 *  each runs another command's handler, and the action inherits that command's contract.
 *  @typedef {{ help: Help, run?: Command, local?: (args: string[]) => unknown, status?: StatusSpec, contract?: Partial<Contract>, defaultAction?: string, actions?: Record<string, FamilyAction> } | { alias: string }} Entry */

const JSON_FLAG = /** @type {[string, string]} */ (["--json", "Print JSON (fields: docs/cli.md#json-output)"]);
// Captures differ by backend (#219; backends/index.mjs, diskSnapshots).
const CAPTURE_NOTE = "Most backends capture a running VM live (libvirt and cloud-hypervisor in about a second, exe.dev in about 12 s); Lima stops it and starts it again (about 10 s on vz), so its processes, tmux sessions and jobs end.";
const SIZE_FLAGS = /** @type {[string, string][]} */ ([["--shape S", "A size from boxery shapes"], ["--cpus N", "CPUs"], ["--mem MiB", "Memory, in MiB"], ["--disk GiB", "Disk, in GiB"]]);
const HOST_MGMT = "--host does not apply to host management";
const RUN_RULES = "Arguments are passed exactly as given, like docker exec: quotes, $, ~, globs and ; are not re-parsed in the VM. For pipes, &&, ~ or $VAR, run a shell: bash -c '...'.";

/** Every boxery command and its help (boxery help and COMMAND --help are rendered from this). @type {Record<string, Entry>} */
export const COMMANDS = {
	// ------------------------------------------------ setup & hosts
	setup: {
		contract: { scope: "controller", noHost: "setup takes --name NAME, not --host" },
		local: setupNamed,
		help: {
			group: "start", summary: "configure a VM host (local = this machine), register your ssh key",
			usage: ["setup user@host|local [--name NAME] [--key K.pub] [--host-bin PATH] [--profile P [--backend B]]", "setup local --backend openshell [OPTIONS]"],
			details: ["OpenShell has its own options (gateway, image, policy, providers): boxery setup local --backend openshell --help."],
			flags: [["--name NAME", "Register the host as NAME (default: local, or the host part of user@host)"], ["--key K.pub", "The ssh public key VMs trust (default: ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub; else the key your registered hosts use; else another ~/.ssh/id_*.pub)"], ["--host-bin PATH", "boxery-host on the host, when it isn't on its PATH"], ["--profile P", "Use (or create, with --backend) profile P on the host"], ["--backend B", "The backend for a new profile (boxery host backends lists them)"]],
			examples: [["A Linux box you reach over ssh", "boxery setup you@my-host"], ["This machine", "boxery setup local"]],
			seeAlso: ["host", "host build-base", "host backends"], docs: "install.md",
		},
	},
	host: {
		defaultAction: "ls",
		help: {
			group: "families", summary: "named hosts, and maintenance of the selected host", list: "host add|ls|show|use|rm|…", usage: [],
			details: ["add, ls, show, use and rm manage this machine's registry and take no --host. add NAME DEST runs setup on DEST; importing --config-dir and the other registry actions stay local. Maintenance actions act on the selected host (--host NAME, else the default)."],
			examples: [["Add a second machine and make it the default", "boxery host add hornet you@hornet && boxery host use hornet"], ["One command on another host", "boxery --host hornet ls"], ["Upgrade boxery on a registered host", "boxery --host hornet host upgrade --check"]],
			seeAlso: ["setup"], docs: "hosts.md",
		},
		// (add, ls, show, use and rm have no command: controller/hosts.mjs runs them before any host is selected.)
		actions: {
			add: {
				scope: "registry", noHost: HOST_MGMT,
				help: {
					summary: "register DEST (user@host or local) as NAME", usage: ["host add NAME DEST [--key K.pub] [--host-bin PATH] [--backend B | --profile P]", "host add NAME --config-dir DIR"],
					flags: [["--backend B", "Create a new profile on DEST for backend B (own state, proxy port and services)"], ["--profile P", "Use an existing profile on DEST"], ["--config-dir DIR", "Import an existing profile directory without setup"], ["--key K.pub", "The ssh public key VMs trust (default: ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub; else the key your registered hosts use; else another ~/.ssh/id_*.pub)"], ["--host-bin PATH", "boxery-host on the host, when it isn't on its PATH"]],
					examples: [["A machine you reach over ssh", "boxery host add hornet you@hornet"], ["A second backend on this machine", "boxery host add exe local --backend exe"]], docs: "hosts.md",
				},
			},
			ls: { scope: "registry", noHost: HOST_MGMT, help: { summary: "list hosts: where each runs and its backend", usage: ["host ls [--json]"], flags: [JSON_FLAG], docs: "hosts.md" } },
			show: { scope: "registry", noHost: HOST_MGMT, help: { summary: "print a host's profile directory", usage: ["host show NAME"], docs: "hosts.md" } },
			use: { scope: "registry", noHost: HOST_MGMT, help: { summary: "make NAME the default host", usage: ["host use NAME"], docs: "hosts.md" } },
			rm: { scope: "registry", noHost: HOST_MGMT, help: { summary: "forget a host (its VMs and profile data stay)", usage: ["host rm NAME"], docs: "hosts.md" } },
			"build-base": { command: "build-base" },
			upgrade: { command: "upgrade-host" },
			"proxy-log": { command: "proxy-log" },
			backend: { command: "backend" },
			backends: { command: "backends" },
			capabilities: { command: "capabilities" },
		},
	},
	"build-base": {
		help: { group: "legacy", summary: "build the host's desktop base image (one time, ~3 min)", usage: ["build-base"], details: ["Headless VMs (new --headless) don't need it."], docs: "cli.md#lifecycle" },
		status: {},
		run: async (s, args) => { needHost(s); if (args.length) usage("build-base"); await lc(() => lifecycle.buildBase(passthrough())); },
	},

	// ------------------------------------------------ VMs
	ls: {
		help: {
			group: "vms", summary: "list VMs: every host's, a section each (--host NAME: one)", usage: ["ls [--json] [--refresh] [--running]"],
			details: ["One header for every host's rows. STATUS says what is worth knowing about a VM: its pool lease, outdated guest software (see boxery patch) and grants. Notes come after the table, on stderr; a host that can't be reached fails ls once the others are listed. --json lists one host."],
			flags: [JSON_FLAG, ["--refresh", "Read the guest software record from each running VM first"], ["--running", "Only running VMs"]],
			examples: [["Every host's VMs", "boxery ls"], ["One host's running VMs", "boxery --host hornet ls --running"]],
			seeAlso: ["patch", "host"], docs: "cli.md#lifecycle",
		},
		run: async (s, args, how) => (await import("./ls.mjs")).ls(s, args, { allHosts: how.allHosts }),
		contract: { allHosts: true },
	},
	list: { alias: "ls" },
	new: {
		help: {
			group: "vms", summary: "create a VM", usage: ["new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward]", "new NAME --from VM@SNAP"],
			flags: [...SIZE_FLAGS, ["--headless", "No desktop (shell and agents only); needs no build-base"], ["--layers L,...", "Extra image layers for a headless VM (github-runner)"], ["--from VM@SNAP", "Start from a snapshot (boxery snapshot images lists them)"], ["--grant SPEC", "Grant access at creation (asks first; see boxery access grant)"], ["--agent-forward", "Same as --grant ssh-agent"]],
			examples: [["A desktop VM", "boxery new demo"], ["A larger, headless one", "boxery new ci-1 --headless --shape large"], ["A GitHub Actions runner VM", "boxery new runner-1 --headless --layers github-runner"]],
			seeAlso: ["shapes", "fork", "rm"], docs: "cli.md#lifecycle",
		},
		status: { vm: true },
		run: async (s, args) => { needHost(s); await cmdNew(s, args); },
		contract: { terminal: "approval" },
	},
	start: {
		help: { group: "vms", summary: "start a stopped VM (pins its ssh host key where it can)", usage: ["start NAME"], seeAlso: ["stop"] },
		status: { vm: true },
		run: async (s, [n]) => { needHost(s); await lc(() => lifecycle.startVm(needVm(n), passthrough())); },
	},
	stop: {
		help: { group: "vms", summary: "stop a VM", usage: ["stop NAME"], seeAlso: ["start"] },
		status: { vm: true },
		run: async (s, [n]) => { needHost(s); await lc(() => lifecycle.stopVm(needVm(n), passthrough())); },
	},
	rm: {
		help: { group: "vms", summary: "destroy a VM and its snapshots (revokes its LLM token)", usage: ["rm NAME"] },
		run: async (s, [n]) => { needHost(s); await lc(() => lifecycle.rmVm(needVm(n), passthrough())); },
	},
	resize: {
		help: {
			group: "vms", summary: "change a VM's size (restarts it if running; disk only grows)", usage: ["resize NAME [--cpus N] [--mem MiB] [--disk GiB]"],
			details: ["A running VM is stopped, resized and started again: its tmux sessions end and its grants are pushed again. Sizes it already has are ignored."],
			flags: SIZE_FLAGS.slice(1), examples: [["8 CPUs and 16 GiB of memory", "boxery resize demo --cpus 8 --mem 16384"]], docs: "cli.md#lifecycle",
		},
		// A resize restarts a running VM: the connection is stale afterwards and tmpfs grants are gone.
		status: { vm: true },
		run: async (s, [n, ...rest]) => {
			needHost(s); needVm(n);
			/** @type {Record<string, string>} */
			const size = {};
			if (!rest.length) usage("resize");
			for (let i = 0; i < rest.length; i += 2) {
				if (!["--cpus", "--mem", "--disk"].includes(rest[i]) || rest[i + 1] == null) usage("resize");
				size[rest[i].slice(2)] = rest[i + 1]; // (the host checks the values)
			}
			await lc(() => lifecycle.resizeVm(n, size, passthrough()));
		},
	},
	fork: {
		help: {
			group: "vms", summary: "copy a VM (running or not) into new VMs, ~10 s", usage: ["fork SRC DST... [--grants] [--shape S] [--cpus N --mem MiB --disk GiB]"],
			details: ["Each fork has SRC's disk (not its processes) with its own hostname, LLM token, ssh keys and network identity, and SRC's size unless --shape or size flags say otherwise.", CAPTURE_NOTE],
			flags: [["--grants", "Give the forks SRC's grants too (asks for each)"], ...SIZE_FLAGS],
			examples: [["Two copies to try two approaches", "boxery fork demo try-a try-b"]], seeAlso: ["snapshot create", "new"], docs: "cli.md#snapshots-and-forks",
		},
		status: { vm: true },
		run: async (s, args) => { needHost(s); await cmdFork(s, args); },
		contract: { terminal: "approval" },
	},
	patch: {
		help: {
			group: "vms", summary: "update a VM's guest software to the host's image layers", usage: ["patch NAME|--all [--wait S]"],
			details: ["Security updates and kernel, browsers, agent CLIs and node; the VM restarts if the updates ask to. A pool VM must be free, and its clean image is captured again. Snapshots keep their old software."],
			flags: [["--all", "Every running VM, in turn"], ["--wait S", "Wait up to S seconds for a pool VM's lease to end"]],
			seeAlso: ["ls"], docs: "cli.md#lifecycle",
		},
		status: { vm: true },
		run: async (s, args) => { needHost(s); await cmdPatch(s, args); },
	},
	pin: {
		help: {
			group: "more", summary: "re-pin a VM's ssh host key (VMs made before keys were pinned)", usage: ["pin NAME [--from-guest]"],
			flags: [["--from-guest", "Trust what the VM's ssh endpoint answers, once"]], docs: "security.md#vm-host-keys",
		},
		// Re-pin a VM's ssh host key on the host (a VM made before keys were pinned, or whose record was lost).
		run: async (s, args) => {
			needHost(s); const n = needVm(args[0]);
			if (!["", "--from-guest"].includes(args[1] ?? "") || args.length > 2) usage("pin");
			await lc(() => lifecycle.pinVm(n, { fromGuest: args[1] === "--from-guest" }, passthrough()));
		},
	},
	shapes: {
		contract: { allHosts: true },
		help: { group: "more", summary: "VM sizes on every host (* = default; --host NAME: one)", usage: ["shapes [--json]"], details: ["A section per host. --host NAME or --json selects one host."], flags: [JSON_FLAG], docs: "shapes.md" },
		run: async (s, args) => { needHost(s); if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) usage("shapes"); await hostPass(s, ["shapes", ...args]); },
	},

	// ------------------------------------------------ snapshots
	snap: {
		help: { group: "legacy", summary: "snapshot a VM's disk (Lima restarts a running VM)", usage: ["snap NAME [SNAP]"], details: [CAPTURE_NOTE], seeAlso: ["snapshot ls", "snapshot restore", "snapshot rm"], docs: "cli.md#snapshots-and-forks" },
		status: { vm: true },
		run: async (s, args) => {
			needHost(s);
			if (args[1] && !VALID_SNAP.test(args[1])) die(`invalid snapshot name: ${args[1]}`);
			await lc(() => lifecycle.snapVm(needVm(args[0]), args[1] || null, passthrough()));
		},
	},
	snaps: {
		help: { group: "legacy", summary: "list a VM's snapshots", usage: ["snaps NAME [--json]"], flags: [JSON_FLAG] },
		run: async (s, args) => { needHost(s); needVm(args[0]); await hostPass(s, ["snaps", ...args]); },
	},
	revert: {
		help: { group: "legacy", summary: "restore a VM to a snapshot (keeps its name, address and token)", usage: ["revert NAME SNAP"] },
		// A revert restores the snapshot's tmpfs too: grants are always reconciled to the current ones.
		status: { vm: true },
		run: async (s, [n, snap]) => { needHost(s); if (!snap) usage("revert"); if (!VALID_SNAP.test(snap)) die(`invalid snapshot name: ${snap ?? ""}`); await lc(() => lifecycle.revertVm(needVm(n), snap, passthrough())); },
	},
	"snap-rm": {
		help: { group: "legacy", summary: "delete a snapshot", usage: ["snap-rm NAME SNAP"] },
		run: async (s, args) => {
			needHost(s);
			if (!args[1] || !VALID_SNAP.test(args[1])) usage("snap-rm");
			await lc(() => lifecycle.snapRm(needVm(args[0]), args[1], passthrough()));
		},
	},
	images: {
		contract: { allHosts: true },
		help: { group: "legacy", summary: "snapshots on every host, with HOST column (--host NAME: one)", usage: ["images [--json]"], details: ["Snapshots usable by new NAME --from VM@SNAP, with a HOST column. --host NAME or --json selects one host, without the extra column."], flags: [JSON_FLAG] },
		run: async (s, args) => hostPass(s, ["images", ...args]),
	},

	snapshot: {
		help: {
			group: "families", summary: "saved VM disk states: create, restore, list, delete", usage: [],
			details: ["A snapshot is a VM's disk saved as VM@SNAP, without its memory or processes. new NAME --from VM@SNAP starts a VM from one; fork copies a VM's current disk instead."],
			examples: [["Save a VM before a risky change", "boxery snapshot create demo before-refactor"], ["Go back to it", "boxery snapshot restore demo before-refactor"], ["Start another VM from it", "boxery new try --from demo@before-refactor"]],
			seeAlso: ["fork", "new"], docs: "cli.md#snapshots-and-forks",
		},
		actions: { create: { command: "snap" }, ls: { command: "snaps" }, restore: { command: "revert" }, rm: { command: "snap-rm" }, images: { command: "images" } },
	},

	// ------------------------------------------------ work in a VM
	ssh: {
		help: {
			group: "use", summary: "shell into a VM (also: ssh NAME.boxery)", usage: ["ssh NAME[@HOST] [CMD...]"],
			details: ["NAME@HOST selects a registered host without changing the default. If --host is also given, it must match HOST.", "With CMD, plain ssh semantics: the words are joined and run by the VM's shell."],
			examples: [["A VM on another registered host", "boxery ssh demo@lab"], ["Run a command there", "boxery ssh demo@lab hostname"]],
			seeAlso: ["run"],
		},
		run: async (s, args) => { needHost(s); await cmdSsh(s, args); },
		contract: { help: "leading", payload: "shell", vmAtHost: true },
	},
	run: {
		help: {
			group: "use", summary: "run a command in ~/project, args as given (like docker exec)", usage: ["run [--bg] NAME [--cwd DIR] [--] CMD [ARG...]"],
			details: [RUN_RULES, "The exit code is the command's. A relative --cwd is under ~/project; ~/ expands in the VM; absolute paths are used as is."],
			flags: [["--bg", "Run as a background job; prints the job id (see boxery job ls)"], ["--cwd DIR", "Working directory"], ["--", "End run's options"]],
			examples: [["Args are passed as-is: quotes, $, *, ; stay literal", "boxery run demo pnpm test"], ["In ~/project/modem", "boxery run demo --cwd modem git log -1"], ["Pipes, ~, $VAR and globs need bash -c", "boxery run demo bash -c 'ls ~ | wc -l; echo $HOME'"], ["Not this: one argument is one command name (fails with a hint)", "boxery run demo 'make test'"]],
			seeAlso: ["job ls", "ssh"], docs: "cli.md#shell-and-in-vm-agents",
		},
		status: { vm: true, when: (a) => !runsInBackground(a) }, // --bg returns at once
		run: async (s, args) => { needHost(s); await cmdRun(s, args); },
		contract: { help: "leading", payload: "argv" },
	},
	cp: {
		help: {
			group: "use", summary: "copy files and directories to, from and between VMs", usage: ["cp FROM TO"],
			details: ["Locations: local:PATH, NAME:PATH (a VM on the selected host) or HOST/NAME:PATH; a bare PATH is on this machine. VM paths are relative to ~/project. Directories copy recursively."],
			examples: [["This machine to a VM (~/project/repo.bundle)", "boxery cp ./repo.bundle demo:"], ["VM to VM, across named hosts", "boxery cp demo:out.zip hornet/worker:in.zip"]],
			docs: "copy.md",
		},
		status: {},
		run: cmdCp,
	},
	sync: {
		help: {
			group: "use", summary: "push a local git checkout into a VM, so its tree matches exactly", usage: ["sync NAME [--from DIR] [--to PATH] [--json]"],
			details: [
				"git pushes the commits the VM lacks over its ssh connection, checks out the same commit (detached) and applies staged, unstaged and untracked changes, deletions included. Ignored files in the VM (node_modules, builds) stay. No git remote or GitHub access is needed on either side.",
				"Refuses, changing nothing, when the VM checkout has changes the last sync didn't make, or the checkout holds a credential file (.env, .npmrc, auth files).",
			],
			flags: [["--from DIR", "Local checkout (default: the current directory)"], ["--to PATH", "VM directory (default ~/project; relative paths are under it)"], ["--json", "Print the result as JSON"]],
			examples: [["This checkout into demo's ~/project", "boxery sync demo"], ["Another checkout, into ~/api (not inside ~/project, which is a checkout itself)", "boxery sync demo --from ../api --to ~/api"]],
			seeAlso: ["cp"], docs: "sync.md",
		},
		status: { vm: true },
		run: cmdSync,
	},
	desktop: {
		help: { group: "use", summary: "open a VM's desktop in your browser (noVNC over ssh)", usage: ["desktop NAME [--no-open]"], flags: [["--no-open", "Print the URL instead of opening it"]], docs: "cli.md#desktop-and-ports" },
		run: async (s, args) => { needHost(s); await cmdDesktop(s, args); },
	},
	forward: {
		help: { group: "use", summary: "forward a VM port to localhost", list: "forward NAME PORT [LOCAL]", usage: ["forward NAME PORT [LOCAL_PORT]"], examples: [["The VM's dev server on localhost:3000", "boxery forward demo 3000"]] },
		run: async (s, args) => { needHost(s); await cmdForward(s, args); },
	},
	attach: {
		help: {
			group: "use", summary: "attach to an agent in a persistent tmux session", list: "attach NAME [AGENT]", usage: ["attach NAME [pi|opencode|shell] [SESSION]"],
			details: ["The session keeps running when you detach (Ctrl-b d) or disconnect. It needs a terminal; for headless work use prompt or run --bg."], seeAlso: ["agent ls", "prompt"],
		},
		run: async (s, args) => { needHost(s); await cmdAttach(s, args); },
		contract: { terminal: "stdin", payload: "agent" },
	},
	prompt: {
		help: { group: "use", summary: "start a headless pi task as a background job", usage: ['prompt NAME "TASK"'], details: ["It runs pi -p TASK in ~/project as a background job and prints its id: job ls, job logs -f, job wait (exits with pi's status) and job kill work on it. pi -p prints its answer when it finishes, so the log can stay empty until then.", "pi needs the llm: grant for its provider (llm:chatgpt by default); without it prompt starts nothing and says what to grant."] },
		run: async (s, args) => { needHost(s); await cmdPrompt(s, args); },
		contract: { payload: "task" },
	},
	sessions: {
		help: { group: "legacy", summary: "list a VM's tmux sessions", usage: ["sessions NAME [--json]"], flags: [JSON_FLAG] },
		run: async (s, args) => { needHost(s); await cmdSessions(s, args); },
	},

	agent: {
		help: {
			group: "families", summary: "persistent coding-agent sessions in a VM", usage: [],
			details: ["attach and ls work on tmux sessions in the VM: they keep running when you detach or disconnect. prompt starts a headless task as a background job (see job). attach and prompt are also top-level commands, for everyday use."],
			examples: [["Attach to pi (the same as: boxery attach demo)", "boxery agent attach demo"], ["opencode instead", "boxery agent attach demo opencode"], ["A headless task (the same as: boxery prompt …)", "boxery agent prompt demo TASK"], ["The VM's sessions", "boxery agent ls demo"]],
			seeAlso: ["job"], docs: "cli.md#shell-and-in-vm-agents",
		},
		actions: { attach: { command: "attach" }, prompt: { command: "prompt" }, ls: { command: "sessions" } },
	},

	// ------------------------------------------------ background jobs
	jobs: {
		help: {
			group: "legacy", summary: "list background jobs (run --bg starts one)", usage: ["jobs NAME [--json]", "jobs NAME --prune [--older-than 7d] [--json]"],
			details: ["States: running, exited, or lost (it stopped without recording an exit code). exited+ means it left processes running."],
			flags: [JSON_FLAG, ["--prune", "Delete finished jobs and their logs"], ["--older-than D", "With --prune: only jobs older than D (e.g. 7d)"]],
			seeAlso: ["run", "job logs", "job wait", "job kill"], docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).jobs(s, args); },
	},
	logs: {
		help: {
			group: "legacy", summary: "show a job's output (the last 200 lines)", usage: ["logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]"],
			flags: [["-f, --follow", "Follow until the job ends"], ["-n, --lines N", "The last N lines"], ["--tail N", "Same as --lines"], ["--bytes N", "Clip each read to its last N bytes"], ["--strip-ansi", "Remove colours and terminal escapes"]],
			docs: "cli.md#background-command-jobs",
		},
		status: { vm: true, when: (a) => a.includes("-f") || a.includes("--follow") }, // only following takes a while
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).logs(s, args); },
	},
	wait: {
		help: {
			group: "legacy", summary: "wait for a job; exits with its exit code", usage: ["wait NAME JOB [--timeout S] [--json]"],
			details: ["Exits 124 if --timeout passes first (the job keeps running) and 125 if the job is lost. Scripts that must tell these from the job's own codes should use --json."],
			flags: [["--timeout S", "Give up after S seconds"], JSON_FLAG], docs: "cli.md#background-command-jobs",
		},
		status: { vm: true },
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).waitJob(s, args); },
	},
	kill: {
		help: {
			group: "legacy", summary: "stop a job: SIGTERM its process group, then SIGKILL", usage: ["kill NAME JOB [--grace S] [--json]"],
			flags: [["--grace S", "Seconds between SIGTERM and SIGKILL (default 5)"], JSON_FLAG], docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).kill(s, args); },
	},

	job: {
		help: {
			group: "families", summary: "background jobs in a VM (run --bg starts one)", usage: [],
			details: ["A job keeps running when you disconnect. Start one with run --bg; these list, read, wait for and stop them."],
			examples: [["Start a job, which prints its id", "boxery run --bg demo pnpm test"], ["Follow its output", "boxery job logs demo JOB -f"], ["Wait for it and exit with its exit code", "boxery job wait demo JOB --timeout 600"]],
			seeAlso: ["run", "agent"], docs: "cli.md#background-command-jobs",
		},
		actions: { ls: { command: "jobs" }, logs: { command: "logs" }, wait: { command: "wait" }, kill: { command: "kill" } },
	},

	// ------------------------------------------------ access
	grant: {
		help: {
			group: "legacy", summary: "give a VM access to something on this machine (asks first)", usage: ["grant NAME SPEC... [--cmd CMD]"],
			details: ["SPEC is one of:\n  llm:chatgpt|openai|anthropic|ollama   LLM access (VMs have none without it)\n  github [--readonly]                   GitHub over HTTPS; the token stays here\n  http:HOST --cmd CMD [--auth bearer|basic:USER|header:NAME] [--readonly]\n                                        an HTTP API; the secret never enters the VM\n  ssh-agent                             forward your ssh agent\n  env:VAR [--cmd CMD]                   push an environment variable\n  file:LOCAL[=REMOTE]                   push a file", "Adding access prompts on your terminal and defaults to No."],
			flags: [["--cmd CMD", "env: and http: grants: the command on this machine that prints the secret"], ["--auth A", "http: grants: bearer (default), basic:USER or header:NAME"], ["--readonly", "http: and github grants: GET/HEAD and git fetch only"]],
			examples: [["Let the VM use your Anthropic subscription", "boxery grant demo llm:anthropic"], ["Read-only GitHub", "boxery grant demo github --readonly"]],
			seeAlso: ["access revoke", "access ls", "access apply"], docs: "grants.md",
		},
		run: async (s, args) => { needHost(s); await (await grants()).grant(s, args); },
		contract: { terminal: "approval" },
	},
	revoke: {
		help: { group: "legacy", summary: "take access away (pushed values are deleted from the VM)", usage: ["revoke NAME SPEC...|all"], docs: "grants.md" },
		run: async (s, args) => { needHost(s); await (await grants()).revoke(s, args); },
	},
	grants: {
		help: { group: "legacy", summary: "show a VM's grants, or push them again (apply)", list: "grants NAME [apply]", usage: ["grants NAME [apply [--quiet] | --json]"], flags: [JSON_FLAG], docs: "grants.md" },
		run: async (s, args) => (await grants()).grantsCommand(s, args),
	},
	"agent-forward": {
		help: { group: "legacy", summary: "same as access grant|revoke NAME ssh-agent", usage: ["agent-forward NAME on|off"] },
		run: async (s, args) => (await grants()).agentForward(s, args),
		contract: { terminal: "approval" },
	},

	access: {
		help: {
			group: "families", summary: "what a VM may use from this machine (grants)", usage: [],
			details: ["Adding access asks on your terminal and defaults to No. Listing, revoking and applying never ask. Listing reads saved specifications, not secret values, but does show stored --cmd text: keep secrets out of command literals. agent-forward NAME on|off still works: it is access grant|revoke NAME ssh-agent."],
			examples: [["Let the VM use your Anthropic subscription", "boxery access grant demo llm:anthropic"], ["What the VM has been granted", "boxery access ls demo"], ["Take access away", "boxery access revoke demo github"]],
			docs: "grants.md",
		},
		actions: {
			grant: { command: "grant" },
			revoke: { command: "revoke" },
			// ls and apply are `grants`' two jobs, kept apart: ls is read-only and refuses anything else.
			ls: {
				command: "grants",
				args: (a) => { if (a.length > 2 || (a.length === 2 && a[1] !== "--json")) usage("access", { sub: "ls" }); return a; },
				help: { summary: "show a VM's grant kinds and settings (read-only)", usage: ["access ls NAME [--json]"], details: ["Shows saved specifications, including --cmd text, without executing value commands or reading granted files or environment values. With none recorded, checks the host's inventory to catch a missing VM. A secret embedded in a command literal is therefore visible; use commands that read a secret store instead."], examples: [["What demo has been granted", "boxery access ls demo"]] },
			},
			apply: {
				command: "grants",
				args: (a) => { if (a.length < 1 || a.length > 2 || (a.length === 2 && a[1] !== "--quiet")) usage("access", { sub: "apply" }); return [a[0], "apply", ...a.slice(1)]; },
				help: {
					summary: "push a VM's grants to it again", usage: ["access apply NAME [--quiet]"], flags: [["--quiet", "Only print warnings"]],
					details: ["Pushed grants (env: and file:) live in the VM's tmpfs and are gone after a reboot; ssh, attach and run --bg apply them again by themselves. Nothing new is granted."],
					examples: [["After a VM restarted", "boxery access apply demo"]],
				},
			},
		},
	},

	// ------------------------------------------------ pool & runners
	acquire: {
		help: {
			group: "legacy", summary: "lease a VM from the shared pool (prints NAME LEASE_ID)", usage: ["acquire [--ttl S] [--wait S] [--holder H]"],
			flags: [["--ttl S", "Lease length in seconds (default 1800)"], ["--wait S", "Wait up to S seconds for a free VM"], ["--holder H", "Who holds the lease, as the host shows it (default: user@machine)"]],
			seeAlso: ["lease renew", "lease release", "lease ls"], docs: "pool.md",
		},
		status: { when: (a) => a.some((w, i) => w === "--wait" && Number(a[i + 1]) > 0) }, // only waiting for a free VM takes a while
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "acquire", args); },
	},
	renew: {
		help: { group: "legacy", summary: "extend your lease", usage: ["renew NAME [--ttl S]"], flags: [["--ttl S", "New lease length in seconds"]], docs: "pool.md" },
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "renew", args); },
	},
	release: {
		help: { group: "legacy", summary: "give a leased VM back (it is reset to its clean snapshot)", usage: ["release NAME"], docs: "pool.md" },
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "release", args); },
	},
	leases: {
		contract: { allHosts: true },
		help: { group: "legacy", summary: "your leases on every host (--host NAME: one)", usage: ["leases [--json]"], details: ["Locally held leases, a section per host; no host is contacted. --host NAME or --json selects one host."], flags: [JSON_FLAG], docs: "pool.md" },
		run: async (s, args) => (await import("./leases.mjs")).leaseCommand(s, "leases", args),
	},
	lease: {
		help: {
			group: "families", summary: "borrow a VM from the shared pool", usage: [],
			details: ["A lease is an exclusive, expiring claim on a pool VM. Releasing it, or letting it expire, resets the VM. Adding VMs to the pool is pool."],
			examples: [["Borrow a VM for 10 minutes, waiting up to a minute", "boxery lease acquire --ttl 600 --wait 60"], ["Keep it longer", "boxery lease renew pool1"], ["Give it back", "boxery lease release pool1"]],
			seeAlso: ["pool"], docs: "pool.md",
		},
		actions: { acquire: { command: "acquire" }, renew: { command: "renew" }, release: { command: "release" }, ls: { command: "leases" } },
	},
	pool: {
		contract: { allHosts: true },
		help: { group: "families", summary: "manage the shared pool of leasable VMs (admin)", details: ["ls lists every host unless --host NAME or --json is given. add and rm stay on the selected host."], usage: ["pool add NAME", "pool rm NAME [--force]", "pool ls [--json]"], list: "pool add|rm|ls", docs: "pool.md" },
		status: { vm: 1, when: (a) => a[0] === "add" }, // add captures the VM's clean snapshot (a restart on Lima); rm and ls are quick
		run: async (s, args) => { needHost(s); await lc(() => lifecycle.pool(args, passthrough())); },
	},
	runners: {
		contract: { allHosts: true },
		help: {
			group: "families", summary: "GitHub Actions runners on pool VMs", list: "runners once|status|...",
			usage: ["runners once [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--labels L,...] [--group ID]", "runners status [--json] | start | stop | token < FILE", "runners config [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--count N] [--labels L,...] ..."],
			details: ["once: a local runner. One job on a fresh pool VM, registered with your gh login; nothing is stored on the host. --repo defaults to this directory's repo.", "status, start, stop, config, token: host runners (admin). The host keeps runners waiting, with its own GitHub token. status lists every host unless --host NAME or --json is given; other actions stay on the selected host."],
			docs: "github-runners.md",
		},
		// GitHub Actions runners on the host's pool (docs/github-runners.md): `once` (local runners) runs here with
		// this machine's gh login; the rest (host runners) is passed through, and `token` reads stdin.
		status: { when: (a) => a[0] === "once" }, // once runs a whole job; the rest are host calls
		run: async (s, args) => {
			needHost(s);
			if (args[0] === "once") return (await import("./runners-once.mjs")).runnersOnce(s, args.slice(1));
			await hostPass(s, ["runners", ...args]);
		},
	},

	// ------------------------------------------------ host & diagnostics
	version: {
		help: { group: "more", summary: "controller and every host's version; warns per host", usage: ["version [--json]"], details: ["boxery --version and boxery -V are the same as boxery version. --host NAME or --json selects one host; otherwise each host has a section after the controller."], flags: [JSON_FLAG], seeAlso: ["host upgrade"] },
		run: async (s, args) => cmdVersion(s, args),
		local: (args) => cmdVersion(null, args),
		contract: { hostOptional: true, allHosts: true },
	},
	"upgrade-host": {
		contract: { allHosts: true },
		help: {
			group: "legacy", summary: "update boxery on the host and restart its services", usage: ["upgrade-host [--check] [--ref REF] [--wait S] [--reinit]"],
			details: ["Waits for in-flight VM operations and rolls back if checks fail. --check lists every host unless --host NAME is given; real upgrades stay on the selected host."],
			flags: [["--check", "Only report the install, its target version and profiles"], ["--ref REF", "Upgrade to this git ref or npm version"], ["--wait S", "Wait up to S seconds for in-flight operations"], ["--reinit", "Re-run init for every profile even when up to date"]],
			docs: "install.md#upgrading",
		},
		status: { when: (a) => !a.includes("--check") },
		run: cmdUpgradeHost,
	},
	backends: {
		contract: { allHosts: true },
		help: { group: "legacy", summary: "backend support and capabilities on every host", usage: ["backends [--json]"], details: ["Requirements and capability declarations, a section per host. --host NAME or --json selects one host."], flags: [JSON_FLAG], docs: "backends.md" },
		run: async (s, args) => hostPass(s, ["backends", ...args]),
	},
	capabilities: {
		contract: { allHosts: true },
		help: { group: "legacy", summary: "every host's platform and capabilities (--host NAME: one)", usage: ["capabilities [--json | --check]"], details: ["A section per host, including --check. --host NAME or --json selects one host."], flags: [JSON_FLAG, ["--check", "Run the backend preflight; fails when a requirement is missing"]], docs: "backends.md" },
		run: async (s, args) => hostPass(s, ["capabilities", ...args]),
	},
	backend: {
		help: { group: "legacy", summary: "the host's VM backend (recorded for host ls)", usage: ["backend"] },
		run: async (s, args) => { needHost(s); await backendCommand(s.host, args); },
	},
	"proxy-log": {
		help: { group: "legacy", summary: "recent LLM and edge (http: grant) requests on the host", usage: ["proxy-log [N]"] },
		run: async (s, args) => hostPass(s, ["proxy-log", ...args]),
	},
	help: {
		contract: { scope: "controller", help: "self" },
		local: (args) => showHelp(args),
		help: {
			group: "start", summary: "show help for boxery, a command or a family action", list: "help [--all | COMMAND]", usage: ["help [--all | COMMAND [ACTION]]"],
			details: ["boxery help lists the everyday commands and the command families; help --all adds every family action and every older spelling."],
			flags: [["--all", "Every command, family action and older spelling"]],
			examples: [["Everything, with the older spellings", "boxery help --all"], ["A family, then one of its actions", "boxery help access && boxery help access grant"]],
		},
	},
};

/** A command's contract, with the defaults for what it doesn't say (an alias is its command's). @param {string} name @returns {Contract} */
export function contractOf(name) {
	const e = COMMANDS[resolve(COMMANDS, name) ?? name];
	return { ...CONTRACT_DEFAULTS, ...(e && "contract" in e ? e.contract : undefined) };
}
/** What a family action promises: a command's action runs that command's handler, so it has its contract, except
 *  that an action only recognises a leading help flag (after NAME the words may be prompt text or an agent command);
 *  a registry action says its own. @param {FamilyAction} a @returns {Contract} */
export function actionContract(a) {
	if (a.scope === "registry") return { ...CONTRACT_DEFAULTS, scope: "registry", help: "leading", noHost: a.noHost };
	return { ...contractOf(/** @type {string} */ (a.command)), help: "leading" };
}

/** Commands handled before a host is selected. */
export const PRE_HOST = Object.keys(COMMANDS).filter((n) => contractOf(n).scope === "controller");
registerCommands(COMMANDS);

// ---------------------------------------------------------------- dispatch

/** @param {string[]} argv */
async function main(argv) {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 13)) die(`need Node >= 22.13 (this is ${process.version}); install a newer one, or set BOXERY_NODE`);
	if (/[\n\t\r]/.test(BOXERY_HOME)) die("paths cannot contain line breaks or tabs");
	let explicit = "", pinned = "";
	if (argv[0] === "--host") {
		if (argv.length < 3) die("usage: boxery --host NAME COMMAND [ARGS...]", USAGE);
		explicit = argv[1];
		if (!explicit) die("invalid host name");
		argv = argv.slice(2);
		// Internal (tests): --profile-dir uses that directory as the host's profile, without the registry.
		if (argv[0] === "--profile-dir") {
			if (argv.length < 3) die("usage: boxery --host NAME --profile-dir DIR COMMAND", USAGE);
			pinned = argv[1]; argv = argv.slice(2);
		}
	}
	const [first = "help", ...rest] = argv;
	// (-V, --version, -h and --help are the commands version and help: boxery -h COMMAND shows COMMAND's help.)
	const flags = /** @type {Record<string, string>} */ ({ "--version": "version", "-V": "version", "-h": "help", "--help": "help" });
	const word = Object.hasOwn(flags, first) ? flags[first] : first;
	let cmd = word.startsWith("__") ? word : resolve(COMMANDS, word);
	if (cmd === null) throw new CliError(unknownCommand(COMMANDS, word), 2);
	let args = rest;
	let contract = contractOf(cmd);
	// Help needs no host: boxery help [--all | COMMAND [ACTION]], boxery -h, boxery COMMAND [ACTION] --help|-h.
	if (contract.help === "self") return localHandler(cmd)(args);
	const family = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
	if (family && "actions" in family && family.actions) {
		// A family's action runs another command's handler, with the same host selection below. Everything here
		// is decided from the words alone: help and mistakes never reach a host, a profile or a grant.
		const [action, ...tail] = rest;
		const key = action ?? family.defaultAction;
		if (key === undefined) throw new CliError(unknownAction(COMMANDS, cmd), 2);
		if (["-h", "--help"].includes(action ?? "")) return showHelp([cmd]);
		const a = Object.hasOwn(family.actions, key) ? family.actions[key] : null;
		if (!a) throw new CliError(unknownAction(COMMANDS, cmd, action), 2);
		const ac = actionContract(a);
		if (wantsHelp(ac, tail)) return showHelp([cmd, key]);
		if (ac.scope === "registry") {
			// host's registry actions: this machine's registry, not a host
			if (explicit && ac.noHost) die(ac.noHost);
			return hostCommand(rest);
		}
		routedThrough(/** @type {string} */ (a.command), cmd, key);
		cmd = /** @type {string} */ (a.command);
		contract = ac;
		args = a.args ? a.args(tail) : tail;
	} else if (wantsHelp(contract, args)) return showHelp([cmd]);
	if (contract.scope === "controller") {
		if (explicit && contract.noHost) die(contract.noHost);
		return localHandler(cmd)(args);
	}
	// Internal (tests): __skew CTL_VERSION CTL_DESCRIBE HOST_VERSION HOST_DESCRIBE [HOST_NAME]
	if (cmd === "__skew") { const n = skewNote({ version: args[0], describe: args[1] || null }, { version: args[2], describe: args[3] || null }, args[4] ?? ""); if (n) say(n); return; }
	// Before setup there is no host to select; version still reports the controller.
	if (contract.hostOptional && !explicit && defaultHost() == null) return localHandler(cmd)(args);
	// SSH's VM@HOST is CLI shorthand, not an SSH user or a new destination. Resolve the registered profile
	// before reading any config or reapplying grants; a conflicting selector must never reach either host.
	if (contract.vmAtHost && args[0]?.includes("@")) {
		const [vm, host, ...extra] = args[0].split("@");
		if (!VALID_VM.test(vm) || !VALID_VM.test(host ?? "") || extra.length) die(`invalid SSH target: ${args[0]} (use NAME@HOST; names: lowercase letters, digits and hyphens, starting with a letter, at most 31 characters)`);
		if (explicit && explicit !== host) die(`SSH target host ${host} conflicts with --host ${explicit}; use one host or matching selectors`);
		explicit = host;
		args[0] = vm;
	}
	const name = explicit || defaultHost();
	if (!name) die("no host configured; run: boxery setup user@host|local (or boxery host use NAME)");
	if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) die(`invalid host name: ${name}`);
	invokedAs(explicit);
	let dir;
	if (pinned) {
		if (!path.isAbsolute(pinned)) die(`invalid profile directory: ${pinned}`);
		if (/[\n\t\r]/.test(pinned)) die("paths cannot contain line breaks or tabs");
		dir = pinned;
	} else {
		// A registration whose profile was never set up (no config yet) is a host to configure, as before.
		try { dir = resolveHost(name).dir; }
		catch (e) {
			if (!/^incomplete profile:/.test(/** @type {Error} */ (e).message)) throw e;
			die(`host ${name} is not configured; run: boxery setup user@host|local --name ${name}`);
		}
	}
	const entry = COMMANDS[cmd];
	// All-host text listings retain the original path with --host or --json.
	const command = "run" in entry ? entry.run : undefined;
	if (!command) throw new CliError(unknownCommand(COMMANDS, word), 2);
	const s = await select(name, dir);
	await withHost(s.host, async () => {
		await refreshSshConfig({ host: s.host, warn: note });
		await reporting(cmd, "status" in entry ? entry.status : undefined, args, async () => {
			const allHosts = !!contract.allHosts && !explicit;
			if (allHosts && cmd !== "ls") {
				const listings = await import("./all-hosts.mjs");
				if (listings.isListing(cmd, args) && await listings.allHostsListing(s, cmd, args)) return;
			}
			return command(s, args, { allHosts });
		});
	});
}

/** The command's own handler for the words with no host selected (a `controller` command, or version without a host).
 *  @param {string} cmd @returns {(args: string[]) => unknown} */
function localHandler(cmd) {
	const e = COMMANDS[cmd];
	if (!("local" in e) || !e.local) throw new Error(`internal: ${cmd} has no local handler`);
	return e.local;
}

/** Is this a request for help or payload, by the contract's convention (Contract.help)? The legacy one is kept for
 *  existing spellings; family actions (and run and ssh, which own their remote payload) only recognise a leading
 *  help flag. @param {Contract} contract @param {string[]} args */
function wantsHelp(contract, args) {
	const help = (/** @type {string | undefined} */ w) => w === "-h" || w === "--help";
	return help(args[0]) || (contract.help === "legacy" && args.length === 2 && /^[a-z]+$/.test(args[0]) && help(args[1]));
}

/** boxery help [--all | COMMAND [ACTION]]: the same pages as COMMAND --help. @param {string[]} words */
function showHelp(words) {
	// Explicit help has no payload: accept a redundant trailing help flag, including legacy help host add --help.
	if (words.length > 1 && ["-h", "--help"].includes(words.at(-1) ?? "")) words = words.slice(0, -1);
	const [word, action] = words;
	if (word === undefined || word === "--all") {
		if (words.length > 1) usage("help");
		return void process.stdout.write(renderTop(COMMANDS, word === "--all"));
	}
	const cmd = resolve(COMMANDS, word);
	if (cmd === null) throw new CliError(unknownCommand(COMMANDS, word), 2);
	const entry = COMMANDS[cmd];
	if (!("help" in entry)) return;
	if (entry.actions) {
		if (words.length > 2) usage("help");
		if (action === undefined) return void process.stdout.write(renderFamily(COMMANDS, cmd));
		const h = actionHelp(COMMANDS, cmd, action);
		if (!h) throw new CliError(unknownAction(COMMANDS, cmd, action), 2);
		return void process.stdout.write(renderCommand(`${cmd} ${action}`, h));
	}
	process.stdout.write(renderCommand(cmd, entry.help));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// (stdout/stderr may be gone, e.g. `boxery ls | head`: a write error then ends quietly)
	for (const s of [process.stdout, process.stderr]) s.on("error", () => { process.exitCode ||= 1; });
	try {
		await main(commandLine());
	} catch (e) {
		const err = /** @type {Error & { exitCode?: number }} */ (e);
		if (!(err instanceof CliError) || err.message) process.stderr.write(`boxery: ${err.message.replace(/^boxery: /, "")}\n`);
		process.exitCode = err.exitCode ?? 1;
		// A terminal command (ssh, a tunnel) ended by Ctrl-C, a TERM, HUP or PIPE: end by it too, so callers see
		// WIFSIGNALED as with an exec'd ssh. (Not core-dumping signals: that would dump this process's core too.)
		const sig = (await import("./lib.mjs")).killedBy;
		if (sig && ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"].includes(sig) && err instanceof CliError && err.exitCode === 128 + (constants.signals[sig] ?? 0)) {
			for (const name of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"])) process.removeAllListeners(name);
			process.kill(process.pid, sig);
		}
	}
}
