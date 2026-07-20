/*
 * Sim-cuit — js/sim/shortcircuit.js
 * ---------------------------------------------------------------------------
 * Pure, DOM/engine-free short-circuit advisory logic used by js/main.js's sim
 * loop. Deliberately kept out of js/engine/* (which is read-only for this
 * feature) and out of js/main.js itself so the "fire once per episode,
 * re-arm on drop" state machine can be unit tested in isolation (see
 * test/shortcircuit.test.mjs).
 *
 * A component is "in episode" while its |current| stays above threshold
 * without dropping back down or failing — advisory fires on the *rising*
 * edge into that state only, per component id, via the caller-owned
 * `episodes` Map<compId, boolean> (true = currently armed/warned).
 *
 * PUBLIC API:
 *   thresholdAmps(comp)                 -> number  // 20x rated maxCurrent,
 *                                                      or a flat 5A fallback
 *                                                      if no rating exists
 *   checkShortCircuit(comp, episodes)   -> { id, current, threshold } | null
 * ---------------------------------------------------------------------------
 */

export const RATING_MULTIPLE = 20;
export const FALLBACK_THRESHOLD_A = 5;

export function thresholdAmps(comp) {
  const ratings = comp && comp.ratings;
  const rated = ratings && (ratings.maxCurrent ?? ratings.current ?? ratings.ratedCurrent);
  if (typeof rated === 'number' && rated > 0) return rated * RATING_MULTIPLE;
  return FALLBACK_THRESHOLD_A;
}

// Mutates `episodes` in place. Returns an advisory payload only on the
// rising edge (first frame a battery crosses threshold while not failed);
// returns null on every other frame, including all frames while still over
// threshold (already warned) and all frames back under threshold (re-armed
// for next time).
export function checkShortCircuit(comp, episodes) {
  const id = comp.id;
  const current = Math.abs((comp.state && comp.state.i) || 0);
  const failed = !!(comp.state && comp.state.failed);
  const threshold = thresholdAmps(comp);

  if (failed) {
    episodes.set(id, false);
    return null;
  }

  const armed = episodes.get(id) || false;
  if (current > threshold) {
    if (armed) return null;
    episodes.set(id, true);
    return { id, current, threshold };
  }

  episodes.set(id, false);
  return null;
}
