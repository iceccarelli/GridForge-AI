// What one subscriber may keep in saved scenarios (app/api/scenarios), and how large a save request may be.
//
// The row cap is enforced by the route before it writes (a count, then an insert): a subscriber who sends two saves at the same instant
// from 99 rows can end at 101. It bounds what one account can store; it is not a transactional guarantee, and it does not need to be one.

/** Saved scenarios per subscriber. A scenario is one hall's siting comparison; a hundred is far beyond a person's working set. */
export const MAX_SCENARIOS_PER_SUBSCRIBER = 100;

/**
 * A save is a name, a region id and four numbers. The route TRUNCATES an over-long name to 80 characters rather than refusing it (a display
 * string; tests/site/scenarios.test.ts), so the body cap is far above a real save and only stops a body that is not one.
 */
export const MAX_SCENARIO_BODY_BYTES = 16 * 1024;
