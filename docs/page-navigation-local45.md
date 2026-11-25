# Position-first navigation — local.45

The toolbar now shows physical PDF position, e.g. `1 / 15`. The first page is 1 regardless of a PDF's printed labels. While native position information is unavailable, the control is disabled and displays dashes rather than page 0.

The popup accepts only integer PDF positions from 1 through the current page count. Submission uses the live viewer's direct page navigation, bypassing printed-label resolution. Printed labels remain secondary metadata. Existing event subscriptions, keyboard scopes, draft cancellation and native-node restoration are retained.

Production build/TypeScript, whitespace checks and independent code review passed. All 39 targeted page-navigation and PDF-adapter tests passed, including first physical page with printed label 0, invalid destinations, loading state, cancellation and pane reuse. Live Mac/iPad appearance remains unverified.
