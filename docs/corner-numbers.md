# Circuit corner numbers

New analysis artifacts include optional FastF1 `corners` metadata: `number`, `letter`, `x`, `y`, and `angle`. Both telemetry and markers use the same coordinate transform, preserving the existing circuit orientation. Dark circular badges show the turn number, including letter suffixes. Badges stay inside the SVG and move apart when nearby labels overlap; connector lines identify the corresponding track position. The overlay does not intercept section hover or keyboard focus.

Older artifacts and unavailable source metadata display the map without badges. Source failures are logged and do not fail session analysis. Deploy the dashboard and Python worker before refreshing existing published sessions through the established bounded queue. Validate Australia qualifying (`2026-01-Q`, 14 corners) and Azerbaijan practice (`2026-15-FP2`, 20 corners) first, then refresh published sessions in batches of at most three, checking completion and storage headroom between batches. Preserve admission, concurrency, retry, and storage limits.

Validation includes metadata serialization, lettered corners, missing and invalid metadata, crowded placement, bounds, frontend tests and type checks. Local real-data generation and layout checks cover Australia and Azerbaijan at desktop and narrow widths.
