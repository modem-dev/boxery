// Host configuration: where state lives, which backend runs VMs, and the settings `init` persists in
// $BOXERY_CONF/host.env. Explicit environment variables win over the file; an empty one counts as unset.
// No dependencies beyond node: builtins, so it loads on every supported Node version.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Settings `init` persists in host.env and later commands read from it: the proxy's and the backends'
// (host/backends/README.md). One list, host/host-env.list, which host/backend.sh reads too.
export const HOST_ENV = readFileSync(path.join(ROOT, "host/host-env.list"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));

// Backend routing settings an operation journals, so recovery replays it in the same backend namespace.
// Never arbitrary environment variables or credentials.
export const SETTINGS = ["BOXERY_BACKEND", "BOXERY_POOL", "BOXERY_POOL_DIR", "BOXERY_BASE_VOL", "BOXERY_DOMAIN_PREFIX", "BOXERY_NET",
	"LIBVIRT_DEFAULT_URI", "LIMA_HOME", "BOXERY_LIMA_PREFIX", "BOXERY_LIMA_GATEWAY", "BOXERY_LIMA_VMTYPE", "BOXERY_LIMA_ARCH",
	"BOXERY_CH_DIR", "BOXERY_CH_NET", "BOXERY_CH_DNS", "BOXERY_CH_FIRMWARE", "BOXERY_CH_SUDO", "BOXERY_FAKE_DIR", "BOXERY_PROXY_PORT", "BOXERY_OPENSHELL_GATEWAY", "BOXERY_OPENSHELL_WORKSPACE",
	"BOXERY_OPENSHELL_PREFIX", "BOXERY_OPENSHELL_IMAGE", "BOXERY_OPENSHELL_POLICY", "BOXERY_OPENSHELL_PROVIDERS"];

export const defaultConf = () => path.join(homedir(), ".config/boxery");
/** `boxery-host --profile NAME`: a second profile's state directory. */
export const profileConf = (/** @type {string} */ name) => `${defaultConf()}-${name}`;

/** @typedef {ReturnType<typeof loadConfig>} Config */

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
	const conf = path.resolve(env.BOXERY_CONF || defaultConf());
	// Set by `boxery-host --profile NAME` (together with BOXERY_CONF); ignored for any other directory.
	const profile = env.BOXERY_PROFILE && conf === path.resolve(profileConf(env.BOXERY_PROFILE)) ? env.BOXERY_PROFILE : null;
	const merged = { ...env };
	let text = "";
	try { text = readFileSync(path.join(conf, "host.env"), "utf8"); }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	for (const line of text.split("\n")) {
		const i = line.indexOf("=");
		const [k, v] = i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
		if (HOST_ENV.includes(k) && !merged[k]) merged[k] = v;
	}
	const proxyUnit = merged.BOXERY_PROXY_UNIT || (profile ? `boxery-proxy-${profile}` : "boxery-proxy");
	return {
		conf,
		profile,
		root: ROOT,
		env: merged,
		backend: merged.BOXERY_BACKEND || "libvirt",
		proxyPort: merged.BOXERY_PROXY_PORT || "8088",
		proxyUnit,
		reaperUnit: merged.BOXERY_REAPER_UNIT || proxyUnit.replace("proxy", "reaper"),
		// The GitHub Actions runner manager (host/runners.mjs): installed by init, started by `runners start`.
		runnersUnit: proxyUnit.replace("proxy", "runners"),
		cache: merged.BOXERY_CACHE || path.join(homedir(), ".cache/boxery"),
	};
}
