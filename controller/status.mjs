// Terminal status (OSC 7501). Long commands tell the terminal what they are doing, so one that speaks the
// Program Status Protocol (Rex) can show a spinner while a command runs and mark it done or failed in a tab
// you aren't looking at. Spec: https://www.superlogical.com/rex/docs/build/program-status
// Terminals ignore sequences they don't know, so this is invisible elsewhere. It is only sent when stderr is
// a terminal (BOXERY_STATUS=1 forces it on, 0 off), and on stderr rather than stdout: scripts read stdout.
// One seam: main() in cli.mjs wraps the command in reporting(), and a command opts in with a `status` on its
// COMMANDS entry. No command reports anything itself. test/parity.test.mjs checks that every command either
// declares one or says why it has none.
import { constants } from "node:os";
import { CliError, interrupted, VALID_VM, WAIT_LOST, WAIT_TIMEOUT } from "./lib.mjs";

/** How a command reports: `vm` if its first argument names a VM (the message says which); `when` to report
 *  only some invocations (not --bg, not help, not a listing that returns at once).
 *  @typedef {{ vm?: boolean, when?: (args: string[]) => boolean }} StatusSpec */

/** @param {NodeJS.ProcessEnv} [env] @param {{ isTTY?: boolean }} [stream] */
export function statusEnabled(env = process.env, stream = process.stderr) {
	switch (env.BOXERY_STATUS ?? "auto") {
		case "0": case "off": case "false": return false;
		case "1": case "on": case "true": return true;
	}
	return !!stream.isTTY && (env.TERM ?? "dumb") !== "dumb";
}

/** One report. Each report replaces the whole record, so every one repeats app.
 *  @param {"working" | "done" | "error" | "idle"} state @param {string} [text] */
export function emit(state, text = "") {
	// (Control characters would make the terminal discard the whole report; ours has none, but the text is data.)
	const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	const msg = clean ? `:msg=${Buffer.from(clean).toString("base64")}` : "";
	process.stderr.write(`\x1b]7501;state=${state}:app=boxery${msg}\x1b\\`);
}

/** How a command ended: the state to report and what to say. 124 and 125 mean something only for wait; for
 *  anything else they are the command's own exit code (timeout(1) exits 124).
 *  @param {string} cmd @param {number} code @returns {{ state: "done" | "error" | "idle", word: string }} */
export function outcome(cmd, code) {
	if (code === 0) return { state: "done", word: "done" };
	if (code === 128 + constants.signals.SIGINT || code === 128 + constants.signals.SIGTERM) return { state: "idle", word: "stopped" }; // the user's doing, not a failure
	if (cmd === "wait" && code === WAIT_TIMEOUT) return { state: "idle", word: "timed out (the job is still running)" };
	if (cmd === "wait" && code === WAIT_LOST) return { state: "error", word: "lost the job" };
	return { state: "error", word: `failed (exit ${code})` };
}

const SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM"]);

/**
 * Run FN, reporting `working` first and how it ended after. SPEC is the command's `status`; with none, or when
 * this invocation or terminal isn't one to report to, FN just runs. The message is only the validated VM name,
 * the command and the outcome, never what the command printed.
 * A signal that ends the process without reaching a handler (Node waiting on the host, no child holding the
 * terminal) is reported as stopped before the process dies of it. When a child shares the terminal, lib.mjs
 * inherit() has its own handlers and the child's end comes back here as an error, stopped if it was interrupted.
 * @template T
 * @param {string} cmd @param {StatusSpec | undefined} spec @param {string[]} args @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function reporting(cmd, spec, args, fn) {
	if (!spec || spec.when?.(args) === false || !statusEnabled()) return fn();
	const vm = spec.vm && VALID_VM.test(args[0] ?? "") ? args[0] : "";
	const label = vm ? `${vm}: ${cmd}` : cmd;
	let ended = false;
	const finish = (/** @type {number} */ code) => {
		if (ended) return;
		ended = true;
		const { state, word } = outcome(cmd, code);
		emit(state, `${label} ${word}`);
	};
	const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
		if (process.listenerCount(sig) > 1) return; // someone else owns it (a child holds the terminal): its exit reports
		finish(128 + constants.signals[sig]);
		process.off(sig, onSignal);
		process.kill(process.pid, sig); // now with the default action: the process ends by the signal, as it would have
	};
	for (const sig of SIGNALS) process.on(sig, onSignal);
	emit("working", label);
	try {
		const r = await fn();
		finish(0);
		return r;
	} catch (e) {
		const code = e instanceof CliError ? e.exitCode : 1;
		// (ssh exits 255 after Ctrl-C, so a signal that arrived while a child ran decides, not its exit code)
		finish(code !== 0 && interrupted() ? 128 + constants.signals.SIGINT : code);
		throw e;
	} finally {
		for (const sig of SIGNALS) process.off(sig, onSignal);
	}
}
