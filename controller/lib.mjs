// Shared plumbing for the controller CLI's commands (controller/cli.mjs): errors and exit codes, argument
// checks, the selected host profile, and processes that share this terminal (ssh, boxery-host).
import { usageText } from "./usage.mjs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { profileFromDirectory, vmProblem, withHost } from "../core/boxery-core.mjs";
import { hostRun, profileConfig } from "../core/profile.mjs";
/** @import { HostProfile } from "../core/boxery-core.mjs" */
/** @import { ProfileConfig } from "../core/profile.mjs" */

/** Ends the command: `boxery: MESSAGE` on stderr (none if empty), exit CODE. */
export class CliError extends Error {
	/** @param {string} message @param {number} [exitCode] */
	constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
/** @param {string} message @param {number} [exitCode] @returns {never} */
export const die = (message, exitCode = 1) => { throw new CliError(message, exitCode); };
/** The exit status of a usage error (a missing argument, an unknown flag): docs/cli.md. */
export const USAGE = 2;
/** A usage error: COMMAND's usage lines from its help (controller/usage.mjs usageText). @param {string} command @param {{ sub?: string, hint?: string }} [opts] @returns {never} */
export const usage = (command, opts) => die(usageText(command, opts), USAGE);
/** `boxery wait`'s own exit codes (docs/cli.md): --timeout passed (the job keeps running), and a job that was lost. controller/status.mjs reports them. */
export const WAIT_TIMEOUT = 124, WAIT_LOST = 125;
/** Exit with CODE, saying nothing (what failed has already said why). @param {number} exitCode @returns {never} */
export const quit = (exitCode) => { throw new CliError("", exitCode); };
/** How the person ran boxery: `boxery`, or `boxery --host NAME` when they named the host. Commands that
 *  hints suggest start with it, and so do the host's: it is BOXERY_CLI in the environment host commands
 *  get (core/ssh-config.mjs remoteCommand; host/util.mjs hint). (Plain ls asks every host with `boxery`:
 *  its host output is --json, with no hints.) */
export let BOXERY = "boxery";
/** @param {string} explicitHost the NAME of --host NAME, or "" */
export function invokedAs(explicitHost) {
	BOXERY = explicitHost ? `boxery --host ${explicitHost}` : "boxery";
	process.env.BOXERY_CLI = BOXERY;
}
/** @param {string} message */
export const warn = (message) => { process.stderr.write(`boxery: ${message}\n`); };
/** A line on stdout. @param {string} text */
export const say = (text) => { process.stdout.write(text.endsWith("\n") ? text : `${text}\n`); };
/** A line on stderr, as is. @param {string} text */
export const note = (text) => { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); };

export { VALID_NAME as VALID_VM, VALID_SNAP } from "../core/boxery-core.mjs";
import { VALID_NAME as VALID_VM } from "../core/boxery-core.mjs";
/** A VM name; none at all is a usage error. @param {string | undefined} name @returns {string} */
export const needVm = (name) => (VALID_VM.test(name ?? "") ? /** @type {string} */ (name) : name ? die(`invalid VM name: ${name}`) : die("missing VM name (see: boxery COMMAND --help)", USAGE));

/** VALUE as a plain number (no leading zeros), at least MIN. @param {string} flag @param {string | undefined} value @param {number} [min] */
export function num(flag, value, min = 0) {
	if (value == null) die(`${flag} needs a value`, USAGE);
	if (!/^[0-9]+$/.test(value)) die(`${flag} must be a whole number`);
	const v = /** @type {string} */ (value).replace(/^0+/, "") || "0";
	if (v.length > 9) die(`${flag} is too large`);
	if (Number(v) < min) die(`${flag} must be at least ${min}`);
	return Number(v);
}
/** N, Ns, Nm, Nh or Nd → seconds. @param {string} flag @param {string | undefined} value */
export function duration(flag, value) {
	const m = /^(.*?)([smhd]?)$/.exec(value ?? "");
	const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m?.[2] ?? ""] ?? 1;
	return num(flag, m?.[1]) * unit;
}

