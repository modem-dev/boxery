// Small file helpers shared by core and the CLI. No imports beyond node: builtins.
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Write FILE whole: a temporary file renamed over it, so readers never see half of it. The temporary file is
 *  removed if anything fails. @param {string} file @param {string} text @param {{ mode?: number }} [opts] */
export function writeAtomic(file, text, { mode } = {}) {
	const tmp = `${file}.tmp.${process.pid}`;
	try {
		writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
		renameSync(tmp, file);
	} finally { rmSync(tmp, { force: true }); }
}
