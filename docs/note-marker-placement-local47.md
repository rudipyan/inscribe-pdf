# Passage-adjacent comment icons — local.47

Default comment icons sit just outside the associated highlight, with a 4px gap after their 44px touch target. When there is insufficient space on the right, they move to the passage's left. Existing manually dragged positions remain authoritative and are not rewritten.

Native section inline coordinates and existing annotation-layer viewport dimensions provide positioning without DOM geometry measurements, PDF reads, parsing, scrolling listeners or new startup work. Quarter-turn viewport dimensions are unswapped to match the native annotation-layer axes, including scale/user units. Vertical touch-target spacing applies only to overlapping horizontal lanes, keeping different article columns independent. Marker signatures include the default horizontal position so zoom updates reuse buttons correctly.

Production build/TypeScript, whitespace checks and independent source review passed. All 39 targeted placement, marker-action and PDF-adapter tests passed, including four page rotations, left-side fallback, independent columns, collision spacing, saved positions and DOM reuse on zoom.

The additional legacy `note-markers.test.ts` suite has eight failures because its simulated CSS style object lacks `removeProperty`, used by the existing color styling. No whole-suite pass or live Mac/iPad layout verification is claimed. Settings, PDFs, marker positions and timer state are preserved during installation.
