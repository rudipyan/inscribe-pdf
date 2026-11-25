# Compact study timer — local.37

- Popup width reduced from280to220px; countdown shares the playback row, duration fields sit side by side, and controls use compact icon buttons (44px touch targets retained).
- Preset buttons and explanatory hint paragraph removed. Editable Study/Break minute fields remain.
- Repeat is optional and off by default, including migration of earlier states that lack the preference. Off runs Study then Break, then pauses ready for the next study. On cycles continuously. Setting is persisted with existing timer state.
- The previous two-note sound is replaced with one soft gong-like strike: six inharmonic modes around196Hz, slight pitch settling, and staggered decays up to3.8seconds. Volume, mute, and explicit preview remain available; no audio files/network work.
- Preserved existing deadline timing, bounded catch-up, per-action storage and idle timer cleanup. Fixed Pause at an expired non-repeating boundary inadvertently starting another round, and Skip failing to emit after completion.

## Checks2026-10-24

- TypeScript/production build and git diff --check passed.
- Independent static review approved after the two boundary fixes.
- Installed main.js/styles.css/manifest.json match source; local.36→local.37. data.json and existing marker/timer sidecars preserved byte-for-byte.
- No automated tests added/run and no lint pass claimed.
- Native UI/audio tools unavailable: actual layout and gong sound remain unverified on Mac/iPad. Reload Rudi's Study PDF and use the bell icon to preview.
