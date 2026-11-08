import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadRecipe, recipeCommand } from "../core/recipes.mjs";
import { newVm } from "../core/lifecycle.mjs";

test("recipes are bounded data plus relative scripts, never controller-side execution", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-recipe-"));
	try {
		const file = path.join(dir, "recipe.json");
		writeFileSync(file, JSON.stringify({ version: 1, kind: "headless", distro: "arch", setup: "setup.sh" }));
		writeFileSync(path.join(dir, "setup.sh"), "printf 'hello' > recipe-ran\n");
		const recipe = loadRecipe(file);
		assert.match(recipe.sha256, /^[a-f0-9]{64}$/);
		assert.equal(loadRecipe(file).sha256, recipe.sha256);
		const guest = path.join(dir, "guest"); mkdirSync(guest);
		execFileSync("bash", ["-c", recipeCommand(recipe)], { cwd: guest, env: { ...process.env, HOME: guest } });
		assert.equal(readFileSync(path.join(guest, "recipe-ran"), "utf8"), "hello");
		const provenance = JSON.parse(readFileSync(path.join(guest, ".boxery/recipe.json"), "utf8"));
		assert.equal(provenance.sha256, recipe.sha256);
		assert.equal(provenance.distro, "arch");
		writeFileSync(path.join(dir, "setup.sh"), "exit 42\n");
		const changed = loadRecipe(file);
		assert.notEqual(changed.sha256, recipe.sha256);
		assert.throws(() => execFileSync("bash", ["-c", recipeCommand(changed)], { cwd: guest, env: { ...process.env, HOME: guest } }));
		assert.equal(JSON.parse(readFileSync(path.join(guest, ".boxery/recipe.json"), "utf8")).sha256, recipe.sha256, "failed setup cannot publish new provenance");
		for (const config of [[], {}, { version: 1, kind: "headless", grant: "env:SECRET" }, { version: 2, kind: "headless" }, { version: 1, kind: "desktop", distro: "arch" }, { version: 1, kind: "headless", setup: "/etc/passwd" }]) {
			writeFileSync(file, JSON.stringify(config));
			assert.throws(() => loadRecipe(file));
		}
		writeFileSync(file, JSON.stringify({ version: 1, kind: "headless", setup: "escape" }));
		symlinkSync("/etc/passwd", path.join(dir, "escape"));
		assert.throws(() => loadRecipe(file), /stay inside/);
		writeFileSync(file, " ".repeat(32769));
		assert.throws(() => loadRecipe(file), /at most/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid recipes/conflicting overrides fail before host creation", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-recipe-conflict-"));
	try {
		const file = path.join(dir, "recipe.json");
		writeFileSync(file, JSON.stringify({ version: 1, kind: "desktop", distro: "ubuntu" }));
		await assert.rejects(newVm("vm", { recipe: file, headless: true }), /conflicts/);
		await assert.rejects(newVm("vm", { recipe: file, distro: "arch" }), /conflicts/);
		await assert.rejects(newVm("vm", { recipe: file, from: "src@one" }), /cannot be combined/);
		await assert.rejects(newVm("vm", { recipe: file, layers: "github-runner" }), /cannot be combined/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
