import type { APIRoute } from "astro";
import track from "../../../data/track-2024-25.json";

/** The track record behind /track-record/, race by race: prices 1, 7 and 30 days out and who won. */
export const GET: APIRoute = () =>
	Response.json(track, { headers: { "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } });
