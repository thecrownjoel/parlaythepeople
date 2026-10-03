/** Site-wide identity used in structured data, feeds and AI-facing files. */
export const SITE_NAME = "Parlay the People";
export const SITE_TAGLINE = "The running record of what election markets expect.";
export const SITE_DESCRIPTION =
	"Kalshi and Polymarket odds for every U.S. presidential, Senate, House and governor race, side by side, with price history. Updated every 10 minutes.";

export function organization(origin: string) {
	return {
		"@type": "Organization",
		"@id": `${origin}/#org`,
		name: SITE_NAME,
		url: `${origin}/`,
		description: SITE_DESCRIPTION,
	};
}

export function breadcrumbs(origin: string, items: [string, string][]) {
	return {
		"@type": "BreadcrumbList",
		itemListElement: items.map(([name, path], i) => ({
			"@type": "ListItem",
			position: i + 1,
			name,
			item: `${origin}${path}`,
		})),
	};
}

export function faq(items: [string, string][]) {
	return {
		"@type": "FAQPage",
		mainEntity: items.map(([q, a]) => ({
			"@type": "Question",
			name: q,
			acceptedAnswer: { "@type": "Answer", text: a },
		})),
	};
}

/** schema.org Dataset, so the data is findable in dataset search and citable by answer engines. */
export function dataset(origin: string, o: { name: string; description: string; path: string; json: string; csv?: string; modified: string; keywords: string[] }) {
	return {
		"@type": "Dataset",
		name: o.name,
		description: o.description,
		url: `${origin}${o.path}`,
		creator: { "@id": `${origin}/#org` },
		publisher: { "@id": `${origin}/#org` },
		dateModified: o.modified,
		isAccessibleForFree: true,
		keywords: o.keywords,
		measurementTechnique: "Prediction market prices (Kalshi bid/ask midpoint; Polymarket displayed price), normalized to sum to 100%",
		distribution: [
			{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}${o.json}` },
			...(o.csv ? [{ "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${origin}${o.csv}` }] : []),
		],
	};
}

export function graph(...nodes: object[]) {
	return { "@context": "https://schema.org", "@graph": nodes };
}