/** The selected host profile and its loaded config. @typedef {{ host: HostProfile, config: ProfileConfig }} Selected */
/** @param {string} name @param {string} dir @returns {Promise<Selected>} */
export async function select(name, dir) {
	const host = profileFromDirectory(name, dir);
	return { host, config: await profileConfig(host) };
}
/** @param {Selected} s */
export function needHost(s) {
	if (!s.config.host) die(`host ${s.host.name} is not configured; run: boxery setup user@host|local --name ${s.host.name}`);
}

/**
 * Run a command that shares this terminal (stdio inherited) to its end and return its exit status (128+N
 * if a signal ended it). Meanwhile Ctrl-C belongs to it, as with a shell's foreground job: SIGINT and
 * SIGQUIT from the terminal reach it directly and are ignored here; SIGTERM and SIGHUP sent to us are
 * passed on. input: its stdin instead of ours.
 * @param {string} cmd @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: "inherit" | "ignore", input?: string | Buffer, stdout?: "inherit" | "ignore" }} [opts]
 * @returns {Promise<number>}
 */
export function inherit(cmd, args, { env = process.env, stdin = "inherit", input, stdout = "inherit" } = {}) {
	killedBy = null; signalled = false; // (this command's, not an earlier one's)
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: [input === undefined ? stdin : "pipe", stdout, "inherit"], env });
		const ignore = () => { signalled = true; };
		const pass = (/** @type {NodeJS.Signals} */ sig) => { signalled = true; try { child.kill(sig); } catch { /* gone */ } };
		const term = () => pass("SIGTERM"), hup = () => pass("SIGHUP");
		process.on("SIGINT", ignore); process.on("SIGQUIT", ignore); process.on("SIGTERM", term); process.on("SIGHUP", hup);
		const done = (/** @type {number} */ code) => {
			process.off("SIGINT", ignore); process.off("SIGQUIT", ignore); process.off("SIGTERM", term); process.off("SIGHUP", hup);
			resolve(code);
		};
		child.on("error", (e) => { note(`boxery: cannot run ${cmd}: ${e.message}`); done(127); });
		child.on("exit", (code, sig) => { if (sig) killedBy = sig; done(code ?? 128 + (sig ? constants.signals[sig] ?? 0 : 0)); });
		if (input !== undefined && child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(input); }
	});
}
/** A signal (Ctrl-C, TERM, HUP) arrived while the last terminal command ran: ssh then exits 255 itself. */
let signalled = false;
/** Whether Ctrl-C (or a TERM, HUP) arrived while the last terminal command ran. Its exit status then says little: ssh exits 255 after one. controller/status.mjs reports such an end as stopped. */
export const wasInterrupted = () => signalled;
/** The signal that ended the last terminal command, if one did (cli.mjs then ends with it too, as an exec'd
 *  ssh would have). @type {NodeJS.Signals | null} */
export let killedBy = null;

// ---------------------------------------------------------------- arguments as bytes
// Node decodes argv as UTF-8: bytes that aren't are lost. When an argument isn't UTF-8, the shim
// (controller/boxery) passes the whole command line as BOXERY_ARGV (each argument's bytes, NUL-terminated,
// base64) and says so with ARGV_FROM_ENV in place of the arguments. The bytes are kept by position: two
// arguments can decode to the same string (both U+FFFD) and still differ.
const ARGV_FROM_ENV = "--boxery-argv-from-env";
/** The command line's arguments as bytes, by position. @type {Buffer[]} */
let RAW = [];
/** The command line (bytes decoded as UTF-8). BOXERY_ARGV is read only when the shim says it set it. @returns {string[]} */
export function commandLine() {
	const b64 = process.env.BOXERY_ARGV;
	delete process.env.BOXERY_ARGV;
	const argv = process.argv.slice(2);
	if (argv.length !== 1 || argv[0] !== ARGV_FROM_ENV || !b64) { RAW = argv.map((a) => Buffer.from(a)); return argv; }
	const bytes = Buffer.from(b64, "base64");
	RAW = [];
	for (let start = 0, i = 0; i < bytes.length; i++) if (bytes[i] === 0) { RAW.push(Buffer.from(bytes.subarray(start, i))); start = i + 1; }
	return RAW.map((b) => b.toString("utf8"));
}
/** The bytes of ARGS, which must be a tail of the command line (every parser here only drops leading
 *  words): the command line's own bytes for them, else their UTF-8. @param {string[]} args @returns {Buffer[]} */
