// Repo-owned environment recipes are data plus an ordinary guest shell script. Nothing is executed
// on the controller or host. Loading is explicit (--recipe); no automatic discovery or grants.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { q } from "./shell.mjs";

/** @typedef {{ version: 1, kind: 'desktop' | 'headless', distro?: 'ubuntu' | 'arch', setup?: string }} RecipeConfig */
/** @typedef {{ config: RecipeConfig, script: string, sha256: string }} Recipe */
const LIMIT = 32 * 1024;
/** Read bounded regular files; a FIFO/device must not hang recipe validation. @param {string} file */
function read(file) {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > LIMIT) throw new Error(`recipe input must be a regular file of at most ${LIMIT} bytes: ${file}`);
		const bytes = readFileSync(fd);
		if (bytes.length > LIMIT || bytes.includes(0)) throw new Error(`invalid recipe input: ${file}`);
		return bytes.toString("utf8");
	} finally { closeSync(fd); }
}
/** @param {string} file @returns {Recipe} */
export function loadRecipe(file) {
	const source = realpathSync(file);
	const config = JSON.parse(read(source));
	if (!config || Array.isArray(config) || typeof config !== "object" || Object.keys(config).some((k) => !["version", "kind", "distro", "setup"].includes(k)) ||
		config.version !== 1 || !["desktop", "headless"].includes(config.kind) ||
		(config.distro !== undefined && !["ubuntu", "arch"].includes(config.distro)) ||
		(config.setup !== undefined && (typeof config.setup !== "string" || !config.setup || path.isAbsolute(config.setup)))) {
		throw new Error("invalid recipe: expected version:1, kind:desktop|headless, optional distro:ubuntu|arch and relative setup script; unknown fields are refused");
	}
	if (config.distro === "arch" && config.kind !== "headless") throw new Error("Arch recipes currently require kind:headless");
	let script = "";
	if (config.setup !== undefined) {
		const dir = path.dirname(source);
		const setup = realpathSync(path.resolve(dir, config.setup));
		const relative = path.relative(dir, setup);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("recipe setup must stay inside the recipe directory (including symlink targets)");
		script = read(setup);
	}
	const sha256 = createHash("sha256").update(JSON.stringify(config)).update("\0").update(script).digest("hex");
	return { config, script, sha256 };
}
/** A quoted guest command, run as agent using the existing process-group/timeout transport.
 * Provenance is published only after successful setup. No script or controller paths are recorded.
 * @param {Recipe} recipe */
export function recipeCommand(recipe) {
	const provenance = JSON.stringify({ version: 1, sha256: recipe.sha256, kind: recipe.config.kind, distro: recipe.config.distro ?? "backend-default" });
	// exec receives one bounded argument; quoting can expand apostrophes, so base64 the script first.
	const encoded = Buffer.from(recipe.script).toString("base64");
	return `set -e; printf %s ${q(encoded)} | base64 -d | bash -euo pipefail; mkdir -p "$HOME/.boxery"; umask 077; printf %s ${q(provenance)} >"$HOME/.boxery/recipe.json.new"; mv "$HOME/.boxery/recipe.json.new" "$HOME/.boxery/recipe.json"`;
}
