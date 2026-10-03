/**
 * Countries in the header's country menu. Add an entry here to add a country;
 * `href` is where that country's elections live on the site.
 */
export interface Country {
	code: string; // ISO 3166-1 alpha-2, lowercase
	name: string;
	short: string; // shown next to the flag in the header
	href: string;
	flag: string; // inline SVG (emoji flags don't render on Windows)
}

function usFlag() {
	const white = [1, 3, 5, 7, 9, 11].map((i) => `M0,${((i + 0.5) * 10 / 13).toFixed(3)}H19`).join("");
	const stars: string[] = [];
	for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) stars.push(`<circle cx="${(0.65 + c * 1.26).toFixed(2)}" cy="${(0.55 + r * 1.07).toFixed(2)}" r="0.24"/>`);
	return `<svg viewBox="0 0 19 10" aria-hidden="true" focusable="false"><rect width="19" height="10" fill="#B22234"/><path d="${white}" stroke="#fff" stroke-width="0.77"/><rect width="7.6" height="5.385" fill="#3C3B6E"/><g fill="#fff">${stars.join("")}</g></svg>`;
}

export const COUNTRIES: Country[] = [
	{ code: "us", name: "United States", short: "USA", href: "/", flag: usFlag() },
];

export const DEFAULT_COUNTRY = "us";
