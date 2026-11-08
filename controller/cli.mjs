// boxery: the controller CLI, on your machine. controller/boxery is the shim that starts it. Every command's
// work is shared with the MCP server and the pi extension (core/): lifecycle (core/lifecycle.mjs), leases
// (core/leases.mjs), grants (core/grants.mjs), copies (vm_copy) and the host profile (core/profile.mjs).
// What is only the CLI's lives here: argument parsing, the terminal (grant approval, ssh, attach, desktop),
// and output formats (docs/cli.md), which are the same as the Bash controller's were.
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOXERY_HOME, defaultHost, resolveHost, withHost } from "../core/boxery-core.mjs";
import * as lifecycle from "../core/lifecycle.mjs";
import { refreshSshConfig } from "../core/profile.mjs";
import { literal, literalArgs, remotePath } from "../core/ssh-config.mjs";
import { controllerVersion, hostVersion, skewNote, upgradeHint } from "../core/versions.mjs";
import { backendCommand, hostCommand, setupNamed } from "./hosts.mjs";
import { CliError, VALID_SNAP, VALID_VM, commandLine, die, usage, hasRawBytes, hostFailed, hostPass, inherit, needHost, needVm, note, rawTail, say, select, vmSsh, vmSshCapture, warn } from "./lib.mjs";
import { registerCommands, renderCommand, renderTop, resolve, unknownCommand } from "./usage.mjs";
/** @import { Selected } from "./lib.mjs" */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Lifecycle options for the CLI: the host's output and stdin pass through; notes go to stderr. @returns {import("../core/lifecycle.mjs").LifecycleOpts} */
const passthrough = () => ({ stdin: "inherit", stdout: "inherit", stderr: "inherit", timeout: 0, log: note, say });
/** Run a lifecycle operation; its failure ends the command as the host's does. @param {() => Promise<unknown>} fn */
async function lc(fn) { try { await fn(); } catch (e) { hostFailed(e); } }

// ---------------------------------------------------------------- grants (approval is this front-end's)

/** The grant operations, in-process (controller/grants.mjs is their CLI shape). */
const grants = () => import("./grants.mjs");

// ---------------------------------------------------------------- commands

/** @typedef {(s: Selected, args: string[]) => Promise<unknown>} Command */
// (Commands are typed one by one below: their returns are void.)

/** new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--from IMAGE] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdNew(s, args) {
	let name = "", from = null, headless = false, layers = null, distro = null, recipe = null;
	/** @type {Record<string, string>} */
	const size = {};
	/** @type {string[]} */
	const specs = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--from") { if (!/^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v ?? "")) die(`invalid image name: ${v ?? ""} (use VM@SNAP)`); from = v; i++; }
		else if (a === "--grant") { if (v == null) die("--grant needs a value"); specs.push(v); i++; }
		else if (a === "--agent-forward") specs.push("ssh-agent");
		else if (a === "--headless") headless = true;
		else if (a === "--recipe") { if (!v || v.startsWith("--")) die("--recipe needs a local JSON file"); recipe = v; i++; }
		else if (a === "--distro") { if (!["ubuntu", "arch"].includes(v ?? "")) die("--distro must be ubuntu or arch"); distro = v; i++; }
		else if (a === "--layers") { if (v == null) die("--layers needs a value"); if (!/^[a-z0-9,-]+$/.test(v)) die(`invalid layer list: ${v}`); layers = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value"); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a.startsWith("-")) die(`unknown flag ${a}`);
		else name = a;
	}
	needVm(name);
	// Validate and approve the whole batch before creating anything.
	const approved = specs.length ? await (await grants()).confirm(s, name, specs) : [];
	await lc(() => lifecycle.newVm(name, { ...size, from, headless, distro, recipe, layers, grants: approved }, passthrough()));
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
		if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value"); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (a === "--grants") copyGrants = true;
		else if (a.startsWith("-")) die(`unknown flag ${a}`);
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
		if (!args.length) throw new CliError("", 1);
		return;
	}
	const name = needVm(args[0]);
	// The bytes of every word from NAME on, by position (the command line's own, for words that aren't UTF-8).
	const raw = rawTail(args);
	let cwd = "", i = 1;
	/** @type {Buffer} */
	let cwdRaw = Buffer.alloc(0);
	for (; i < args.length; i++) {
		if (args[i] === "--cwd") { if (!args[i + 1]) runUsage(); cwd = args[++i]; cwdRaw = raw[i]; }
		else if (args[i] === "--bg") bg = true;
		else if (args[i] === "--") { i++; break; }
		else break;
	}
	const argv = args.slice(i), argvRaw = raw.slice(i);
	if (!argv.length) runUsage();
	if (bg) {
		await (await grants()).reapplyQuiet(s, name);
		const { startJob } = await import("./jobs.mjs");
		const id = await startJob(s, name, argvRaw, cwd ? cwdRaw : null);
		say(id);
		note(`boxery: started ${id} on ${name}   logs: boxery logs ${name} ${id} -f   wait: boxery wait ${name} ${id}`);
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
	if (rc === 127 && /\s/.test(argv[0])) warn(`hint: run takes the command and its arguments separately; for a shell line use: boxery run ${name} bash -c ${literal(argv[0])}`);
	literalNote(name, argv);
	if (rc) throw new CliError("", rc);
}

