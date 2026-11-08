// boxery-host's help: one entry per command, rendered by help/index.mjs (boxery-host help, COMMAND --help,
// usage errors, docs/cli.md's host reference). Its handlers are in host/cli.mjs, which checks that both
// tables name the same commands; test/help-drift.test.mjs checks each entry's flags against its code.
//
// Controllers read `boxery-host help` to learn what an older host can do (core/profile.mjs hostSupports,
// core/registry.mjs): keep these list lines as they are, or controllers think the host predates them:
//   "  known-hosts NAME"   "  renew LEASE [--ttl S] [--json]"   "capabilities"
// (a usage line's list column keeps its flags when `list` says so).
import * as help from "../help/index.mjs";
/** @typedef {import("../help/index.mjs").Help} Help */
/** @typedef {{ help: Help } | { alias: string }} Entry */

const JSON_FLAG = /** @type {[string, string]} */ (["--json", "Print JSON (fields: docs/cli.md#json-output)"]);
const SIZE_FLAGS = /** @type {[string, string][]} */ ([["--shape S", "A size from shapes"], ["--cpus N", "CPUs"], ["--mem MiB", "Memory, in MiB"], ["--disk GiB", "Disk, in GiB"]]);

/** @type {Record<string, Entry>} */
export const HOST_COMMANDS = {
	// ------------------------------------------------ setup
	init: {
		help: {
			group: "setup", summary: "install the proxy and reaper services, backend setup and symlinks", usage: ["init [--backend libvirt|lima|cloud-hypervisor|exe|boat|openshell]"],
			details: ["Safe to repeat. --profile NAME init --backend B creates a second profile on this host, with a free proxy port and its own services."],
			flags: [["--backend B", "The VM backend (default: the profile's, else libvirt)"]], docs: "install.md",
		},
	},
	profiles: { help: { group: "setup", summary: "the profiles on this host (backend, proxy port, service, state dir)", usage: ["profiles [--json]"], flags: [JSON_FLAG], docs: "hosts.md" } },
	version: { help: { group: "setup", summary: "this install's version, commit and kind (git or npm)", usage: ["version [--json]"], flags: [JSON_FLAG] } },
	upgrade: {
		help: {
			group: "setup", summary: "update this install, re-run init for its profiles, check them", usage: ["upgrade [--check] [--ref REF] [--wait S] [--reinit]"],
			details: ["git pull --ff-only, or npm. Waits for in-flight operations, and rolls back (code and each profile's state, from $BOXERY_CONF/pre-upgrade/) when a check fails."],
			flags: [["--check", "Only report the install, its target version and profiles"], ["--ref REF", "Upgrade to this git ref or npm version"], ["--wait S", "Wait up to S seconds for in-flight operations (default 600)"], ["--reinit", "Re-run init for every profile even when up to date"]],
			docs: "install.md#upgrading",
		},
	},
	"build-base": { help: { group: "setup", summary: "build the golden desktop image (one time; not for headless VMs)", usage: ["build-base"] } },
	"add-key": { help: { group: "setup", summary: "authorize a controller's ssh key for new VMs", usage: ["add-key < key.pub"] } },
	backends: { help: { group: "setup", summary: "backend support, requirements and capability declarations", usage: ["backends [--json]"], flags: [JSON_FLAG], docs: "backends.md" } },
	capabilities: {
		help: { group: "setup", summary: "this host's platform, validation and conditional capabilities", usage: ["capabilities [--json | --check]"], flags: [JSON_FLAG, ["--check", "Run the backend preflight; fails when a requirement is missing"]], docs: "backends.md" },
	},
	backend: { help: { group: "setup", summary: "this profile's VM backend", usage: ["backend"] } },

	// ------------------------------------------------ VMs
	new: {
		help: {
			group: "vms", summary: "create a VM; prints NAME HOST:PORT", usage: ["new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless [--layers L,…]]"],
			flags: [...SIZE_FLAGS, ["--distro ubuntu|arch", "Guest distribution (Arch: experimental Lima x86_64 headless only)"], ["--from IMAGE", "Boot from an image (e.g. demo@s1; keeps its desktop or not)"], ["--headless", "No desktop; boots the stock image, no build-base needed"], ["--layers L,…", "Optional image layers for a headless VM (github-runner)"]],
			docs: "cli.md#lifecycle",
		},
	},
	fork: {
		help: {
			group: "vms", summary: "copy a VM (running or not) into new VMs with their own identity", usage: ["fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]"],
			details: ["Each fork has SRC's size unless --shape or size flags are given."], flags: SIZE_FLAGS, docs: "cli.md#snapshots-and-forks",
		},
	},
	ls: {
		help: { group: "vms", summary: "VMs; --refresh first reads running VMs' guest build records", list: "ls [--json] [--refresh]", usage: ["ls [--json] [--refresh]"], flags: [JSON_FLAG, ["--refresh", "Read each running VM's guest build record first (GUEST column)"]] },
	},
	list: { alias: "ls" },
	shapes: { help: { group: "vms", summary: "VM sizes (built-ins + shapes.json in the profile; * = default)", usage: ["shapes [--json]"], flags: [JSON_FLAG], docs: "shapes.md" } },
	ip: { help: { group: "vms", summary: "a running VM's ssh address", usage: ["ip NAME"] } },
	start: { help: { group: "vms", summary: "start a VM", usage: ["start NAME"] } },
	stop: { help: { group: "vms", summary: "stop a VM", usage: ["stop NAME"] } },
	rm: { help: { group: "vms", summary: "destroy a VM, its snapshots and its proxy token", usage: ["rm NAME"] } },
	delete: { alias: "rm" },
	resize: {
		help: { group: "vms", summary: "change a VM's size; a running VM is restarted. Disk only grows", usage: ["resize NAME [--cpus N] [--mem MiB] [--disk GiB]"], flags: SIZE_FLAGS.slice(1), docs: "cli.md#lifecycle" },
	},
	patch: {
		help: {
			group: "vms", summary: "update a VM's guest software to this host's image layers", usage: ["patch NAME|--all [--wait S]"],
			details: ["Restarts it if the updates ask to. A pool VM must be free, and its clean image is captured again."],
			flags: [["--all", "Every running VM, in turn"], ["--wait S", "Wait up to S seconds for a pool VM's lease to end"]], docs: "cli.md#lifecycle",
		},
	},
	pin: {
		help: { group: "vms", summary: "re-pin running NAME's ssh host key; prints its fingerprint", usage: ["pin NAME [--from-guest]"], flags: [["--from-guest", "Trust what NAME's ssh endpoint answers, once"]], docs: "security.md#vm-host-keys" },
	},

	// ------------------------------------------------ snapshots
	snap: { help: { group: "snapshots", summary: "snapshot a VM's disk", usage: ["snap NAME [SNAP]"], docs: "cli.md#snapshots-and-forks" } },
	snaps: { help: { group: "snapshots", summary: "a VM's snapshots, with their age and guest software", usage: ["snaps NAME [--json]"], flags: [JSON_FLAG] } },
	"snap-rm": { help: { group: "snapshots", summary: "delete a snapshot", usage: ["snap-rm NAME SNAP"] } },
	revert: { help: { group: "snapshots", summary: "restore a VM to a snapshot", usage: ["revert NAME SNAP"] } },
	images: { help: { group: "snapshots", summary: "every image on this host (new --from takes one)", usage: ["images [--json]"], flags: [JSON_FLAG] } },

	// ------------------------------------------------ connections
	connect: { help: { group: "connect", summary: "stdio to VM port (for ssh ProxyCommand)", usage: ["connect NAME [PORT]"] } },
	"known-hosts": { help: { group: "connect", summary: "NAME's pinned ssh host key, a known_hosts line (KnownHostsCommand)", usage: ["known-hosts NAME"] } },
	"edge-set": {
		help: {
			group: "connect", summary: "set a VM's edge credential routes (boxery grant http:… uses it)", usage: ["edge-set NAME [--lease ID] < routes.json"],
			flags: [["--lease ID", "Refuse unless the VM's current lease is ID"]], docs: "grants.md",
		},
	},
	"proxy-log": { help: { group: "connect", summary: "recent LLM + edge proxy requests", usage: ["proxy-log [N]"] } },

	// ------------------------------------------------ pool
	pool: { help: { group: "pool", summary: "the shared pool of leasable VMs", list: "pool add|rm|ls", usage: ["pool add NAME", "pool rm NAME [--force]", "pool ls [--json]"], flags: [["--force", "rm: also when the VM is leased"], JSON_FLAG], docs: "pool.md" } },
	acquire: {
		help: {
			group: "pool", summary: "lease a free pool VM (lease ssh pubkey on stdin)", usage: ["acquire --holder H [--ttl S] [--wait S] [--only NAME,…] [--json]"],
			details: ["Prints NAME LEASE_ID EXPIRES, or with --json {\"name\",\"lease_id\",\"expires_at\"}."],
			flags: [["--holder H", "Who holds the lease"], ["--ttl S", "Lease length in seconds (default 1800)"], ["--wait S", "Wait up to S seconds for a free VM"], ["--only NAME,…", "Lease one of these VMs"], JSON_FLAG],
			docs: "pool.md",
		},
	},
	// (controllers look for this exact line: core/profile.mjs hostLeaseJson)
	renew: { help: { group: "pool", summary: "extend a lease", list: "renew LEASE [--ttl S] [--json]", usage: ["renew LEASE [--ttl S] [--json]"], flags: [["--ttl S", "New lease length in seconds"], JSON_FLAG], docs: "pool.md" } },
	release: { help: { group: "pool", summary: "end a lease (the VM is reset to its clean image)", usage: ["release LEASE"], docs: "pool.md" } },
	reap: { help: { group: "pool", summary: "release expired leases, recover abandoned operations", usage: ["reap"], docs: "lifecycle.md" } },
	reconcile: { help: { group: "pool", summary: "recover abandoned operations and check inventory drift", usage: ["reconcile"], docs: "lifecycle.md" } },
	runners: {
		help: {
			group: "pool", summary: "GitHub Actions runners, one job per freshly reset pool VM", list: "runners status|config|start|stop|token",
			usage: ["runners status [--json] | start | stop | token < FILE | run", "runners config [--repo OWNER/REPO | --org ORG] [--vms NAME,…] [--count N] [--labels L,…] [--group ID] [--ttl S] [--api URL] [--prefix P]"],
			details: ["config with no flags prints the configuration. token stores the first line of stdin in runners.env (0600). run is the runner manager in the foreground (what the service runs)."],
			docs: "github-runners.md",
		},
	},
	help: { help: { group: "setup", summary: "show help for boxery-host or a command", usage: ["help [COMMAND]"] } },
};

