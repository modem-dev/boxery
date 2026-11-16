#!/usr/bin/env node
// Real VMs can incur charges. This is never part of npm test or automatic offline CI.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lifecycleSmoke } from "./lifecycle.mjs";

if (process.env.BOXERY_LIVE_ALLOW_CREATE !== "1" || !process.env.BOXERY_LIVE_HOST) {
	console.error("Refusing live VM creation. Set BOXERY_LIVE_ALLOW_CREATE=1 and BOXERY_LIVE_HOST to an explicit registered test host (provider compute may be billed).");
	process.exitCode = 2;
} else {
	const abort = new AbortController();
	const cancel = () => abort.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	const cli = process.env.BOXERY_LIVE_CLI ?? fileURLToPath(new URL("../../controller/boxery", import.meta.url));
	try {
		await lifecycleSmoke({ host: process.env.BOXERY_LIVE_HOST, distro: process.env.BOXERY_LIVE_DISTRO,
			run: (args, { cleanup = false } = {}) => new Promise((resolve, reject) => {
				execFile(cli, args, { timeout: 15 * 60_000, maxBuffer: 1024 * 1024, signal: cleanup ? undefined : abort.signal }, (e, stdout, stderr) => {
					if (stderr) process.stderr.write(stderr);
					if (e) reject(e); else resolve(stdout);
				});
			}),
		});
	} catch (e) {
		console.error(e);
		if (e instanceof AggregateError) for (const failure of e.errors) console.error(failure);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
	}
}
