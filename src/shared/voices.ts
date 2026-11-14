/**
 * English Kokoro voices. The first letter is the accent (a = American, b = British),
 * the second is the gender (f = female, m = male).
 */
export const VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole",
  "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

export const DEFAULT_VOICE = "af_heart";

/** "af_heart" → { name: "Heart", accent: "American", gender: "female" } */
export function describeVoice(id: string) {
  return {
    name: id.charAt(3).toUpperCase() + id.slice(4),
    accent: id.startsWith("b") ? "British" : "American",
    gender: id.charAt(1) === "m" ? "male" : "female",
  };
}
