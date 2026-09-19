/**
 * In route mode a `new` turn waits for the backend decision at most this long beyond REFLEX_JEV_DEADLINE_MS before the
 * request goes out unchanged (`decision_late`). Shared by the router and `reflex report`, which checks recorded waits against it.
 */
export const DECISION_GRACE_MS = 250;
