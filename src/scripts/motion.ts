/**
 * Scroll-in motion for the finance and voting sections (GSAP + ScrollTrigger), driven by data attributes:
 *   data-count="1234.5" data-fmt="usd|int|pct"   numbers count up from zero
 *   data-grow                                     bars grow from zero to their inline width (or height with data-grow="y")
 *   data-draw                                     SVG lines draw themselves
 *   data-pop                                      children fade and rise in, one after another
 * Everything is in its final state without motion (prefers-reduced-motion) or without JavaScript.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}K` : `$${Math.round(x)}`);
const fmt = (x: number, kind?: string) => (kind === "usd" ? usd(x) : kind === "pct" ? `${Math.round(x)}%` : Math.round(x).toLocaleString("en-US"));

export function motion(root: { querySelectorAll: Document["querySelectorAll"] } = document) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const once = (el: Element, play: () => void) => ScrollTrigger.create({ trigger: el, start: "top 88%", once: true, onEnter: play });

	root.querySelectorAll<HTMLElement>("[data-count]:not([data-moved])").forEach((el) => {
		el.dataset.moved = "1";
		const end = Number(el.dataset.count), kind = el.dataset.fmt;
		const o = { v: 0 };
		el.textContent = fmt(0, kind);
		once(el, () => gsap.to(o, { v: end, duration: 1.6, ease: "power2.out", onUpdate: () => (el.textContent = fmt(o.v, kind)) }));
	});
	root.querySelectorAll<HTMLElement>("[data-grow]:not([data-moved])").forEach((el) => {
		el.dataset.moved = "1";
		const prop = el.dataset.grow === "y" ? "height" : "width";
		const target = el.style.getPropertyValue(prop) || "100%";
		gsap.set(el, { [prop]: 0 });
		once(el, () => gsap.to(el, { [prop]: target, duration: 1.1, ease: "power3.out", delay: Number(el.dataset.delay ?? 0) }));
	});
	root.querySelectorAll<SVGPathElement>("[data-draw]:not([data-moved])").forEach((el) => {
		el.dataset.moved = "1";
		const len = el.getTotalLength?.() ?? 0;
		if (!len) return;
		gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
		once(el, () => gsap.to(el, { strokeDashoffset: 0, duration: 1.8, ease: "power2.inOut" }));
	});
	root.querySelectorAll<HTMLElement>("[data-pop]:not([data-moved])").forEach((el) => {
		el.dataset.moved = "1";
		const kids = [...el.children];
		gsap.set(kids, { opacity: 0, y: 18 });
		once(el, () => gsap.to(kids, { opacity: 1, y: 0, duration: 0.55, ease: "power2.out", stagger: Math.min(0.06, 0.9 / Math.max(1, kids.length)) }));
	});
	ScrollTrigger.refresh();
}
