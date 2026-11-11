// boxery mcp-token new|ls|rm: scoped tokens for the HTTP MCP server (core/mcp-tokens.mjs, docs/mcp.md).
// Only a person mints them: no agent tool does (test/parity.test.mjs says why).
import { resolveHost } from "../core/boxery-core.mjs";
import { toolCatalog } from "../core/boxery-tools.mjs";
import { createToken, describeScope, hostNames, parseTtl, readStore, removeToken, toolsScope, vmPatterns } from "../core/mcp-tokens.mjs";
import { die, say, usage } from "./lib.mjs";

/** @param {number | null} t */
const when = (t) => (t == null ? "never" : new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z"));

/** @param {string[]} args */
export async function mcpTokenCommand(args) {
	const [action, ...rest] = args;
	switch (action) {
		case "new": {
			const label = rest.shift();
			if (!label || label.startsWith("-")) usage("mcp-token");
			/** @type {string[]} */
			const vms = [], hosts = [];
			let tools = /** @type {string | null} */ (null), readOnly = false, admin = false, ttl = "30d";
			while (rest.length) {
				const a = /** @type {string} */ (rest.shift());
				const value = () => rest.shift() ?? die(`${a} needs a value`);
				if (a === "--vm") vms.push(value());
				else if (a === "--host") hosts.push(value());
				else if (a === "--tools") tools = value();
				else if (a === "--read-only") readOnly = true;
				else if (a === "--admin") admin = true;
				else if (a === "--ttl") ttl = value();
				else usage("mcp-token");
			}
			for (const h of hosts) {
				try { resolveHost(h); } catch (e) { die(`--host ${h}: ${/** @type {Error} */ (e).message} (boxery host ls lists the hosts)`); }
			}
			const scope = { tools: toolsScope(toolCatalog(), { tools, readOnly }), hosts: hostNames(hosts), vms: vmPatterns(vms), admin };
			const { secret, entry } = createToken(/** @type {string} */ (label), scope, { ttl: parseTtl(ttl) });
			say(secret);
			process.stderr.write(`boxery: token ${entry.label}: ${describeScope(scope, "the server's --host")}; expires ${when(entry.expires)}.\n` +
				"boxery: shown once. Give it to the MCP client as: Authorization: Bearer <token>\n");
			return;
		}
		case "ls": {
			const json = rest[0] === "--json";
			if (rest.length > (json ? 1 : 0)) usage("mcp-token");
			const entries = readStore().map(({ hash: _h, ...e }) => e);
			if (json) return say(JSON.stringify(entries, null, 2));
			if (!entries.length) return say("no MCP tokens (create one: boxery mcp-token new LABEL)");
			for (const e of entries) {
				say(`${e.label}\texpires ${when(e.expires)}${e.expires != null && e.expires <= Date.now() / 1000 ? " (expired)" : ""}`);
				say(`  ${describeScope(e.scope, "the server's --host")}`);
				for (const o of e.owned) say(`  created ${o.host}/${o.vm}${o.key ? "" : " (identified by name only: its backend manages host keys)"}`);
			}
			return;
		}
		case "rm": {
			if (rest.length !== 1) usage("mcp-token");
			if (!removeToken(rest[0])) die(`no MCP token labelled ${rest[0]}`);
			say(`removed MCP token ${rest[0]}; a server using it refuses it from the next request`);
			return;
		}
		default:
			usage("mcp-token");
	}
}
