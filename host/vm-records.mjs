// What each VM is: one row per VM in the host's store (vm_records in leases.db, boxery-leases.mjs),
// written when the VM is made and deleted with it, each in one statement.
// - kind: "desktop" or "headless". Fixed for the VM's life. The guest has /etc/boxery/headless too.
// - os: the guest OS (guests/index.mjs). Fixed for the VM's life; checked on write.
// - size: {shape, cpus, mem, disk}, so forks and `ls` know it. shape null = custom (size flags, resize, or a backend that gave other CPUs or memory).
// - created_at, created_by: when it was made (unix seconds) and by whom (the controller's BOXERY_BY:
//   user@machine, "via CLIENT" for an agent). null for VMs made before they were recorded.
// When a VM was last connected to isn't a row: `connect` (host/backend.sh, no Node) writes $CONF/last-connected/NAME
// on every new ssh connection, and lastConnected reads that file's mtime.
// A VM made from an image or a fork gets its source VM's kind and OS (an image VM@LABEL is a disk of VM).
// No row (made outside boxery, or before any record): desktop, linux, no size (ls reads that from the
// backend once and records it). Writers hold the VM's lifecycle lock, except ls's addVmSize.
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_OS, guestOs } from "../guests/index.mjs";
/** @import { DatabaseSync } from "node:sqlite" */
/** @import { ShapeInput, ShapeRecord } from "./shapes.mjs" */

/** @typedef {"desktop" | "headless"} VmKind */
/** @typedef {{ kind: VmKind, os: string, size: ShapeRecord | null, created_at: number | null, created_by: string | null }} VmRecord */
/** @typedef {{ name: string, kind: VmKind, os: string, shape: string | null, cpus: number | null, mem: number | null, disk: number | null, created_at: number | null, created_by: string | null }} Row */

/** @param {Row} r @returns {VmRecord} */
const toRecord = (r) => ({ kind: r.kind, os: r.os,
	size: r.cpus == null ? null : { shape: r.shape, cpus: r.cpus, mem: /** @type {number} */ (r.mem), disk: /** @type {number} */ (r.disk) },
	created_at: r.created_at ?? null, created_by: r.created_by ?? null });
/** shape, cpus, mem, disk as stored @param {ShapeInput | null} s @returns {[string | null, number | null, number | null, number | null]} */
const sizeCols = (s) => (s ? [s.shape || null, Number(s.cpus), Number(s.mem), Number(s.disk)] : [null, null, null, null]);
// A size for a VM without a row comes with the defaults for the rest.
const UPSERT_SIZE = `INSERT INTO vm_records (name, kind, os, shape, cpus, mem, disk) VALUES (?, 'desktop', '${DEFAULT_OS}', ?, ?, ?, ?)
	ON CONFLICT (name) DO UPDATE SET shape = excluded.shape, cpus = excluded.cpus, mem = excluded.mem, disk = excluded.disk`;

/** NAME's record (the defaults without one). @param {DatabaseSync} db @param {string} name @returns {VmRecord} */
export function vmRecord(db, name) {
	const r = /** @type {Row | undefined} */ (db.prepare("SELECT * FROM vm_records WHERE name = ?").get(name));
	return r ? toRecord(r) : { kind: "desktop", os: DEFAULT_OS, size: null, created_at: null, created_by: null };
}
/** {NAME: record} for VMs with a row (ls). @param {DatabaseSync} db @returns {Record<string, VmRecord>} */
export function vmRecords(db) {
	return Object.fromEntries(/** @type {Row[]} */ (db.prepare("SELECT * FROM vm_records ORDER BY name").all()).map((r) => [r.name, toRecord(r)]));
}
/** The kind and OS a VM made from IMAGE (VM@LABEL, or a VM's name) inherits: VM's. Throws if this
 *  boxery doesn't know that OS. @param {DatabaseSync} db @param {string} image */
export function inheritedType(db, image) {
	const { kind, os } = vmRecord(db, image.split("@")[0]);
	guestOs(os);
	return { kind, os };
}
/** A new VM's record, replacing any (ls may have recorded a size while the VM was being made).
 *  size null: none (the backend manages it). created_at defaults to now. @param {DatabaseSync} db @param {string} name
 *  @param {{ kind: VmKind, os: string, size: ShapeInput | null, created_at?: number, created_by?: string | null }} record */
export function createVmRecord(db, name, { kind, os, size, created_at = Math.floor(Date.now() / 1000), created_by = null }) {
	guestOs(os);
	db.prepare("INSERT OR REPLACE INTO vm_records (name, kind, os, shape, cpus, mem, disk, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(name, kind, os, ...sizeCols(size), created_at, created_by);
}
/** Who is making a VM, from the controller's BOXERY_BY: no control characters, at most 100, or null.
 *  A label for people to read, not an identity: anyone who can run boxery-host can set it. @param {string | undefined} by */
export function creator(by) {
	const s = (by ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100);
	return s || null;
}
/** NAME's size changed (resize: shape null). @param {DatabaseSync} db @param {string} name @param {ShapeInput} size */
export function setVmSize(db, name, size) {
	db.prepare(UPSERT_SIZE).run(name, ...sizeCols(size));
}
/** Record NAME's size only if it has none yet, for callers that hold no VM lock (ls), so a concurrent
 *  new/resize always wins. false if it has one. @param {DatabaseSync} db @param {string} name @param {ShapeInput} size */
export function addVmSize(db, name, size) {
	return db.prepare(`${UPSERT_SIZE} WHERE vm_records.cpus IS NULL`).run(name, ...sizeCols(size)).changes === 1;
}
/** Drop NAME's record (rm, and recovery of a failed new). @param {DatabaseSync} db @param {string} name */
export function deleteVmRecord(db, name) {
	db.prepare("DELETE FROM vm_records WHERE name = ?").run(name);
}
/** NAME's last-connected file, which `connect` (host/backend.sh) rewrites on every new ssh connection. @param {string} conf @param {string} name */
const lastConnectedFile = (conf, name) => path.join(conf, "last-connected", name);
/** When NAME last got a new ssh connection (unix seconds), or null: never since this was recorded, or
 *  only before created_at (an earlier VM of the same name). @param {string} conf @param {string} name @param {number | null} [createdAt] */
export function lastConnected(conf, name, createdAt = null) {
	let t;
	try { t = Math.floor(statSync(lastConnectedFile(conf, name)).mtimeMs / 1000); } catch { return null; }
	return createdAt != null && t < createdAt ? null : t;
}
/** Forget when NAME was last connected to (rm). Best effort. @param {string} conf @param {string} name */
export function deleteLastConnected(conf, name) {
	rmSync(lastConnectedFile(conf, name), { force: true });
}
