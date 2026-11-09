// Terminal status (OSC 7501). Long commands tell the terminal what they are doing, so one that speaks the
// Program Status Protocol (Rex) can show a spinner while a command runs and mark it done or failed in a tab
// you aren't looking at. Spec: https://www.superlogical.com/rex/docs/build/program-status
// Terminals ignore sequences they don't know, so this is invisible elsewhere. It is only sent when stderr is
// a terminal (BOXERY_STATUS=1 forces it on, 0 off), and on stderr rather than stdout: scripts read stdout.
// One seam: main() in cli.mjs wraps the command in reporting(), and a command opts in with a `status` on its
// COMMANDS entry. No command reports anything itself. test/parity.test.mjs checks that every command either
// declares one or says why it has none.
import { constants } from "node:os";
import { CliError, USAGE, VALID_VM, WAIT_LOST, WAIT_TIMEOUT, wasInterrupted } from "./lib.mjs";

/** How a command reports: `vm` if one of its arguments names a VM (true: the first; a number: that one), and the
 *  message says which; `when` to report only some invocations (not --bg, not a wait that can't wait).
 *  @typedef {{ vm?: boolean | number, when?: (args: string[]) => boolean }} StatusSpec */

/** @param {NodeJS.ProcessEnv} [env] @param {{ isTTY?: boolean }} [stream] */
export function statusEnabled(env = process.env, stream = process.stderr) {
	switch (env.BOXERY_STATUS ?? "auto") {
		case "": case "auto": return !!stream.isTTY && (env.TERM ?? "dumb") !== "dumb";
		case "1": case "on": case "true": return true;
		default: return false; // 0, off, false, and anything else that isn't a yes: a typo shouldn't turn it on
	}
}

/** One report. Each report replaces the whole record, so every one repeats app. kind: what a blocked
 *  command waits for. @param {"working" | "blocked" | "done" | "error" | "idle"} state @param {string} [text] @param {"permission" | "question" | "auth"} [kind] */
export function emit(state, text = "", kind) {
	// (Control characters would make the terminal discard the whole report; ours has none, but the text is data.)
	const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	const msg = clean ? `:msg=${Buffer.from(clean).toString("base64")}` : "";
	process.stderr.write(`\x1b]7501;state=${state}${kind && state === "blocked" ? `:kind=${kind}` : ""}:app=boxery${msg}\x1b\\`);
}

/** How a command ended: the state to report and what to say. 124 and 125 mean something only for wait; for
 *  anything else they are the command's own exit code (timeout(1) exits 124).
 *  @param {string} cmd @param {number} code @returns {{ state: "done" | "error" | "idle", word: string }} */
export function outcome(cmd, code) {
	if (code === 0) return { state: "done", word: "done" };
	if (code === 128 + constants.signals.SIGINT || code === 128 + constants.signals.SIGTERM) return { state: "idle", word: "stopped" }; // the user's doing, not a failure
	// done, not idle: the wait is over and the person should look (a terminal may drop idle records, and a timeout is no interrupt)
	if (cmd === "wait" && code === WAIT_TIMEOUT) return { state: "done", word: "timed out (the job is still running)" };
	if (cmd === "wait" && code === WAIT_LOST) return { state: "error", word: "lost the job" };
	return { state: "error", word: `failed (exit ${code})` };
}

const SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM"]);

/** The command being reported, so that code waiting for a person can say so (blockedOnPerson). @type {{ label: string, pause: (kind: "permission" | "question" | "auth") => void, resume: () => void } | null} */
let active = null;

/**
 * Run FN, which waits for the person at this terminal (a prompt that blocks reading the keyboard): the report
 * is `blocked` meanwhile, not `working`, and Ctrl-C is the terminal's again. Our signal handler is off for
 * the wait: a blocking read can't run it until the read returns, and it would keep Ctrl-C from ending the
 * command at the prompt. (Then the process dies unreported; a terminal drops a blocked record when it exits.)
 * Outside a reported command it just runs FN.
 * @template T @param {"permission" | "question" | "auth"} kind @param {() => T} fn @returns {T}
 */
export function blockedOnPerson(kind, fn) {
	const a = active;
	if (!a) return fn();
	a.pause(kind);
	try { return fn(); } finally { a.resume(); }
}

/**
 * Run FN, reporting `working` first and how it ended after. SPEC is the command's `status`; with none, or when
 * this invocation or terminal isn't one to report to, FN just runs. The message is only the validated VM name,
 * the command and the outcome, never what the command printed.
 * A signal that ends the process without reaching a handler (Node waiting on the host, no child holding the
 * terminal) is reported as stopped before the process dies of it. When a child shares the terminal, lib.mjs
 * inherit() has its own handlers and the child's end comes back here as an error, stopped if it was interrupted.
 * A usage error (a mistake in the command line, nothing ran) is reported as idle, not as a failure.
 * @template T
 * @param {string} cmd @param {StatusSpec | undefined} spec @param {string[]} args @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function reporting(cmd, spec, args, fn) {
	if (!spec || spec.when?.(args) === false || !statusEnabled()) return fn();
	const vm = spec.vm !== undefined && spec.vm !== false && VALID_VM.test(args[spec.vm === true ? 0 : spec.vm] ?? "") ? args[spec.vm === true ? 0 : spec.vm] : "";
	const label = vm ? `${vm}: ${cmd}` : cmd;
	let ended = false;
	const end = (/** @type {"done" | "error" | "idle"} */ state, /** @type {string} */ word) => {
		if (ended) return;
		ended = true;
		emit(state, `${label} ${word}`);
	};
	const finish = (/** @type {number} */ code) => { const { state, word } = outcome(cmd, code); end(state, word); };
	const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
		if (process.listenerCount(sig) > 1) return; // someone else owns it (a child holds the terminal): its exit reports
		finish(128 + constants.signals[sig]);
		process.off(sig, onSignal);
		process.kill(process.pid, sig); // now with the default action: the process ends by the signal, as it would have
	};
	const listen = () => { for (const sig of SIGNALS) process.on(sig, onSignal); };
	const unlisten = () => { for (const sig of SIGNALS) process.off(sig, onSignal); };
	active = { label, pause: (kind) => { unlisten(); emit("blocked", `${label} is waiting for your approval`, kind); }, resume: () => { listen(); emit("working", label); } };
	listen();
	emit("working", label);
	try {
		const r = await fn();
		finish(0);
		return r;
	} catch (e) {
		const code = e instanceof CliError ? e.exitCode : 1;
		if (e instanceof CliError && code === USAGE && e.message) end("idle", "not run: usage error");
		// (ssh exits 255 after Ctrl-C, so a signal that arrived while a child ran decides, not its exit code)
		else finish(code !== 0 && wasInterrupted() ? 128 + constants.signals.SIGINT : code);
		throw e;
	} finally {
		unlisten();
		active = null;
	}
}
