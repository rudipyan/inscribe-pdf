# Toolbar study timer — local.36

## Implemented

- Shared timer across PDF panes, with a pinned top-bar countdown in normal/full-screen reading.
- Study presets: 25/30/45 minutes; custom integer 1–180. Break presets: 5/7/10 minutes; custom integer 1–60. Default25/5, initially paused.
- Automatic study→break→study cycles; round count; Start/Pause, Reset, Skip break.
- Soft locally generated660/880Hz sine chime, mute, volume, manual preview. Audio context is created/resumed from user interactions; preview waits for actual resume. No audio downloads or silent background playback.
- One1Hz clock only while running, updating timer subscribers without calling PDF/annotation logic. No per-tick writes.
- Absolute deadlines catch up after suspension. Whole missed cycles are skipped arithmetically, with at most one completion notification/chime when resuming.
- Duration/preferences/progress saved to plugin pomodoro.json on actions/transitions. Running deadlines survive plugin reload. Loader validates known fields; unreadable existing data is preserved rather than overwritten.
- Popup focus enters Play, arrow-key editing stays within controls, and outside clicks do not steal focus back. Closing/unloading releases subscribers, listeners, keymap scope, timer interval, and audio context.

## Verification2026-10-24

- TypeScript/production build passed.
- git diff --check passed.
- Independent static review approved after correcting paused-progress reset when editing the other phase, keyboard focus, and audio preview resume handling.
- Installed artifacts match source byte-for-byte; local.35→local.36. Existing data.json, marker position sidecar, and any existing pomodoro.json preserved.
- No automated tests added/run; no lint pass claimed.
- Native UI unavailable: actual Mac/iPad layout, chime audibility, and background behavior are not runtime verified. Reload Rudi's Study PDF, click the timer, then use Start/Preview.

## Platform limits

Background/locked-screen audio and exact wake-up timing cannot be guaranteed on iOS. The displayed clock catches up by deadline when execution resumes; old alarms are not replayed. Audio may need a fresh interaction after app/plugin reload. Separate running Obsidian instances/devices do not arbitrate chime ownership or merge concurrent timer state edits.
