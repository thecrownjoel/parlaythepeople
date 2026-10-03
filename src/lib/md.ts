/** Small, safe markdown for analyst text in emails and PDFs: paragraphs, lists, bold, italics, ### headings, http(s) and site links. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function mdToHtml(s: string, origin = "https://parlaythepeople.com") {
	const inline = (t: string) => esc(t)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, (_m, a, h) => `<a href="${h.startsWith("/") ? origin + h : h}">${a}</a>`);
	const out: string[] = [];
	let list: "ul" | "ol" | null = null, para: string[] = [];
	const flush = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
	const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
	for (const raw of s.trim().split("\n")) {
		const line = raw.trimEnd();
		const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), h = line.match(/^#{1,4}\s+(.*)$/);
		if (ul || ol) {
			flush();
			const kind = ul ? "ul" : "ol";
			if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
			out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
		} else if (!line.trim()) { flush(); close(); }
		else if (h) { flush(); close(); out.push(`<h3>${inline(h[1])}</h3>`); }
		else { close(); para.push(inline(line)); }
	}
	flush(); close();
	return out.join("\n");
}