/** @returns {never} */
const runUsage = () => usage("run", { hint: "a shell line: ... bash -c 'A | B'; see: boxery run --help" });

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
	if (a !== undefined) warn(`note: ${literal(a)} was passed literally (run does not expand ~ or $VAR); to expand it in the VM: boxery run ${name} bash -c '…'`);
}

/** attach NAME [pi|opencode|shell] [session] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdAttach(s, [name = "", tool = "pi", sess = tool]) {
	needVm(name);
	if (!/^[A-Za-z0-9._-]+$/.test(sess)) die(`invalid session name: ${sess}`);
	const run = { pi: "pi", opencode: "opencode", shell: "bash -l" }[tool] ?? tool;
	await (await grants()).reapplyQuiet(s, name);
	// tmux keeps the agent alive when you disconnect (laptop sleep, network change).
	const rc = await vmSsh(s, ["-t", `${name}.boxery`, `cd ~/project 2>/dev/null; tmux has-session -t '${sess}' 2>/dev/null || tmux new-session -d -s '${sess}' -c ~/project "bash -lc '${run}; exec bash -l'"; exec tmux attach -t '${sess}'`]);
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

/** prompt NAME "task" — a headless pi task in a detached tmux window, logged to ~/project/.boxery/ @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdPrompt(s, [name = "", ...words]) {
	needVm(name);
	const prompt = words.join(" ");
	if (!prompt) usage("prompt");
	const d = new Date(), p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
	const id = `task-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
	const b64 = Buffer.from(prompt).toString("base64");
	// Ship the prompt base64-encoded and write a tiny runner script: no nested shell quoting.
	const script = `set -e; d=~/project/.boxery; mkdir -p $d; echo ${b64} | base64 -d > $d/${id}.prompt
		printf '%s\\n' '#!/bin/bash -l' 'cd ~/project' 'pi -p "$(cat .boxery/${id}.prompt)" </dev/null 2>&1 | tee .boxery/${id}.log' 'echo "[boxery] task finished (exit \${PIPESTATUS[0]})" | tee -a .boxery/${id}.log' 'exec bash -l' > $d/${id}.sh
		chmod +x $d/${id}.sh; tmux new-session -d -s ${id} -c ~/project $d/${id}.sh`;
	await exitWith(vmSsh(s, [`${name}.boxery`, script]));
	say(`started ${id} on ${name} — watch: boxery attach ${name} pi ${id}   log: boxery run ${name} cat project/.boxery/${id}.log`);
}

/** cp FROM TO: vm_copy's own code. Needs only the profile's ssh_config, not the host. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdCp(s, args) {
	if (args.length !== 2) usage("cp", { hint: "FROM/TO: local:PATH | NAME:PATH | HOST/NAME:PATH | PATH = local" });
	for (const a of args) if (a.startsWith("-")) die(`cp takes no options (directories copy recursively); for a local path starting with -, use local:${a}`);
	const { copy } = await import("./cp.mjs");
	await copy(s.host, args);
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
/** A command: its help and what it runs (with a selected host). Aliases name their command; pre-host commands
 *  (help, host, setup, version without a host) are dispatched in main() and have no `run` here.
 *  @typedef {{ help: Help, run?: Command, preHost?: true } | { alias: string }} Entry */

