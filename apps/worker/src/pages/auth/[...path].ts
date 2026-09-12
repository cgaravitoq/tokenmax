import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { app } from "@/server/app";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => app.fetch(request, env);
