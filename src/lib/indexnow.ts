/**
 * IndexNow: tells Bing (and the engines that share IndexNow, including the search behind ChatGPT and Copilot)
 * which pages changed, so new races, politics markets and daily reports are crawled within hours. The key file
 * is public/e732bc530a9ae1577b3cedbd3a232d82.txt. Called once a day by the scheduled handler (src/worker.ts).
 */
import { getIndex, getCycle } from "./markets";
import { TOPIC_SLUG } from "./politics";

const HOST = "parlaythepeople.com";
const KEY = "e732bc530a9ae1577b3cedbd3a232d82";

export async function pingIndexNow() {
	const o = `https://${HOST}`;
	const urls = [`${o}/`, `${o}/politics/`, `${o}/elections/`, `${o}/daily/`, `${o}/pro/`, ...Object.values(TOPIC_SLUG).map((s) => `${o}/politics/${s}/`)];
	urls.push(`${o}/daily/${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}/`);
	const index = await getIndex();
	for (const cy of index?.cycles ?? []) {
		urls.push(`${o}/${cy.year}/`);
		if (cy.offices.includes("president")) urls.push(`${o}/${cy.year}/president/`);
		const data = await getCycle(cy.year);
		for (const r of data?.races ?? []) urls.push(`${o}${r.path}`);
	}
	const res = await fetch("https://api.indexnow.org/indexnow", {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${o}/${KEY}.txt`, urlList: [...new Set(urls)].slice(0, 10000) }),
	});
	return { status: res.status, urls: urls.length };
}