/** @type {import("../help/index.mjs").Cli} */
export const HOST_CLI = {
	program: "boxery-host",
	errorProgram: "", // (boxery-host: usage: snaps NAME [--json]: errors already start with the program's name)
	groups: { setup: "Setup", vms: "VMs", snapshots: "Snapshots & images", connect: "Connections & proxy", pool: "Shared pool & runners" },
	title: "boxery-host — Ubuntu desktop VMs for coding agents",
	usage: "[--profile NAME] COMMAND [ARGS...]",
	options: [
		["--profile NAME", "Use profile NAME (~/.config/boxery-NAME): its own backend, state,"],
		["", "proxy port and services. Create it: --profile NAME init --backend B"],
		["-h, --help", "Show help; boxery-host COMMAND --help shows a command's"],
	],
	footer: `Docs: ${help.DOCS}cli.md#boxery-host-the-vm-host`,
};

/** `boxery-host help`: the backend and the profile's directory on top. @param {{ backend: string, conf: string }} rt */
export const hostHelp = (rt) => help.renderTop({ ...HOST_CLI, title: `${HOST_CLI.title} (backend: ${rt.backend})`, footer: `${HOST_CLI.footer}\nProfile: ${rt.conf}` }, HOST_COMMANDS);
/** @param {string} name */
export const hostCommandHelp = (name) => {
	const e = HOST_COMMANDS[name];
	return "help" in e ? help.renderCommand(HOST_CLI, name, e.help) : "";
};
/** A usage error's message. @param {string} name @param {{ sub?: string, hint?: string }} [opts] */
export const hostUsage = (name, opts) => help.usageText(HOST_CLI, HOST_COMMANDS, name, opts);
/** @param {string} name */
export const hostResolve = (name) => help.resolve(HOST_COMMANDS, name);
/** @param {string} word */
export const hostUnknown = (word) => help.unknownCommand(HOST_CLI, HOST_COMMANDS, word);
/** The host reference in docs/cli.md. */
export const hostMarkdown = () => help.renderMarkdown(HOST_CLI, HOST_COMMANDS, "cli.md");
