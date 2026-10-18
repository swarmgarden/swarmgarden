// Swarm Garden — the render claim library (added Oct 18 2026,
// lens spec B-d; Caitria's ruling: BUILD as a documented render
// signal). The mechanics live in shared/render.mjs; this file is
// the Garden's configuration of them — its own rate-digest salt
// and its own steward-state table (garden_state, where the
// intake/signal/human pause flags already live).
//
// On the Garden the gate stands SHUT: RENDER_OPEN is deliberately
// absent from this Worker's vars (see wrangler.toml), because no
// Garden page carries the script — the Garden's pages stay
// script-free under the human-button ruling's binding constraint.
// The endpoint exists here so the record's shape is one shape on
// both sites; the Advisory's claims are the instrument's, kept
// there. This site's table stands in its own D1, unmerged.
import { makeRender } from '../../../shared/render.mjs';

export const { renderGate, setRenderPaused, renderRateOK, renderDayCount, recordRender } =
  makeRender({ salt: 'garden-render-rate:', stateTable: 'garden_state' });
