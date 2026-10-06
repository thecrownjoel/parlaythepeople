/** Site-wide identity used in structured data, feeds and AI-facing files. */
export const SITE_NAME = "Parlay the People";
export const SITE_TAGLINE = "The conservative read on the election markets.";
export const SITE_DESCRIPTION =
	"Kalshi and Polymarket odds for every U.S. presidential, Senate, House and governor race, read from a pro-Republican perspective, and where your help can make the difference for GOP candidates. Updated every 10 minutes.";

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

export const authorPath = (slug: string) => `/authors/${slug}/`;

/** schema.org Person for an author, referenced by @id from their articles. */
export function person(origin: string, a: { slug: string; name: string; bio?: string | null; image?: string | null; sameAs?: (string | null | undefined)[] }) {
	const url = `${origin}${authorPath(a.slug)}`;
	const same = (a.sameAs ?? []).filter((s): s is string => !!s && !s.startsWith(origin));
	return {
		"@type": "Person",
		"@id": `${url}#person`,
		name: a.name,
		url,
		...(a.bio ? { description: a.bio.split(/\n\s*\n/)[0].trim() } : {}),
		...(a.image ? { image: a.image.startsWith("http") ? a.image : `${origin}${a.image}` } : {}),
		...(same.length ? { sameAs: same } : {}),
		worksFor: { "@id": `${origin}/#org` },
	};
}
