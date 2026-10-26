# ANT / VER Q3 track dominance — 26 October 2026

OpenF1 adapter v1 marked ANT lap 14 unreliable because its position coverage
was 97.8%, although timing coverage was 98.4% and lap validity was verified.
The dashboard now rechecks timing and validity for this specific legacy case,
preserves missing timing samples, and uses the most complete selected circuit
outline (VER lap 8 here). New worker output keeps position coverage separate
from timing reliability.

The saved production artifact produces 50 sections, of which 48 have timing for
both drivers and two remain unavailable. No timing thresholds were lowered.

Validation: 36 TypeScript tests, 45 Python tests, type checking, and a local
webpack production build passed. Local Turbopack failed to start a CSS subprocess;
the normal production build succeeded on Vercel.

Production deployments are READY:

- Dashboard: `dpl_Fz9yPcC4x7jDhzLAFg682VPTV5pr`.
- Worker: `dpl_9ikjQGVZKE7aiPGPjzTzVySmtN3F`.

The original shared URL was verified in the live browser with Q3 and ANT/VER
selected. The circuit map reports ANT 32%, VER 34%, and tied/unavailable 34%;
the cumulative delta also renders. Existing session artifacts were not replaced.
