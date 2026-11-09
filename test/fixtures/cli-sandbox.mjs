// A fully isolated controller for boundary tests. Even accidental transport calls hit stubs, never SSH.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostTransport, hostCalls } from "./host-transport.mjs";
import { registerHost } from "./register-host.mjs";

export function cliSandbox() {
	const root = mkdtempSync(path.join(tmpdir(), "boxery-boundaries-"));
	const home = path.join(root, "registry"), bin = path.join(root, "bin"), log = path.join(root, "ssh.calls");
	const cli = path.resolve(import.meta.dirname, "../../controller/boxery");
	const profile = (/** @type {string} */ name) => path.join(root, "profiles", name);
	mkdirSync(bin);
	mkdirSync(path.join(root, "home", "project"), { recursive: true });
	for (const name of ["alpha", "beta"]) registerHost(home, name, profile(name));
	hostTransport(root, [profile("alpha"), profile("beta")]);
	const hostbin = path.join(root, "grant-host"), hostScript = readFileSync(hostbin, "utf8");
	writeFileSync(path.join(root, "host.ls.json"), '[{"name":"demo","state":"running"}]\n');
	writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), command = args.at(-1) ?? '';
const at = args.indexOf('-F'), profile = at >= 0 ? path.dirname(args[at + 1]) : process.env.BOXERY_STUB_PROFILE;
appendFileSync(process.env.BOXERY_TEST_SSH_LOG, JSON.stringify({args, profile})+'\\n');
if (process.env.BOXERY_TEST_SIGNAL) process.kill(process.pid, process.env.BOXERY_TEST_SIGNAL);
else if (command.includes('for f in ~/.pi/agent/settings.json')) process.stdout.write('\\x1e'+JSON.stringify({defaultProvider:'openai-codex'})+'\\x1e{}\\x1e'+JSON.stringify({providers:{'openai-codex':{baseUrl:'http://127.0.0.1:8088/chatgpt'}}}));
else if (command.includes(' start ') && command.endsWith(' --text')) console.log('job-20261109-000001-abcdef');
else if (command.includes(' wait ')) console.log(JSON.stringify({state:'exited',exit_code:0}));
else console.log('fixture');
process.exit(Number(process.env.BOXERY_TEST_EXIT ?? 0));
`);
	writeFileSync(path.join(bin, "boxery"), '#!/bin/sh\nexec "$BOXERY_TEST_CLI" "$@"\n');
	for (const name of ["ssh", "boxery"]) chmodSync(path.join(bin, name), 0o755);
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOXERY_") && !key.startsWith("SSH_")));
	const env = { ...inherited, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), BOXERY_HOME: home, PATH: `${bin}:${process.env.PATH}`, BOXERY_TEST_SSH_LOG: log, BOXERY_TEST_CLI: cli, BOXERY_STATUS: "0", NO_COLOR: "1" };
	/** @param {string[]} args @param {NodeJS.ProcessEnv} [extra] @param {string} [input] */
	const run = (args, extra = {}, input = "") => {
		const options = { env: { ...env, ...extra }, encoding: /** @type {const} */ ("utf8"), input, timeout: 20_000, cwd: root, detached: true };
		return spawnSync(cli, args, options);
	};
	/** @param {string} line */
	const shell = (line) => {
		const options = { env, encoding: /** @type {const} */ ("utf8"), input: "", timeout: 20_000, cwd: root, detached: true };
		return spawnSync("/bin/sh", ["-c", line], options);
	};
	/** @param {string[]} args @param {string} [answer] @param {NodeJS.ProcessEnv} [extra] */
	const pty = (args, answer = "", extra = {}) => JSON.parse(execFileSync("python3", [path.join(import.meta.dirname, "grant-pty.py"), answer, cli, ...args], { env: { ...env, ...extra }, cwd: root, encoding: "utf8", timeout: 20_000 }));
	const clear = () => { rmSync(log, { force: true }); rmSync(path.join(root, "host.calls"), { force: true }); };
	const ssh = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	/** @param {string} name @param {string} text @param {string} [host] */
	const grant = (name, text, host = "alpha") => writeFileSync(path.join(profile(host), "grants", name), text);
	/** @param {string} dir @returns {string[]} */
	const tree = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const f = path.join(dir, e.name);
		return e.isDirectory() ? tree(f) : [`${path.relative(root, f)}=${readFileSync(f, "utf8")}`];
	}).sort();
	const state = () => [...tree(home), ...tree(path.join(root, "profiles"))];
	const reset = () => {
		writeFileSync(path.join(home, "default-host"), "alpha\n");
		writeFileSync(hostbin, hostScript);
		for (const name of ["alpha", "beta"]) {
			for (const dir of ["grants", "leases"]) rmSync(path.join(profile(name), dir), { recursive: true, force: true });
			mkdirSync(path.join(profile(name), "grants"));
		}
		clear();
	};
	reset();
	// Finish ordinary ssh_config/feature-cache setup once, before observing operation-specific effects.
	for (const prefix of [[], ["--host", "beta"]]) {
		const r = run([...prefix, "lease", "ls"]);
		if (r.status !== 0) throw new Error(r.stderr);
	}
	clear();
	return { root, home, profile, env, hostbin, run, shell, pty, clear, ssh, grant, state, reset, host: () => hostCalls(root), close: () => rmSync(root, { recursive: true, force: true }) };
}
