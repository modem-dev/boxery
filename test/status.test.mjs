// Terminal status (OSC 7501): controller/status.mjs. Which commands report is pinned by test/parity.test.mjs; the
// real CLI on a pty (auto-detection, Ctrl-C, TERM=dumb) is in test/shell/controller-local.sh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { CliError, WAIT_LOST, WAIT_TIMEOUT } from "../controller/lib.mjs";
import { emit, outcome, reporting, statusEnabled } from "../controller/status.mjs";

/** The reports in a stream of bytes: "STATE APP MSG", the msg decoded. @param {string | Buffer} data */
function reports(data) {
	return [...Buffer.from(data).toString("latin1").matchAll(/\x1b\]7501;([^\x1b]*)\x1b\\/g)].map((m) => {
		const kv = Object.fromEntries(m[1].split(":").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
		return `${kv.state} ${kv.app} ${Buffer.from(kv.msg ?? "", "base64").toString()}`.trimEnd();
	});
}

/** Run FN with what is written to stderr captured, and BOXERY_STATUS set. @param {string | undefined} status @param {() => Promise<unknown>} fn */
async function captured(status, fn) {
	const write = process.stderr.write, was = process.env.BOXERY_STATUS;
	let out = "";
	process.stderr.write = /** @type {any} */ ((/** @type {string} */ chunk) => { out += chunk; return true; });
	if (status === undefined) delete process.env.BOXERY_STATUS; else process.env.BOXERY_STATUS = status;
	try { await fn().catch(() => {}); } finally {
		process.stderr.write = write;
		if (was === undefined) delete process.env.BOXERY_STATUS; else process.env.BOXERY_STATUS = was;
	}
	return reports(out);
}

test("statusEnabled: on for a terminal, off for pipes and TERM=dumb, and BOXERY_STATUS decides", () => {
	const tty = { isTTY: true }, pipe = { isTTY: false };
	assert.equal(statusEnabled({ TERM: "xterm" }, tty), true);
	assert.equal(statusEnabled({ TERM: "xterm" }, pipe), false);
	assert.equal(statusEnabled({}, tty), false, "no TERM is dumb");
	assert.equal(statusEnabled({ TERM: "dumb" }, tty), false);
	assert.equal(statusEnabled({ TERM: "xterm", BOXERY_STATUS: "0" }, tty), false);
	assert.equal(statusEnabled({ TERM: "dumb", BOXERY_STATUS: "1" }, pipe), true, "=1 forces it on");
});

test("emit: the protocol's syntax, the app on every report, the message as base64", () => {
	let out = "";
	const write = process.stderr.write;
	process.stderr.write = /** @type {any} */ ((/** @type {string} */ c) => { out += c; return true; });
	try { emit("working", "demo: run"); emit("idle"); emit("error", "bad\x1b]0;x\x07 text"); } finally { process.stderr.write = write; }
	assert.equal(out.split("\x1b\\").slice(0, 2).join("\x1b\\") + "\x1b\\", `\x1b]7501;state=working:app=boxery:msg=${Buffer.from("demo: run").toString("base64")}\x1b\\\x1b]7501;state=idle:app=boxery\x1b\\`);
	assert.deepEqual(reports(out), ["working boxery demo: run", "idle boxery", "error boxery bad]0;x text"], "control characters are dropped, so the terminal never discards the report");
});

test("outcome: exit codes map to done, idle or error; 124 and 125 are special only for wait", () => {
	assert.equal(outcome("run", 0).state, "done");
	assert.deepEqual(outcome("run", 2), { state: "error", word: "failed (exit 2)" });
	for (const code of [130, 143]) assert.equal(outcome("run", code).state, "idle", `${code} is the user stopping it`);
	assert.equal(outcome("run", 124).state, "error", "timeout(1) exits 124: that is run's own exit code");
	assert.equal(outcome("wait", WAIT_TIMEOUT).state, "idle");
	assert.equal(outcome("wait", WAIT_LOST).state, "error");
	assert.equal(outcome("wait", 3).state, "error", "the job's own exit code");
});

test("reporting: working, then done; the VM is named when the first argument is one", async () => {
	const got = await captured("1", () => reporting("run", { vm: true }, ["demo", "true"], async () => 5));
	assert.deepEqual(got, ["working boxery demo: run", "done boxery demo: run done"]);
	assert.equal(await reporting("run", undefined, [], async () => "result"), "result", "its result comes back");
});

