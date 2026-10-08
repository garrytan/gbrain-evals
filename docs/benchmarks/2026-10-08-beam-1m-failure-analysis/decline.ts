/**
 * The deterministic decline detector of the B2 committed-wrong tag: an answer whose last 700 characters say the history
 * does not hold the information, or that the quantity cannot be determined. Scored against the hand labels in
 * committed-wrong-labels.json (decompose.ts reports the agreement).
 */
export const DECLINE = /does not (?:provide|contain|include|mention)[^.]*information|no (?:information|record|mention|data) (?:about|of|on|in)|not possible to (?:calculate|determine)|impossible to (?:calculate|determine)|cannot (?:be )?(?:calculate|determine|definitively)|we cannot|can(?:not|'t) calculate/i;
