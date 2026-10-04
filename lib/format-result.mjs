function formatCategory(label, paths) {
  const heading = `${label} (${paths.length}):`;
  return paths.length ? `${heading}\n${paths.map((entry) => `  - ${entry}`).join("\n")}` : `${heading}\n  (none)`;
}

export function formatDry(result) {
  const { pending } = result;
  return [
    "Dry run: no cache writes, no inference, no network calls.",
    `Folder: ${result.folder}`,
    `Store: ${result.database}`,
    `Eligible source files: ${result.eligible}`,
    `Indexed (cached rows): ${result.indexed}`,
    `Pending changes: ${pending.added.length} added, ${pending.changed.length} changed, ${pending.deleted.length} deleted, ${pending.unchanged.length} unchanged`,
    formatCategory("Added", pending.added),
    formatCategory("Changed", pending.changed),
    formatCategory("Deleted", pending.deleted),
    formatCategory("Unchanged", pending.unchanged),
  ].join("\n");
}

export function formatNormal(result) {
  const recommendations = result.files.map((file) =>
    `${file.path}\nWhy read: ${file.reason}\nContext: ${file.summary}`,
  ).join("\n\n");
  return [
    `Folder: ${result.folder}\nStore: ${result.database}\nMap: ${result.indexed} files; ${result.sync.updated} updated, ${result.sync.deleted} deleted, ${result.sync.unchanged} unchanged.`,
    result.answer,
    `Files to read (in order):\n${recommendations || "No files recommended."}`,
    `Limitations: ${result.limitations.join("; ") || "Summary-based discovery only; verify exact source with read."}`,
  ].join("\n\n");
}
