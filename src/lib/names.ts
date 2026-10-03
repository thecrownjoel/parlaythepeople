/**
 * Match a candidate across exchanges by last name + first initial, the same rule the collector uses:
 * "J.D. Vance" == "JD Vance", "Donald J. Trump" == "Donald Trump", "Donald Trump Jr." stays separate.
 */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
export function nameKey(n: string): string {
	const words = n.toLowerCase().replace(/\./g, " ").replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
	if (!words.length) return "";
	const suffix = words.length > 1 && SUFFIXES.has(words[words.length - 1]) ? words[words.length - 1] : "";
	const core = suffix ? words.slice(0, -1) : words;
	return `${core[core.length - 1]}${suffix ? " " + suffix : ""}|${core.length > 1 ? core[0][0] : ""}`;
}
