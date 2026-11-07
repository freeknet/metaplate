// src/lib/og/cards.render.tsx
import type { RenderJob, RenderModule } from "metaplate/node";
import { ALL_CARDS, type CardCopy } from "./cards";
import { og } from "./plate";

const job = { plate: og, pages: ALL_CARDS } satisfies RenderJob<CardCopy>;

export default [job] satisfies RenderModule;
