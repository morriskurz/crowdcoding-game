// Fixed list of presentation scenarios (owner-maintained). An agent picks one by name in
// feature.json `scenario`; anything else falls back to the default. Agents cannot add scenarios:
// CI loads this directory from the base (main) checkout, never from the PR head.
//
// A scenario drives N bot players deterministically. Each tick it gets a read-only view of the
// world (same seed + same inputs => same world) and returns one input per bot. No randomness,
// no clocks: the sim server calls input() once per tick in a fixed bot order.
import idleCrowd from "./idle-crowd.mjs";
import chase from "./chase.mjs";
import collect from "./collect.mjs";

export const SCENARIOS = { "idle-crowd": idleCrowd, chase, collect };
export const DEFAULT_SCENARIO = "idle-crowd";

// Keywords that make a spec's effect visible in a scenario, checked in this order. Agents rarely set
// feature.json `scenario`, and the default idle crowd almost never eats or collides, so a feature
// about scoring or enemies would show nothing on the before/after video (crowdcoding feature #5).
const INFER = [
  ["collect", /\b(scor\w*|points?|eat\w*|pellets?|food|collect\w*|pick\w* up|grow\w*|size|bigger)\b/i],
  ["chase", /\b(chas\w*|enem\w*|bots?|collid\w*|collision\w*|crash\w*|bump\w*|kill\w*|attack\w*|dash\w*|boost\w*|speed\w*|fast\w*|trail\w*|tail\w*)\b/i],
];

/** Scenario that shows a spec best, by keyword; the default when nothing matches. Untrusted text, only matched. */
export function inferScenario(spec) {
  if (typeof spec !== "string") return DEFAULT_SCENARIO;
  const text = spec.slice(0, 500);
  for (const [name, re] of INFER) if (re.test(text)) return name;
  return DEFAULT_SCENARIO;
}

/** Resolve a scenario name (possibly untrusted) to a known scenario. */
export function resolveScenario(name) {
  const key = typeof name === "string" && Object.hasOwn(SCENARIOS, name) ? name : DEFAULT_SCENARIO;
  return { name: key, ...SCENARIOS[key] };
}
