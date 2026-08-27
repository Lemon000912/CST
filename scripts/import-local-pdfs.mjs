// Backward-compatible entry point. The new importer has no file-size or
// per-category count limit and stores server-relative paths instead of blobs.
await import("./sync-server-pdfs.mjs");