export function rawTail(args) {
	const tail = RAW.slice(RAW.length - args.length);
	const same = tail.length === args.length && tail.every((b, i) => b.toString("utf8") === args[i]);
	return same ? tail : args.map((a) => Buffer.from(a));
}
/** Do these bytes differ from their UTF-8 decoding (bytes UTF-8 can't carry)? @param {Buffer[]} raw */
export const hasRawBytes = (raw) => raw.some((b) => !Buffer.from(b.toString("utf8")).equals(b));

/** A command's output, captured: {code, stdout} (stderr passes through). @param {string} cmd @param {string[]} args
 *  @param {{ env?: NodeJS.ProcessEnv, input?: string | Buffer }} [opts] @returns {Promise<{ code: number, stdout: string }>} */
export function capture(cmd, args, { env = process.env, input } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"], env });
		/** @type {Buffer[]} */
		const out = [];
		child.stdout?.on("data", (d) => out.push(d));
		child.on("error", (e) => { note(`boxery: cannot run ${cmd}: ${e.message}`); resolve({ code: 127, stdout: "" }); });
		child.on("close", (code, sig) => resolve({ code: code ?? 128 + (sig ? constants.signals[sig] ?? 0 : 0), stdout: Buffer.concat(out).toString("utf8") }));
		if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(input); }
	});
}

/** ssh to a VM through the profile's ssh_config, sharing this terminal. @param {Selected} s @param {string[]} args */
export async function vmSsh(s, args, /** @type {Parameters<typeof inherit>[2]} */ opts = {}) {
	const rc = await inherit("ssh", ["-F", s.host.sshConf, ...args], { env: s.config.env, ...opts });
	if (rc === 255 && !signalled) await explainUnreachable(s, args);
	return rc;
}
/** The same, with its output captured. explain: false when a 255 needs no explanation (wait's reconnects).
 *  @param {Selected} s @param {string[]} args @param {string | Buffer} [input] @param {{ explain?: boolean }} [opts] */
export async function vmSshCapture(s, args, input, { explain = true } = {}) {
	const r = await capture("ssh", ["-F", s.host.sshConf, ...args], { env: s.config.env, input });
	if (r.code === 255 && explain) await explainUnreachable(s, args);
	return r;
}
/** ssh to NAME.boxery (the first such word in ARGS) exited 255: say why, if it can't be reached (core
 *  vmProblem; ControlPersist hides the host's own message). Says nothing when the 255 was the command's,
 *  or after a signal (Ctrl-C makes ssh exit 255 too).
 *  @param {Selected} s @param {string[]} args */
async function explainUnreachable(s, args) {
	const vm = args.map((a) => /^([a-z][a-z0-9-]{0,30})\.boxery$/.exec(a)?.[1]).find(Boolean);
	if (!vm) return;
	const problem = await withHost(s.host, () => vmProblem(vm, { env: s.config.env })).catch(() => null);
	if (problem) warn(problem.message);
}

/**
 * boxery-host ARGS on the selected host, passed straight through (stdin, stdout, stderr): what the CLI's
 * host commands print is the host's. A failure ends the command with the host's exit status.
 * @param {Selected} s @param {string[]} args @param {{ stdin?: "inherit" | "pipe", input?: string }} [opts]
 */
export async function hostPass(s, args, { stdin = "inherit", input } = {}) {
	needHost(s);
	try {
		await hostRun(args, { host: s.host, config: s.config, timeout: 0, stdin: input === undefined ? stdin : "pipe", input, stdout: "inherit", stderr: "inherit" });
	} catch (e) { hostFailed(e); }
}
/** A host call's failure as the CLI reports it: the host's exit status, its message only if it hasn't
 *  shown one. @param {unknown} e @returns {never} */
export function hostFailed(e) {
	const err = /** @type {Error & { exitCode?: number, reported?: boolean }} */ (e);
	if (err instanceof CliError) throw err;
	if (err.reported) quit(err.exitCode ?? 1);
	die(err.message, err.exitCode ?? 1);
}