test("reporting: a failure reports error with the exit code and is rethrown as it was", async () => {
	const err = new CliError("", 3);
	/** @type {unknown} */
	let thrown;
	const got = await captured("1", () => reporting("run", { vm: true }, ["demo", "x"], async () => { throw err; }).catch((e) => { thrown = e; throw e; }));
	assert.deepEqual(got, ["working boxery demo: run", "error boxery demo: run failed (exit 3)"]);
	assert.equal(thrown, err);
	assert.deepEqual(await captured("1", () => reporting("new", { vm: true }, ["demo"], async () => { throw new Error("boom"); })), ["working boxery demo: new", "error boxery demo: new failed (exit 1)"]);
	assert.deepEqual(await captured("1", () => reporting("wait", { vm: true }, ["demo", "job-1"], async () => { throw new CliError("", WAIT_TIMEOUT); })), ["working boxery demo: wait", "idle boxery demo: wait timed out (the job is still running)"]);
	assert.deepEqual(await captured("1", () => reporting("wait", { vm: true }, ["demo", "job-1"], async () => { throw new CliError("", 0); })), ["working boxery demo: wait", "done boxery demo: wait done"], "quit(0) is success");
});

test("reporting: only a valid VM name goes into the message", async () => {
	for (const bad of ["--all", "Bad Name", "a;b", "", undefined]) {
		const got = await captured("1", () => reporting("patch", { vm: true }, bad === undefined ? [] : [bad], async () => {}));
		assert.deepEqual(got, ["working boxery patch", "done boxery patch done"], `args ${JSON.stringify(bad)}`);
	}
	assert.deepEqual(await captured("1", () => reporting("build-base", {}, ["demo"], async () => {})), ["working boxery build-base", "done boxery build-base done"], "a command without a VM never names one");
});

test("reporting: silent without a spec, when `when` says no, or when status is off", async () => {
	let ran = 0;
	const fn = async () => { ran++; };
	assert.deepEqual(await captured("1", () => reporting("ls", undefined, [], fn)), []);
	assert.deepEqual(await captured("1", () => reporting("run", { vm: true, when: (a) => !a.includes("--bg") }, ["demo", "--bg", "x"], fn)), []);
	assert.deepEqual(await captured("0", () => reporting("run", { vm: true }, ["demo", "x"], fn)), []);
	assert.deepEqual(await captured(undefined, () => reporting("run", { vm: true }, ["demo", "x"], fn)), [], "stderr is not a terminal under test");
	assert.equal(ran, 4, "the command ran every time");
});

test("reporting: a signal that reaches no other handler reports stopped, then ends the process by it", async () => {
	const code = `
		import { reporting } from ${JSON.stringify(new URL("../controller/status.mjs", import.meta.url).href)};
		await reporting("wait", { vm: true }, ["demo", "job-1"], () => { console.log("ready"); setInterval(() => {}, 1000); return new Promise(() => {}); });`; // (the interval keeps the process alive)
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, BOXERY_STATUS: "1" } });
	let err = Buffer.alloc(0), out = "";
	child.stderr.on("data", (d) => { err = Buffer.concat([err, d]); });
	child.stdout.on("data", (d) => { out += d; if (out.includes("ready")) child.kill("SIGINT"); });
	const [exitCode, signal] = await new Promise((resolve) => child.on("close", (c, s) => resolve([c, s])));
	assert.deepEqual(reports(err), ["working boxery demo: wait", "idle boxery demo: wait stopped"]);
	assert.equal(signal, "SIGINT", `ended by the signal, not exit ${exitCode}`);
});

test("reporting: a signal another handler owns is left to it (a child holds the terminal)", async () => {
	const code = `
		import { reporting } from ${JSON.stringify(new URL("../controller/status.mjs", import.meta.url).href)};
		import { CliError } from ${JSON.stringify(new URL("../controller/lib.mjs", import.meta.url).href)};
		process.on("SIGINT", () => {}); // what inherit() does while ssh owns Ctrl-C
		await reporting("run", { vm: true }, ["demo", "x"], () => new Promise((_, reject) => { console.log("ready"); setInterval(() => {}, 1000); process.on("SIGINT", () => setTimeout(() => reject(new CliError("", 130)), 50)); })).catch(() => {});
		console.log("survived"); process.exit(0);`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, BOXERY_STATUS: "1" } });
	let err = Buffer.alloc(0), out = "";
	child.stderr.on("data", (d) => { err = Buffer.concat([err, d]); });
	child.stdout.on("data", (d) => { out += d; if (out.includes("ready") && !out.includes("sent")) { out += "sent"; child.kill("SIGINT"); } });
	const [exitCode, signal] = await new Promise((resolve) => child.on("close", (c, s) => resolve([c, s])));
	assert.equal(signal, null);
	assert.equal(exitCode, 0);
	assert.ok(out.includes("survived"));
	assert.deepEqual(reports(err), ["working boxery demo: run", "idle boxery demo: run stopped"], "reported once, from the exit code");
});
