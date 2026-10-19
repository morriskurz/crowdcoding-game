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

/** Resolve a scenario name (possibly untrusted) to a known scenario. */
export function resolveScenario(name) {
  const key = typeof name === "string" && Object.hasOwn(SCENARIOS, name) ? name : DEFAULT_SCENARIO;
  return { name: key, ...SCENARIOS[key] };
}
