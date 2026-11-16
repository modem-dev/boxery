// Offline checks of the opt-in live runner's safety/cleanup, not simulated hypervisor validation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { lifecycleSmoke } from "./live/lifecycle.mjs";

function fixture(failAt = "", cleanupFails = false) {
	const calls = [];
	const names = [];
	return { calls, names, run: async (args, opts = {}) => {
		calls.push({ args, opts });
		const command = args[2], name = args[3];
		if (command === "backend") return "libvirt\n";
		if (command === "new" || command === "fork") names.push(command === "fork" ? args[4] : name);
		if (command === failAt) throw new Error("injected failure");
		if (command === "rm" && cleanupFails) throw new Error("cleanup failed");
		if (command === "run" && args.at(-1)?.startsWith("cat /etc/machine-id")) {
			const id = names.indexOf(name) + 1;
			return `${String(id).repeat(32)}\nssh-ed25519 PUBLIC-${id}\n`;
		}
		return "";
	} };
}

test("live entry refuses to create anything without explicit consent and a host", () => {
	assert.throws(() => execFileSync(process.execPath, [new URL("./live/run.mjs", import.meta.url).pathname], {
		env: { ...process.env, BOXERY_LIVE_ALLOW_CREATE: "", BOXERY_LIVE_HOST: "test", BOXERY_LIVE_CLI: "/nonexistent" }, stdio: "pipe",
	}), (/** @type {any} */ e) => e.status === 2 && /Refusing live VM creation/.test(e.stderr.toString()));
});

test("live workflow mutates only generated resources, never bases/grants/network config", async () => {
	const f = fixture();
	await lifecycleSmoke({ host: "test-host", run: f.run, log: () => {} });
	assert.equal(f.names.length, 3);
	assert.ok(f.names.every((n) => /^live-[a-f0-9]{10}-[abc]$/.test(n)));
	assert.deepEqual(f.calls.filter((c) => c.args[2] === "rm").map((c) => c.args[3]), [...f.names].reverse());
	assert.ok(f.calls.every((c) => c.args[0] === "--host" && c.args[1] === "test-host"));
	assert.ok(f.calls.every((c) => !["init", "build-base", "grant", "pool"].includes(c.args[2])));
	assert.ok(f.calls.filter((c) => c.args[2] === "rm").every((c) => c.opts.cleanup === true));
});

test("failure cleans up every attempted create, even a partially created VM, and surfaces cleanup failures", async () => {
	for (const point of ["new", "snap", "fork"]) {
		const f = fixture(point);
		await assert.rejects(lifecycleSmoke({ host: "test-host", run: f.run, log: () => {} }), AggregateError);
		assert.deepEqual(f.calls.filter((c) => c.args[2] === "rm").map((c) => c.args[3]), [...f.names].reverse());
	}
	const f = fixture("snap", true);
	await assert.rejects(lifecycleSmoke({ host: "test-host", run: f.run, log: () => {} }), (e) => e instanceof AggregateError && e.errors.some((x) => /cleanup failed/.test(x.message)));
});

test("bad host/distro and unsupported native combinations fail before any create", async () => {
	const f = fixture();
	await assert.rejects(lifecycleSmoke({ host: "bad;host", run: f.run }), /explicit registered host/);
	await assert.rejects(lifecycleSmoke({ host: "test-host", distro: "bad", run: f.run }), /ubuntu or arch/);
	await assert.rejects(lifecycleSmoke({ host: "test-host", distro: "arch", run: f.run }), /requires.*Lima/);
	assert.equal(f.names.length, 0);
});