const JSON_FLAG = /** @type {[string, string]} */ (["--json", "Print JSON (fields: docs/cli.md#json-output)"]);
const SIZE_FLAGS = /** @type {[string, string][]} */ ([["--shape S", "A size from boxery shapes"], ["--cpus N", "CPUs"], ["--mem MiB", "Memory, in MiB"], ["--disk GiB", "Disk, in GiB"]]);
const RUN_RULES = "Arguments are passed exactly as given, like docker exec: quotes, $, ~, globs and ; are not re-parsed in the VM. For pipes, &&, ~ or $VAR, run a shell: bash -c '...'.";

/** Every boxery command and its help (boxery help and COMMAND --help are rendered from this). @type {Record<string, Entry>} */
export const COMMANDS = {
	// ------------------------------------------------ setup & hosts
	setup: {
		preHost: true,
		help: {
			group: "setup", summary: "configure a VM host (local = this machine), register your ssh key",
			usage: ["setup user@host|local [--name NAME] [--key K.pub] [--host-bin PATH] [--profile P [--backend B]]", "setup local --backend openshell [OPTIONS]"],
			details: ["OpenShell has its own options (gateway, image, policy, providers): boxery setup local --backend openshell --help."],
			flags: [["--name NAME", "Register the host as NAME (default: local, or the host part of user@host)"], ["--key K.pub", "The ssh public key VMs trust (default: your first ~/.ssh/id_*.pub)"], ["--host-bin PATH", "boxery-host on the host, when it isn't on its PATH"], ["--profile P", "Use (or create, with --backend) profile P on the host"], ["--backend B", "The backend for a new profile (boxery backends lists them)"]],
			examples: [["A Linux box you reach over ssh", "boxery setup you@my-host"], ["This machine", "boxery setup local"]],
			seeAlso: ["host", "build-base", "backends"], docs: "install.md",
		},
	},
	host: {
		preHost: true,
		help: {
			group: "setup", summary: "manage named hosts (host use sets the default)", list: "host add|ls|show|use|rm",
			usage: ["host add NAME DEST [--key K.pub] [--host-bin PATH] [--backend B | --profile P]", "host add NAME --config-dir DIR", "host ls [--json]", "host show NAME", "host use NAME", "host rm NAME"],
			details: ["add registers DEST (user@host or local) as NAME, ls shows where each host runs and its backend, show prints a host's profile directory, use makes NAME the default and rm forgets a host (its VMs and profile data stay)."],
			flags: [["--backend B", "Create a new profile on DEST for backend B (own state, proxy port and services)"], ["--profile P", "Use an existing profile on DEST"], ["--config-dir DIR", "Import an existing profile directory without setup"], ["--key K.pub", "The ssh public key VMs trust"], ["--host-bin PATH", "boxery-host on the host, when it isn't on its PATH"], JSON_FLAG],
			examples: [["Add a second machine and make it the default", "boxery host add hornet you@hornet && boxery host use hornet"], ["One command on another host", "boxery --host hornet ls"]],
			docs: "hosts.md",
		},
	},
	"build-base": {
		help: { group: "setup", summary: "build the host's desktop base image (one time, ~3 min)", usage: ["build-base"], details: ["Headless VMs (new --headless) don't need it."], docs: "cli.md#lifecycle" },
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
		run: async (s, args) => (await import("./ls.mjs")).ls(s, args, { allHosts: false }),
	},
	list: { alias: "ls" },
	new: {
		help: {
			group: "vms", summary: "create a VM", usage: ["new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward]", "new NAME --from VM@SNAP"],
			flags: [...SIZE_FLAGS, ["--recipe FILE", "Explicitly apply a local recipe JSON and its reviewed guest setup script"], ["--distro ubuntu|arch", "Guest distribution (Arch: experimental Lima x86_64 headless only)"], ["--headless", "No desktop (shell and agents only); needs no build-base"], ["--layers L,...", "Extra image layers for a headless VM (github-runner)"], ["--from VM@SNAP", "Start from a snapshot (boxery images lists them)"], ["--grant SPEC", "Grant access at creation (asks first; see boxery grant)"], ["--agent-forward", "Same as --grant ssh-agent"]],
			examples: [["A desktop VM", "boxery new demo"], ["A larger, headless one", "boxery new ci-1 --headless --shape large"], ["A GitHub Actions runner VM", "boxery new runner-1 --headless --layers github-runner"]],
			seeAlso: ["shapes", "fork", "rm"], docs: "cli.md#lifecycle",
		},
		run: async (s, args) => { needHost(s); await cmdNew(s, args); },
	},
	start: {
		help: { group: "vms", summary: "start a stopped VM (pins its ssh host key where it can)", usage: ["start NAME"], seeAlso: ["stop"] },
		run: async (s, [n]) => { needHost(s); await lc(() => lifecycle.startVm(needVm(n), passthrough())); },
	},
	stop: {
		help: { group: "vms", summary: "stop a VM", usage: ["stop NAME"], seeAlso: ["start"] },
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
		run: async (s, [n, ...rest]) => {
			needHost(s); needVm(n);
			/** @type {Record<string, string>} */
			const size = {};
			for (let i = 0; i < rest.length; i += 2) {
				if (!["--cpus", "--mem", "--disk"].includes(rest[i]) || rest[i + 1] == null) { await hostPass(s, ["resize", n, ...rest]); return; } // the host says what's wrong
				size[rest[i].slice(2)] = rest[i + 1] ?? "";
			}
			await lc(() => lifecycle.resizeVm(n, size, passthrough()));
		},
	},
	fork: {
		help: {
			group: "vms", summary: "copy a VM (running or not) into new VMs, ~10 s", usage: ["fork SRC DST... [--grants] [--shape S] [--cpus N --mem MiB --disk GiB]"],
			details: ["Each fork has SRC's disk (not its processes) with its own hostname, LLM token, ssh keys and network identity, and SRC's size unless --shape or size flags say otherwise."],
			flags: [["--grants", "Give the forks SRC's grants too (asks for each)"], ...SIZE_FLAGS],
			examples: [["Two copies to try two approaches", "boxery fork demo try-a try-b"]], seeAlso: ["snap", "new"], docs: "cli.md#snapshots-and-forks",
		},
		run: async (s, args) => { needHost(s); await cmdFork(s, args); },
	},
	patch: {
		help: {
			group: "vms", summary: "update a VM's guest software to the host's image layers", usage: ["patch NAME|--all [--wait S]"],
			details: ["Security updates and kernel, browsers, agent CLIs and node; the VM restarts if the updates ask to. A pool VM must be free, and its clean image is captured again. Snapshots keep their old software."],
			flags: [["--all", "Every running VM, in turn"], ["--wait S", "Wait up to S seconds for a pool VM's lease to end"]],
			seeAlso: ["ls"], docs: "cli.md#lifecycle",
		},
		run: async (s, args) => { needHost(s); await cmdPatch(s, args); },
	},
	pin: {
		help: {
			group: "vms", summary: "re-pin a VM's ssh host key (VMs made before keys were pinned)", usage: ["pin NAME [--from-guest]"],
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
		help: { group: "vms", summary: "VM sizes defined on the host (* = default)", usage: ["shapes [--json]"], flags: [JSON_FLAG], docs: "shapes.md" },
		run: async (s, args) => { needHost(s); if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) usage("shapes"); await hostPass(s, ["shapes", ...args]); },
	},

	// ------------------------------------------------ snapshots
	snap: {
		help: { group: "snapshots", summary: "snapshot a VM's disk (~1 s; the VM keeps running)", usage: ["snap NAME [SNAP]"], seeAlso: ["snaps", "revert", "snap-rm"], docs: "cli.md#snapshots-and-forks" },
		run: async (s, args) => {
			needHost(s);
			if (args[1] && !VALID_SNAP.test(args[1])) die(`invalid snapshot name: ${args[1]}`);
			await lc(() => lifecycle.snapVm(needVm(args[0]), args[1] || null, passthrough()));
		},
	},
	snaps: {
		help: { group: "snapshots", summary: "list a VM's snapshots", usage: ["snaps NAME [--json]"], flags: [JSON_FLAG] },
		run: async (s, args) => { needHost(s); needVm(args[0]); await hostPass(s, ["snaps", ...args]); },
	},
	revert: {
		help: { group: "snapshots", summary: "restore a VM to a snapshot (keeps its name, address and token)", usage: ["revert NAME SNAP"] },
		// A revert restores the snapshot's tmpfs too: grants are always reconciled to the current ones.
		run: async (s, [n, snap]) => { needHost(s); if (!VALID_SNAP.test(snap ?? "")) die(`invalid snapshot name: ${snap ?? ""}`); await lc(() => lifecycle.revertVm(needVm(n), snap, passthrough())); },
	},
	"snap-rm": {
		help: { group: "snapshots", summary: "delete a snapshot", usage: ["snap-rm NAME SNAP"] },
		run: async (s, args) => {
			needHost(s);
			if (!args[1] || !VALID_SNAP.test(args[1])) usage("snap-rm");
			await lc(() => lifecycle.snapRm(needVm(args[0]), args[1], passthrough()));
		},
	},
	images: {
		help: { group: "snapshots", summary: "every snapshot on the host (new NAME --from VM@SNAP uses one)", usage: ["images [--json]"], flags: [JSON_FLAG] },
		run: async (s, args) => hostPass(s, ["images", ...args]),
	},

	// ------------------------------------------------ work in a VM
	ssh: {
		help: { group: "use", summary: "shell into a VM (also: ssh NAME.boxery)", usage: ["ssh NAME [CMD...]"], details: ["With CMD, plain ssh semantics: the words are joined and run by the VM's shell."], seeAlso: ["run"] },
		run: async (s, args) => { needHost(s); await cmdSsh(s, args); },
	},
	run: {
		help: {
			group: "use", summary: "run a command in ~/project, args as given (like docker exec)", usage: ["run [--bg] NAME [--cwd DIR] [--] CMD [ARG...]"],
			details: [RUN_RULES, "The exit code is the command's. A relative --cwd is under ~/project; ~/ expands in the VM; absolute paths are used as is."],
			flags: [["--bg", "Run as a background job; prints the job id (see boxery jobs)"], ["--cwd DIR", "Working directory"], ["--", "End run's options"]],
			examples: [["Args are passed as-is: quotes, $, *, ; stay literal", "boxery run demo pnpm test"], ["In ~/project/modem", "boxery run demo --cwd modem git log -1"], ["Pipes, ~, $VAR and globs need bash -c", "boxery run demo bash -c 'ls ~ | wc -l; echo $HOME'"], ["Not this: one argument is one command name (fails with a hint)", "boxery run demo 'make test'"]],
			seeAlso: ["jobs", "ssh"], docs: "cli.md#shell-and-in-vm-agents",
		},
		run: async (s, args) => { needHost(s); await cmdRun(s, args); },
	},
	cp: {
		help: {
			group: "use", summary: "copy files and directories to, from and between VMs", usage: ["cp FROM TO"],
			details: ["Locations: local:PATH, NAME:PATH (a VM on the selected host) or HOST/NAME:PATH; a bare PATH is on this machine. VM paths are relative to ~/project. Directories copy recursively."],
			examples: [["This machine to a VM (~/project/repo.bundle)", "boxery cp ./repo.bundle demo:"], ["VM to VM, across named hosts", "boxery cp demo:out.zip hornet/worker:in.zip"]],
			docs: "copy.md",
		},
		run: cmdCp,
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
			details: ["The session keeps running when you detach (Ctrl-b d) or disconnect."], seeAlso: ["sessions", "prompt"],
		},
		run: async (s, args) => { needHost(s); await cmdAttach(s, args); },
	},
	prompt: {
		help: { group: "use", summary: "start a headless pi task in its own tmux session", usage: ['prompt NAME "TASK"'], details: ["It logs to ~/project/.boxery/task-*.log in the VM; attach with boxery attach NAME pi task-…"] },
		run: async (s, args) => { needHost(s); await cmdPrompt(s, args); },
	},
	sessions: {
		help: { group: "use", summary: "list a VM's tmux sessions", usage: ["sessions NAME [--json]"], flags: [JSON_FLAG] },
		run: async (s, args) => { needHost(s); await cmdSessions(s, args); },
	},

	// ------------------------------------------------ background jobs
	jobs: {
		help: {
			group: "jobs", summary: "list background jobs (run --bg starts one)", usage: ["jobs NAME [--json]", "jobs NAME --prune [--older-than 7d] [--json]"],
			details: ["States: running, exited, or lost (it stopped without recording an exit code). exited+ means it left processes running."],
			flags: [JSON_FLAG, ["--prune", "Delete finished jobs and their logs"], ["--older-than D", "With --prune: only jobs older than D (e.g. 7d)"]],
			seeAlso: ["run", "logs", "wait", "kill"], docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).jobs(s, args); },
	},
	logs: {
		help: {
			group: "jobs", summary: "show a job's output (the last 200 lines)", usage: ["logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]"],
			flags: [["-f, --follow", "Follow until the job ends"], ["-n, --lines N", "The last N lines"], ["--tail N", "Same as --lines"], ["--bytes N", "Clip each read to its last N bytes"], ["--strip-ansi", "Remove colours and terminal escapes"]],
			docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).logs(s, args); },
	},
	wait: {
		help: {
			group: "jobs", summary: "wait for a job; exits with its exit code", usage: ["wait NAME JOB [--timeout S] [--json]"],
			details: ["Exits 124 if --timeout passes first (the job keeps running) and 125 if the job is lost. Scripts that must tell these from the job's own codes should use --json."],
			flags: [["--timeout S", "Give up after S seconds"], JSON_FLAG], docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).waitJob(s, args); },
	},
	kill: {
		help: {
			group: "jobs", summary: "stop a job: SIGTERM its process group, then SIGKILL", usage: ["kill NAME JOB [--grace S] [--json]"],
			flags: [["--grace S", "Seconds between SIGTERM and SIGKILL (default 5)"], JSON_FLAG], docs: "cli.md#background-command-jobs",
		},
		run: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).kill(s, args); },
	},

	// ------------------------------------------------ access
	grant: {
		help: {
			group: "access", summary: "give a VM access to something on this machine (asks first)", usage: ["grant NAME SPEC... [--cmd CMD]"],
			details: ["SPEC is one of:\n  llm:chatgpt|openai|anthropic|ollama   LLM access (VMs have none without it)\n  github [--readonly]                   GitHub over HTTPS; the token stays here\n  http:HOST --cmd CMD [--auth bearer|basic:USER|header:NAME] [--readonly]\n                                        an HTTP API; the secret never enters the VM\n  ssh-agent                             forward your ssh agent\n  env:VAR [--cmd CMD]                   push an environment variable\n  file:LOCAL[=REMOTE]                   push a file", "Adding access prompts on your terminal and defaults to No."],
			flags: [["--cmd CMD", "env: and http: grants: the command on this machine that prints the secret"], ["--auth A", "http: grants: bearer (default), basic:USER or header:NAME"], ["--readonly", "http: and github grants: GET/HEAD and git fetch only"]],
			examples: [["Let the VM use your Anthropic subscription", "boxery grant demo llm:anthropic"], ["Read-only GitHub", "boxery grant demo github --readonly"]],
			seeAlso: ["revoke", "grants"], docs: "grants.md",
		},
		run: async (s, args) => { needHost(s); await (await grants()).grant(s, args); },
	},
	revoke: {
		help: { group: "access", summary: "take access away (pushed values are deleted from the VM)", usage: ["revoke NAME SPEC...|all"], docs: "grants.md" },
		run: async (s, args) => { needHost(s); await (await grants()).revoke(s, args); },
	},
	grants: {
		help: { group: "access", summary: "show a VM's grants, or push them again (apply)", list: "grants NAME [apply]", usage: ["grants NAME [apply [--quiet] | --json]"], flags: [JSON_FLAG], docs: "grants.md" },
		run: async (s, args) => (await grants()).grantsCommand(s, args),
	},
	"agent-forward": {
		help: { group: "access", summary: "same as grant/revoke NAME ssh-agent", usage: ["agent-forward NAME on|off"] },
		run: async (s, args) => (await grants()).agentForward(s, args),
	},

	// ------------------------------------------------ pool & runners
	acquire: {
		help: {
			group: "pool", summary: "lease a VM from the shared pool (prints NAME LEASE_ID)", usage: ["acquire [--ttl S] [--wait S] [--holder H]"],
			flags: [["--ttl S", "Lease length in seconds (default 1800)"], ["--wait S", "Wait up to S seconds for a free VM"], ["--holder H", "Who holds the lease, as the host shows it (default: user@machine)"]],
			seeAlso: ["renew", "release", "leases"], docs: "pool.md",
		},
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "acquire", args); },
	},
	renew: {
		help: { group: "pool", summary: "extend your lease", usage: ["renew NAME [--ttl S]"], flags: [["--ttl S", "New lease length in seconds"]], docs: "pool.md" },
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "renew", args); },
	},
	release: {
		help: { group: "pool", summary: "give a leased VM back (it is reset to its clean snapshot)", usage: ["release NAME"], docs: "pool.md" },
		run: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "release", args); },
	},
	leases: {
		help: { group: "pool", summary: "your leases", usage: ["leases [--json]"], flags: [JSON_FLAG], docs: "pool.md" },
		run: async (s, args) => (await import("./leases.mjs")).leaseCommand(s, "leases", args),
	},
	pool: {
		help: { group: "pool", summary: "manage the shared pool of leasable VMs (admin)", usage: ["pool add NAME", "pool rm NAME [--force]", "pool ls [--json]"], list: "pool add|rm|ls", docs: "pool.md" },
		run: async (s, args) => { needHost(s); await lc(() => lifecycle.pool(args, passthrough())); },
	},
	runners: {
		help: {
			group: "pool", summary: "GitHub Actions runners on pool VMs", list: "runners once|status|...",
			usage: ["runners once [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--labels L,...] [--group ID]", "runners status [--json] | start | stop | token < FILE", "runners config [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--count N] [--labels L,...] ..."],
			details: ["once: a local runner. One job on a fresh pool VM, registered with your gh login; nothing is stored on the host. --repo defaults to this directory's repo.", "status, start, stop, config, token: host runners (admin). The host keeps runners waiting, with its own GitHub token."],
			docs: "github-runners.md",
		},
		// GitHub Actions runners on the host's pool (docs/github-runners.md): `once` (local runners) runs here with
		// this machine's gh login; the rest (host runners) is passed through, and `token` reads stdin.
		run: async (s, args) => {
			needHost(s);
			if (args[0] === "once") return (await import("./runners-once.mjs")).runnersOnce(s, args.slice(1));
			await hostPass(s, ["runners", ...args]);
		},
	},

	// ------------------------------------------------ host & diagnostics
	version: {
		help: { group: "admin", summary: "controller and host versions; warns when the host is behind", usage: ["version [--json]"], flags: [JSON_FLAG], seeAlso: ["upgrade-host"] },
		run: async (s, args) => cmdVersion(s, args),
	},
	"upgrade-host": {
		help: {
			group: "admin", summary: "update boxery on the host and restart its services", usage: ["upgrade-host [--check] [--ref REF] [--wait S] [--reinit]"],
			details: ["Waits for in-flight VM operations and rolls back if checks fail."],
			flags: [["--check", "Only report the install, its target version and profiles"], ["--ref REF", "Upgrade to this git ref or npm version"], ["--wait S", "Wait up to S seconds for in-flight operations"], ["--reinit", "Re-run init for every profile even when up to date"]],
			docs: "install.md#upgrading",
		},
		run: cmdUpgradeHost,
	},
	backends: {
		help: { group: "admin", summary: "backend support, requirements and capabilities", usage: ["backends [--json]"], flags: [JSON_FLAG], docs: "backends.md" },
		run: async (s, args) => hostPass(s, ["backends", ...args]),
	},
	capabilities: {
		help: { group: "admin", summary: "the selected host's platform and capabilities", usage: ["capabilities [--json | --check]"], flags: [JSON_FLAG, ["--check", "Run the backend preflight; fails when a requirement is missing"]], docs: "backends.md" },
		run: async (s, args) => hostPass(s, ["capabilities", ...args]),
	},
	backend: {
		help: { group: "admin", summary: "the host's VM backend (recorded for host ls)", usage: ["backend"] },
		run: async (s, args) => { needHost(s); await backendCommand(s.host, args); },
	},
	"proxy-log": {
		help: { group: "admin", summary: "recent LLM and edge (http: grant) requests on the host", usage: ["proxy-log [N]"] },
		run: async (s, args) => hostPass(s, ["proxy-log", ...args]),
	},
	help: { preHost: true, help: { group: "admin", summary: "show help for boxery or a command", usage: ["help [COMMAND]"] } },
};

