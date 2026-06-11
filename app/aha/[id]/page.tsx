/**
 * /aha/[id] — Full-page Aha Insight view.
 *
 * Replaces the cramped modal that used to be triggered by `synapse:open-aha`.
 * The modal squeezed the trajectory, hypothesis, reframe, AND evidence graph
 * into a 720px box; in practice the graph at the bottom was unreadable. A
 * dedicated route gives the evidence the full viewport.
 *
 * `id` can be a real aha id, or the literal "latest" to show the most recent.
 * The page itself is a thin client wrapper that defers to <AhaFullView>.
 */
"use client";

import { AhaFullView } from "@/components/aha-full-view";

export default function AhaPage({ params }: { params: { id: string } }) {
  return <AhaFullView id={params.id} />;
}
