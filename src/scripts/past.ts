/** Year buttons on /voting/ pages: load that year from /api/v1/past (earlier years show the Pro card unless Pro). */
import { motion } from "./motion";

export function pastYears() {
	for (const box of document.querySelectorAll<HTMLElement>("[data-past]")) {
		const body = box.querySelector<HTMLElement>("[data-past-body]")!;
		const cache = new Map<string, string>();
		const first = box.querySelector<HTMLElement>('[aria-pressed="true"]')?.dataset.year;
		if (first) cache.set(first, body.innerHTML);
		// closing the Pro card goes back to the latest year
		box.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("[data-gate-close]") && first) setTimeout(() => box.querySelector<HTMLButtonElement>(`[data-year="${first}"]`)?.click(), 0);
		});
		box.querySelectorAll<HTMLButtonElement>("[data-year]").forEach((b) => b.addEventListener("click", async () => {
			const y = b.dataset.year!;
			box.querySelectorAll("[data-year]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
			if (!cache.has(y)) {
				body.style.opacity = ".45";
				const q = new URLSearchParams({ view: box.dataset.past === "nation" ? "nation" : "state", year: y, st: box.dataset.st ?? "", from: location.pathname });
				try {
					const r = await fetch(`/api/v1/past?${q}`);
					cache.set(y, r.ok ? await r.text() : `<p class="fx-note">Couldn't load ${y}. Try again in a moment.</p>`);
				} catch {
					cache.set(y, `<p class="fx-note">Couldn't load ${y}. Check your connection.</p>`);
				}
				body.style.opacity = "";
			}
			body.innerHTML = cache.get(y)!;
			motion(body);
		}));
	}
}
