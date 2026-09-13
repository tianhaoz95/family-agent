import { tool } from "@langchain/core/tools";
import { z } from "zod";

// The device location of whoever is actually talking to the assistant right
// now — the phone's GPS if they're on iOS/Android, the laptop's OS location
// service if they're on desktop. Never the same "family home" address for
// everyone: each client reports its OWN location on its OWN turn, so two
// people in different places asking "parks near me" in the same household
// get different answers. See docs/DECISIONS.md → "Caller geolocation".
//
// This is deliberately NOT stored anywhere (not in chat_messages, not in the
// activity log with coordinates) and NOT shared across turns — it only ever
// exists in memory for the single request that carried it, read through this
// closure. A scheduled routine has no live client attached to ask, so it's
// never available there; get_current_location degrades to saying so rather
// than throwing, same shape as every other "capability might not be there"
// tool in this codebase.
export interface LocationInfo {
  latitude: number;
  longitude: number;
  /** GPS/network fix accuracy, in meters, if the client reported one. */
  accuracyMeters?: number;
  /** How stale the fix was when the client sent it (it may be a cached last-
   *  known position, not a fresh reading taken at send time). */
  ageSeconds?: number;
}

export function makeLocationTools(getLocation: () => LocationInfo | undefined) {
  const getCurrentLocation = tool(
    async () => {
      const loc = getLocation();
      if (!loc) {
        return (
          "No location is available for this turn — the device being used right now " +
          "hasn't shared its location (permission off, or this is a scheduled routine " +
          "with no client attached). Ask the person which city/area they mean instead " +
          "of guessing."
        );
      }
      const accuracy = loc.accuracyMeters != null ? `, accuracy ~${Math.round(loc.accuracyMeters)}m` : "";
      const age =
        loc.ageSeconds != null && loc.ageSeconds > 30
          ? `, captured ${Math.round(loc.ageSeconds / 60)} min ago (may be a cached fix, not live)`
          : "";
      return (
        `The current device's location is latitude ${loc.latitude.toFixed(5)}, ` +
        `longitude ${loc.longitude.toFixed(5)}${accuracy}${age}. ` +
        `This is a real device fix, not a stored home address — use it directly (e.g. in a ` +
        `web search like "state parks near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}"), ` +
        `don't ask the person to repeat where they are.`
      );
    },
    {
      name: "get_current_location",
      description:
        "Get the current device's location (latitude/longitude) — the phone or " +
        "computer the person is using right now. Call this for any 'near me' / " +
        "'nearby' / 'in my area' / 'around here' request before asking the person " +
        "where they are or guessing a city.",
      schema: z.object({}),
    }
  );
  return [getCurrentLocation];
}
