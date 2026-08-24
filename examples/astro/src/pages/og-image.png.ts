import type { APIRoute } from "astro";
import { og } from "../lib/og";

export const prerender = true;

export const GET = og.handler({ title: "An Astro site" }) satisfies APIRoute;
