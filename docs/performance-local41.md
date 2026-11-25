# Preview reuse and document retirement — local.41

Implements the remaining Astra performance findings, #2 and #4.

- Reuses a finished preview overlay for the final page canvas only after adopting its exact document and output bytes. Page identity, viewport, rotation, dimensions, canvas/parent presentation and annotation canvas maps must match. Incomplete or stale previews and separate form canvases use the existing render fallback. Annotation layers and saved-byte verification remain unchanged.
- Coalesces native render/layer/thumbnail completion events and tracked-work completion into one deferred lease check. No selection/scroll polling, periodic cleanup, worker cap or forced eviction.
- Protects active refreshes, the current document/task, native link/find/thumbnail document references, page/layer/editor/detail/thumbnail proxies, and pending page/document requests. Direct text streams whose completion cannot be proved retain their workers until normal reload/close. The displaced native task remains exempt from early retirement.
- Removes retirement listeners and pending callbacks on reload, close and disposal. Installed settings, note positions and timer state are preserved.

## Verification

Production build including TypeScript and whitespace checks passed. All 54 focused preview, canvas, lease, lifecycle and adapter tests passed, including fallback for form canvases and releasing a worker after its final layer disappears without another save. Independent code and Astra ownership reviews performed before installation.

No measured device speedup or live Mac/iPad verification is claimed. Memory reduction depends on which native consumers release their references; uncertain stream ownership intentionally prevents early retirement.