/** Commands handled before a host is selected. */
export const PRE_HOST = Object.keys(COMMANDS).filter((n) => "preHost" in COMMANDS[n]);
registerCommands(COMMANDS);

// ---------------------------------------------------------------- dispatch

/** @param {string[]} argv */
async function main(argv) {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 13)) die(`need Node >= 22.13 (this is ${process.version}); install a newer one, or set BOXERY_NODE`);
	if (/[\n\t\r]/.test(BOXERY_HOME)) die("paths cannot contain line breaks or tabs");
	let explicit = "", pinned = "";
	if (argv[0] === "--host") {
		if (argv.length < 3) die("usage: boxery --host NAME COMMAND [ARGS...]");
		explicit = argv[1];
		if (!explicit) die("invalid host name");
		argv = argv.slice(2);
		// Internal (tests): --profile-dir uses that directory as the host's profile, without the registry.
		if (argv[0] === "--profile-dir") {
			if (argv.length < 3) die("usage: boxery --host NAME --profile-dir DIR COMMAND");
			pinned = argv[1]; argv = argv.slice(2);
		}
	}
	const [word = "help", ...args] = argv;
	// Help needs no host: boxery help [COMMAND], boxery -h, boxery COMMAND --help|-h.
	if (["help", "-h", "--help"].includes(word)) return showHelp(args[0]);
	const cmd = word.startsWith("__") ? word : resolve(COMMANDS, word);
	if (cmd === null) throw new CliError(unknownCommand(COMMANDS, word), 2);
	// (COMMAND SUB --help too: host add --help, runners once --help. Not after run's own options or CMD.)
	if (["-h", "--help"].includes(args[0] ?? "") || (cmd !== "run" && cmd !== "ssh" && args.length === 2 && /^[a-z]+$/.test(args[0]) && ["-h", "--help"].includes(args[1]))) return showHelp(cmd);
	if (cmd === "host") { if (explicit) die("--host does not apply to host management"); return hostCommand(args); }
	if (cmd === "setup") { if (explicit) die("setup takes --name NAME, not --host"); return setupNamed(args); }
	// Internal (tests): __skew CTL_VERSION CTL_DESCRIBE HOST_VERSION HOST_DESCRIBE [HOST_NAME]
	if (cmd === "__skew") { const n = skewNote({ version: args[0], describe: args[1] || null }, { version: args[2], describe: args[3] || null }, args[4] ?? ""); if (n) say(n); return; }
	// Before setup there is no host to select; version still reports the controller.
	if (cmd === "version" && !explicit && defaultHost() == null) return cmdVersion(null, args);
	const name = explicit || defaultHost();
	if (!name) die("no host configured; run: boxery setup user@host|local (or boxery host use NAME)");
	if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) die(`invalid host name: ${name}`);
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
	// Plain `ls` lists every host; --host NAME ls just that one.
	const command = cmd === "ls" && !explicit ? async (/** @type {Selected} */ s, /** @type {string[]} */ a) => (await import("./ls.mjs")).ls(s, a, { allHosts: true })
		: "run" in entry ? entry.run : undefined;
	if (!command) throw new CliError(unknownCommand(COMMANDS, word), 2);
	const s = await select(name, dir);
	await withHost(s.host, async () => {
		await refreshSshConfig({ host: s.host, warn: note });
		await command(s, args);
	});
}

/** boxery help [COMMAND]. @param {string} [word] */
function showHelp(word) {
	if (!word) return void process.stdout.write(renderTop(COMMANDS));
	const cmd = resolve(COMMANDS, word);
	if (cmd === null) throw new CliError(unknownCommand(COMMANDS, word), 2);
	const entry = COMMANDS[cmd];
	if ("help" in entry) process.stdout.write(renderCommand(cmd, entry.help));
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
