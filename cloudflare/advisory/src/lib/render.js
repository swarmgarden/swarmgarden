// Bay Area Swarm Warning — the render claim library (added
// Oct 18 2026, lens spec B-d; Caitria's ruling: BUILD as a
// documented render signal). The mechanics live in
// shared/render.mjs; this file is the Advisory's configuration of
// them — its own rate-digest salt and its own steward-state table
// (site_state, where this site's human pause flag already lives).
// This site's claims are its own, in its own D1; the Garden runs
// the same shape with its own salt, and the two never merge.
import { makeRender } from '../../../shared/render.mjs';

export const { renderGate, setRenderPaused, renderRateOK, renderDayCount, recordRender } =
  makeRender({ salt: 'advisory-render-rate:', stateTable: 'site_state' });
