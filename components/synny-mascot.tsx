"use client";

import React from "react";

// Synny — the Synapse mascot (Neuron design). Self-contained SVG, idle-animated
// with CSS (gentle bob + periodic blink + soft glow pulse). Drawn in a 120-unit
// box centered at origin. Scale via the `size` prop.
export function SynnyMascot({
  size = 120,
  style,
  title = "Synny",
}: {
  size?: number;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        animation: "synny-bob 3.2s ease-in-out infinite",
        ...style,
      }}
      aria-label={title}
      role="img"
    >
      <svg viewBox="-60 -60 120 120" width="100%" height="100%">
        <circle cx={0} cy={0} r={42} fill="#D97757" opacity={0.14} style={{ animation: "synny-glow 3.2s ease-in-out infinite" }} />
        <circle cx={0} cy={0} r={32} fill="#D97757" opacity={0.20} />
        {/* dendrite antennae */}
        <path d="M -20 -8 Q -28 -16 -32 -22" stroke="#A04A2A" strokeWidth={3} fill="none" strokeLinecap="round" />
        <path d="M 20 -8 Q 28 -16 32 -22" stroke="#A04A2A" strokeWidth={3} fill="none" strokeLinecap="round" />
        <path d="M -16 18 Q -22 27 -20 33" stroke="#A04A2A" strokeWidth={3} fill="none" strokeLinecap="round" />
        <path d="M 16 18 Q 22 27 20 33" stroke="#A04A2A" strokeWidth={3} fill="none" strokeLinecap="round" />
        {/* body */}
        <circle cx={0} cy={0} r={22} fill="#D97757" stroke="#A04A2A" strokeWidth={2.2} />
        <ellipse cx={-6} cy={-7} rx={6} ry={4} fill="white" opacity={0.32} />
        {/* eyes (blink via scaleY) */}
        <g style={{ animation: "synny-blink 4.5s ease-in-out infinite", transformOrigin: "0px -2px" }}>
          <circle cx={-8} cy={-2} r={5} fill="white" />
          <circle cx={8} cy={-2} r={5} fill="white" />
          <circle cx={-8} cy={-2} r={2.6} fill="#1A0A05" />
          <circle cx={8} cy={-2} r={2.6} fill="#1A0A05" />
          <circle cx={-7} cy={-3} r={0.9} fill="white" />
          <circle cx={9} cy={-3} r={0.9} fill="white" />
        </g>
        {/* smile */}
        <path d="M -4 8 Q 0 11 4 8" stroke="#5C2410" strokeWidth={1.8} fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}
