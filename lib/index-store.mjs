import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Callers must supply a canonical folder; identical realpaths share one index.
export function indexLocation(folder, storeDir = process.env.PI_QUERY_STORE_DIR || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"), "query-engine")) {
  const directory = path.resolve(storeDir);
  const key = createHash("sha256").update(folder).digest("hex");
  return { directory, database: path.join(directory, `${key}.db`) };
}

async function safeDirectory(directory, create) {
  // Validate existing ancestors before mkdir: never create missing children
  // through a symlinked parent. This is a private per-user cache, not a sandbox
  // against another process with the same OS account swapping paths mid-call.
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      if (!(await fs.lstat(current)).isDirectory()) {
        throw new Error(`Index store ancestor must be a directory, not a symlink: ${current}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || await fs.realpath(directory) !== directory) {
      throw new Error(`Index store must be a real directory, not a symlink: ${directory}`);
    }
    if (create) await fs.chmod(directory, 0o700);
    return true;
  } catch (error) {
    if (!create && error.code === "ENOENT") return false;
    throw error;
  }
}

async function safeDatabase(database) {
  // SQLite may use these sidecars. Refuse links even if the DB is absent.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      const stat = await fs.lstat(database + suffix);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Unsafe index database or sidecar (symlink/hardlink): ${database + suffix}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function verifyFolder(db, folder) {
  const identity = db.prepare("SELECT folder FROM project WHERE id = 1").get();
  if (identity?.folder !== folder) throw new Error("Index folder identity mismatch; refusing another folder's summaries.");
}

export function readRows(db) {
  return new Map(db.prepare("SELECT * FROM files ORDER BY path COLLATE BINARY").all().map((row) => [row.path, row]));
}

// Read-only rollback-journal databases do not create WAL/SHM sidecars. Missing
// stores stay missing; dry runs never create directories, schema or journals.
export async function readIndex(folder, location) {
  if (!await safeDirectory(location.directory, false)) return new Map();
  await safeDatabase(location.database);
  let handle;
  try {
    handle = await fs.open(location.database, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  try {
    // WAL-mode read-only opens can still create -wal/-shm files. Check SQLite's
    // persistent format bytes before constructing a connection, not afterward.
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead === header.length && (header[18] === 2 || header[19] === 2)) {
      throw new Error("Dry run requires a rollback-journal index; refusing WAL sidecar writes.");
    }
  } finally {
    await handle.close();
  }
  const db = new DatabaseSync(location.database, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal") {
      throw new Error("Dry run requires a rollback-journal index; refusing WAL sidecar writes.");
    }
    verifyFolder(db, folder);
    return readRows(db);
  } finally {
    db.close();
  }
}

export async function openIndex(folder, location) {
  await safeDirectory(location.directory, true);
  await safeDatabase(location.database);
  const handle = await fs.open(location.database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if ((await handle.stat()).nlink !== 1) throw new Error("Hardlinked index database refused.");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  const db = new DatabaseSync(location.database);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY CHECK(id = 1), folder TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY NOT NULL,
        summary TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        index_time TEXT NOT NULL
      );`);
    db.prepare("INSERT OR IGNORE INTO project(id, folder) VALUES (1, ?)").run(folder);
    verifyFolder(db, folder);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function pendingFiles(files, old) {
  const pending = { added: [], changed: [], deleted: [], unchanged: [] };
  for (const [name, file] of files) {
    if (!old.has(name)) pending.added.push(name);
    else if (old.get(name).content_hash !== file.content_hash) pending.changed.push(name);
    else pending.unchanged.push(name);
  }
  for (const name of old.keys()) if (!files.has(name)) pending.deleted.push(name);
  return pending;
}
