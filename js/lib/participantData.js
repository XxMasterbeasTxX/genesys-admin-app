/**
 * Participant data — matching a conversation's attributes against filters.
 *
 * Shared by Interactions › Search and Interactions › Search Recent. It lives
 * here rather than in either page because a copy per page is how the
 * same-participant bug in `filterByPD` came to exist in one place and not the
 * other: there was only ever one implementation for anyone to inspect.
 *
 * Nothing here touches the DOM or the API. Both pages obtain conversations
 * differently — Historical from an async analytics job, which carries
 * attributes; Recent from `getConversation` per row, because the synchronous
 * query does not — and then apply the same rules to what they have.
 */

/**
 * One participant's value for an attribute, matched case-insensitively, as a
 * string. `null` when the participant does not carry the attribute at all.
 *
 * The lookup was written out four times and three of those went straight on to
 * call `.toLowerCase()` or `.split(",")` on the raw value. The spec types
 * attributes as `additionalProperties: {type: string}`, so a `null` should not
 * arrive — but if one ever did it would throw, and in `filterByPD` it would
 * throw for the whole result set rather than one row, turning a search into an
 * error. Coercing once here costs nothing and removes that whole class.
 *
 * A present-but-null attribute reads as an empty string: the key still counts
 * as present, which is what a key-only filter asks about.
 *
 * @param {Object} attrs     A participant's `attributes` map.
 * @param {string} keyLower  The wanted key, already lowercased.
 * @returns {string|null}
 */
export function attrValue(attrs, keyLower) {
  const key = Object.keys(attrs || {}).find((k) => k.toLowerCase() === keyLower);
  return key == null ? null : String(attrs[key] ?? "");
}

/**
 * Client-side participant-data filter.
 *
 * A conversation matches when **every filter is satisfied by some participant**
 * — not necessarily the same one. Keys and values are matched
 * case-insensitively; a filter with no value asks only that the key is present.
 * With `exclude`, the conversations that do *not* match are returned.
 *
 * This used to require one participant to satisfy *all* the filters, which made
 * a second filter silently unfindable whenever Genesys had set the two
 * attributes on different legs — a real and recurring "I know this interaction
 * has both" failure. The row would even show both attributes, because the
 * expanded view merges them across participants: the page displayed a merged
 * view and filtered against an unmerged one.
 *
 * What that strictness bought was a guard on transferred and conferenced
 * interactions, where two external participants may be different people, so
 * `CPR` from one would no longer combine with `UD_Language` from another.
 * Deliberately given up: not finding an interaction that exists is the worse
 * failure, and it is the one that happens in practice.
 */
export function filterByPD(conversations, filters, exclude = false) {
  if (!filters.length) return conversations;
  return conversations.filter((conv) => {
    const participants = conv.participants || [];
    const matches = filters.every((f) => {
      const fKeyLower = f.key.toLowerCase();
      return participants.some((p) => {
        const v = attrValue(p.attributes, fKeyLower);
        if (v == null) return false;      // attribute not on this participant
        if (f.value === "") return true;  // key-only filter: presence is enough
        return v.toLowerCase() === f.value.toLowerCase();
      });
    });
    return exclude ? !matches : matches;
  });
}
