/** Line colors for multi-line charts: shades of each party's color, so lines stay readable by party. */
const D = ["#2e62d0", "#6f9bf2", "#1d3f8c", "#9db8f0", "#4a7fc0", "#5b6fd6"];
const R = ["#d23f35", "#f2867b", "#8c241c", "#f0aca4", "#c4603e", "#b8373f"];
const O = ["#8a8f99", "#a77dc2", "#5f8f6e"];
export function partyShades(parties: (string | null)[]): string[] {
	const used = { D: 0, R: 0, O: 0 };
	return parties.map((p) => (p === "D" ? D[used.D++ % D.length] : p === "R" ? R[used.R++ % R.length] : O[used.O++ % O.length]));
}
