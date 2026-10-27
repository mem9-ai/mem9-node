# re2-wasm 1.0.2

The pinned dependency uses an old Emscripten `FinalizationGroup` hook that is
unavailable in Node 22. Removing an entry from the JavaScript regex cache does
not release its native WASM allocation. Cycling 513 patterns through a 512-entry
cache exhausted the fixed 16 MiB heap after 7,569 compilations in a local probe.

The patch adds an idempotent `RE2.dispose()` method, releases the temporary
capture-name map and key vector during construction, and disposes the wrapper
when construction fails. The analysis cache calls `dispose()` on eviction.
Source, runtime JavaScript, declarations, and source map are kept in sync.

The pipeline regression cycles 20,000 entries through the cache. Separate
dependency probes verified named captures, repeated disposal, invalid-pattern
cleanup, and repeated matching on one instance. Recheck those behaviors before
upgrading the package or removing this patch. Both Dockerfiles copy this
directory before the frozen dependency install.
