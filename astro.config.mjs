import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { fileURLToPath } from "node:url";

// native plugins load by module path; the virtual plugins module needs an absolute one
const local = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			siteUrl: "https://parlaythepeople.com",
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [
				{
					// The Parlay Newsroom: AI and human writers, story queue and drafts (src/plugins/newsroom, src/lib/newsroom)
					id: "newsroom",
					version: "0.1.0",
					format: "native",
					entrypoint: local("./src/plugins/newsroom/index.ts"),
					capabilities: ["media:write", "content:write", "content:publish"],
					adminPages: [
						{ path: "/writers", label: "Writers", icon: "users" },
						{ path: "/queue", label: "Story queue", icon: "list" },
						{ path: "/drafts", label: "Drafts", icon: "file-text" },
						{ path: "/balance", label: "Balance", icon: "chart" },
						{ path: "/settings", label: "Settings", icon: "settings" },
					],
				},
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "IBM Plex Sans",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Montserrat",
			cssVariable: "--font-display",
			weights: [700, 800],
			fallbacks: ["Arial", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "IBM Plex Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["ui-monospace", "monospace"],
		},
	],
	devToolbar: { enabled: false },
});
