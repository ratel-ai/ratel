import type { CraftKind } from "@/lib/views/fixes/crafter-types";

/**
 * One small looping drawing per kind of suggestion, showing the fix as a
 * movement: boxes are tool calls, a line between them the agent's hop. Each
 * loop runs about three seconds and holds its end state for a moment. Plain
 * SVG and CSS keyframes; under reduced motion the end state is simply there.
 * Grays throughout, the fix in the brightest one; a rejected call is the
 * danger cross and an accepted one the success tick, each a shape as well as
 * a color (DESIGN.md, Color). Motion that explains the fix is the one kind
 * DESIGN.md keeps, and it plays only in a drafted fix's panel on Fixes.
 * Drawn first for Tool craft's guide (Berja, PR #242); Fixes keeps it.
 */

export const KIND_MOTION_STYLES = `
/* Every loop opens on a short hold of its start state, which reads as a pause between replays. A negative delay skips that hold on the first play, so the drawing moves the moment the guide opens. */
[data-kind-motion] .km { animation-duration: 3.2s; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); animation-iteration-count: infinite; animation-fill-mode: both; animation-delay: -0.7s; }
@media (prefers-reduced-motion: reduce) {
  [data-kind-motion] .km { animation: none !important; }
  [data-kind-motion] .km-end { opacity: 1 !important; transform: none !important; }
  [data-kind-motion] .km-start { opacity: 0 !important; }
}
.km-merge-a { animation-name: km-merge-a; } .km-merge-b { animation-name: km-merge-b; } .km-appear { animation-name: km-appear; } .km-vanish { animation-name: km-vanish; }
.km-fold-small { animation-name: km-fold-small; } .km-chain-box { animation-name: km-draw; stroke-dasharray: 1; } .km-chain-arrow { animation-name: km-vanish; }
.km-par-a { animation-name: km-par-a; } .km-par-b { animation-name: km-par-b; }
.km-enrich-dot { animation-name: km-enrich-dot; } .km-preload { animation-name: km-preload; }
.km-split-up { animation-name: km-split-up; } .km-split-down { animation-name: km-split-down; }
.km-gap-path { animation-name: km-gap-path; stroke-dasharray: 1; } .km-retire-gone { animation-name: km-vanish; } .km-retire-up { animation-name: km-retire-up; }
.km-req-small { animation-name: km-req-small; }
.km-guess { animation-name: km-guess; } .km-cross { animation-name: km-cross; } .km-opts { animation-name: km-opts; } .km-tick { animation-name: km-tick; }
.km-born { animation-name: km-born; transform-origin: 48px 20px; } .km-spark { animation-name: km-spark; transform-origin: 48px 20px; }
.km-old-line { animation-name: km-old-line; } .km-new-line { animation-name: km-new-line; transform-origin: left center; } .km-new-line-2 { animation-name: km-new-line-2; transform-origin: left center; }
@keyframes km-merge-a { 0%, 25% { transform: translateX(0); opacity: 1; } 55% { transform: translateX(14px); opacity: 1; } 65%, 100% { transform: translateX(14px); opacity: 0; } }
@keyframes km-merge-b { 0%, 25% { transform: translateX(0); opacity: 1; } 55% { transform: translateX(-14px); opacity: 1; } 65%, 100% { transform: translateX(-14px); opacity: 0; } }
@keyframes km-appear { 0%, 60% { opacity: 0; } 75%, 100% { opacity: 1; } }
@keyframes km-vanish { 0%, 40% { opacity: 1; } 60%, 100% { opacity: 0; } }
@keyframes km-fold-small { 0%, 25% { transform: translateX(0); opacity: 1; } 60% { transform: translateX(38px); opacity: 0.6; } 70%, 100% { transform: translateX(38px); opacity: 0; } }
@keyframes km-draw { 0%, 30% { stroke-dashoffset: 1; opacity: 1; } 70%, 100% { stroke-dashoffset: 0; opacity: 1; } }
@keyframes km-par-a { 0%, 30% { transform: translate(0, 0); } 65%, 100% { transform: translate(24px, -8px); } }
@keyframes km-par-b { 0%, 30% { transform: translate(0, 0); } 65%, 100% { transform: translate(-24px, 8px); } }
@keyframes km-enrich-dot { 0%, 25% { transform: translateX(0); opacity: 1; } 60%, 100% { transform: translateX(-46px); opacity: 1; } }
@keyframes km-preload { 0%, 25% { transform: translateX(0); } 60%, 100% { transform: translateX(-30px); } }
@keyframes km-split-up { 0%, 30% { transform: translate(0, 0); opacity: 0; } 40% { opacity: 1; } 70%, 100% { transform: translate(40px, -10px); opacity: 1; } }
@keyframes km-split-down { 0%, 30% { transform: translate(0, 0); opacity: 0; } 40% { opacity: 1; } 70%, 100% { transform: translate(40px, 10px); opacity: 1; } }
@keyframes km-gap-path { 0% { stroke-dashoffset: 1; opacity: 1; } 40% { stroke-dashoffset: 0; opacity: 1; } 60%, 100% { stroke-dashoffset: 0; opacity: 0; } }
@keyframes km-retire-up { 0%, 55% { transform: translateY(0); } 80%, 100% { transform: translateY(-10px); } }
@keyframes km-guess { 0%, 40% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes km-cross { 0%, 12% { opacity: 0; } 22%, 42% { opacity: 1; } 52%, 100% { opacity: 0; } }
@keyframes km-opts { 0%, 48% { opacity: 0; transform: translateY(3px); } 60%, 100% { opacity: 1; transform: translateY(0); } }
@keyframes km-tick { 0%, 66% { opacity: 0; } 78%, 100% { opacity: 1; } }
@keyframes km-born { 0%, 20% { transform: scale(0); opacity: 0; } 45% { transform: scale(1.12); opacity: 1; } 55%, 100% { transform: scale(1); opacity: 1; } }
@keyframes km-spark { 0%, 30% { transform: scale(0.4); opacity: 0; } 50% { transform: scale(1); opacity: 1; } 75%, 100% { transform: scale(1.3); opacity: 0; } }
@keyframes km-old-line { 0%, 20% { opacity: 1; transform: translateX(0); } 40%, 100% { opacity: 0; transform: translateX(6px); } }
@keyframes km-new-line { 0%, 45% { transform: scaleX(0); } 65%, 100% { transform: scaleX(1); } }
@keyframes km-new-line-2 { 0%, 60% { transform: scaleX(0); } 80%, 100% { transform: scaleX(1); } }
@keyframes km-req-small { 0%, 25% { transform: translateX(-30px); opacity: 0; } 55%, 100% { transform: translateX(0); opacity: 1; } }
`;

const BOX = "fill-app stroke-fg-subtle";
/** The fix: the box the change creates or keeps, lit against the rest. */
const BOX_HOT = "fill-fg/10 stroke-fg";
const LINE = "stroke-fg-subtle";

function Box({
  x,
  y,
  w = 24,
  h = 16,
  hot = false,
  className = "",
  dashed = false,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  hot?: boolean;
  className?: string;
  dashed?: boolean;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={3}
      strokeWidth={1.5}
      strokeDasharray={dashed ? "3 2" : undefined}
      className={`${hot ? BOX_HOT : BOX} ${className}`}
      pathLength={dashed ? undefined : 1}
    />
  );
}

function Arrow({
  x1,
  x2,
  y,
  className = "",
}: {
  x1: number;
  x2: number;
  y: number;
  className?: string;
}) {
  return (
    <g className={`${LINE} ${className}`} strokeWidth={1.5} fill="none">
      <line x1={x1} y1={y} x2={x2} y2={y} />
      <polyline points={`${x2 - 4},${y - 3} ${x2},${y} ${x2 - 4},${y + 3}`} />
    </g>
  );
}

function Lines({
  x,
  y,
  widths,
  className = "",
}: {
  x: number;
  y: number;
  widths: number[];
  className?: string;
}) {
  return (
    <g className={`${LINE} ${className}`} strokeWidth={1.5} strokeLinecap="round">
      {widths.map((w, i) => (
        <line key={i} x1={x} y1={y + i * 4} x2={x + w} y2={y + i * 4} />
      ))}
    </g>
  );
}

export function KindMotion({ kind }: { kind: CraftKind }) {
  return (
    <svg
      viewBox="0 0 96 40"
      width={96}
      height={40}
      aria-hidden
      data-kind-motion={kind}
      className="shrink-0"
    >
      {drawing(kind)}
    </svg>
  );
}

function drawing(kind: CraftKind) {
  switch (kind) {
    case "merge_tools":
      return (
        <>
          <Box x={12} y={12} className="km km-merge-a km-start" />
          <Box x={60} y={12} className="km km-merge-b km-start" />
          <Box x={30} y={12} w={36} hot className="km km-appear km-end" />
        </>
      );
    case "fold_prerequisite":
      return (
        <>
          <Box x={8} y={12} w={20} className="km km-fold-small km-start" />
          <Arrow x1={30} x2={44} y={20} className="km km-vanish km-start" />
          <Box x={48} y={12} w={40} />
          <Box x={52} y={15} w={10} h={10} hot className="km km-appear km-end" />
        </>
      );
    case "compose_chain":
      return (
        <>
          <Box x={10} y={13} w={18} h={14} />
          <Arrow x1={30} x2={37} y={20} className="km km-chain-arrow km-start" />
          <Box x={39} y={13} w={18} h={14} />
          <Arrow x1={59} x2={66} y={20} className="km km-chain-arrow km-start" />
          <Box x={68} y={13} w={18} h={14} />
          <Box x={5} y={7} w={86} h={26} hot className="km km-chain-box km-end" />
        </>
      );
    case "parallel_pair":
      return (
        <>
          <Box x={12} y={12} className="km km-par-a" />
          <Arrow x1={38} x2={58} y={20} className="km km-vanish km-start" />
          <Box x={60} y={12} className="km km-par-b" />
        </>
      );
    case "enrich_response":
      return (
        <>
          <Box x={10} y={12} w={28} />
          <Arrow x1={40} x2={56} y={20} className="km km-vanish km-start" />
          <Box x={58} y={12} w={28} className="km km-vanish km-start" />
          <circle cx={72} cy={20} r={3.5} className="fill-fg km km-enrich-dot km-end" />
        </>
      );
    case "preload_context":
      return (
        <>
          <line
            x1={34}
            y1={6}
            x2={34}
            y2={34}
            strokeWidth={1.5}
            strokeDasharray="3 2"
            className={LINE}
          />
          <Box x={40} y={12} w={22} hot className="km km-preload km-end" />
          <Arrow x1={64} x2={70} y={20} />
          <Box x={72} y={12} w={18} />
        </>
      );
    case "tighten_schema":
      // The call on the left carries an argument. First it is a guess ("?") and the tool rejects it; then the
      // argument shows its allowed values, the agent picks one, and the tool accepts.
      return (
        <>
          <Box x={6} y={9} w={30} h={22} />
          <text
            x={21}
            y={24.5}
            textAnchor="middle"
            fontSize={12}
            fontWeight={600}
            className="fill-fg-muted font-mono km km-guess km-start"
          >
            ?
          </text>
          <g className="km km-opts km-end">
            <rect x={11} y={12} width={20} height={4.5} rx={2.25} className="fill-fg" />
            <rect x={11} y={18} width={20} height={4.5} rx={2.25} className="fill-fg-subtle/40" />
            <rect x={11} y={24} width={20} height={4.5} rx={2.25} className="fill-fg-subtle/40" />
          </g>
          <Arrow x1={38} x2={54} y={20} />
          <Box x={56} y={9} w={34} h={22} />
          <g className="km km-cross km-start stroke-danger" strokeWidth={2} strokeLinecap="round">
            <line x1={68} y1={15} x2={78} y2={25} />
            <line x1={78} y1={15} x2={68} y2={25} />
          </g>
          <polyline
            points="67,20 72,25 80,15"
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-success km km-tick km-end"
          />
        </>
      );
    case "require_prerequisite":
      return (
        <>
          <Box x={14} y={12} w={20} hot className="km km-req-small km-end" />
          <Arrow x1={36} x2={48} y={20} className="km km-appear km-end" />
          <Box x={50} y={12} w={32} />
          <g
            className="km km-vanish km-start stroke-danger"
            strokeWidth={1.8}
            strokeLinecap="round"
          >
            <line x1={62} y1={16} x2={70} y2={24} />
            <line x1={70} y1={16} x2={62} y2={24} />
          </g>
          <polyline
            points="61,20 65,24 72,16"
            fill="none"
            strokeWidth={1.8}
            strokeLinecap="round"
            className="stroke-success km km-appear km-end"
          />
        </>
      );
    case "split_by_use":
      return (
        <>
          <Box x={12} y={12} w={24} hot className="km km-split-up km-end" />
          <Box x={12} y={12} w={24} hot className="km km-split-down km-end" />
          <Box x={10} y={12} w={28} />
        </>
      );
    case "fill_gap":
      return (
        <>
          <g
            className="km km-spark km-start stroke-fg-muted"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <line x1={48} y1={2} x2={48} y2={7} />
            <line x1={48} y1={33} x2={48} y2={38} />
            <line x1={18} y1={20} x2={24} y2={20} />
            <line x1={72} y1={20} x2={78} y2={20} />
            <line x1={27} y1={6} x2={31} y2={10} />
            <line x1={65} y1={30} x2={69} y2={34} />
            <line x1={65} y1={10} x2={69} y2={6} />
            <line x1={27} y1={34} x2={31} y2={30} />
          </g>
          <Box x={30} y={12} w={36} hot className="km km-born km-end" />
          <g className="km km-born km-end stroke-fg" strokeWidth={1.8} strokeLinecap="round">
            <line x1={48} y1={16} x2={48} y2={24} />
            <line x1={44} y1={20} x2={52} y2={20} />
          </g>
        </>
      );
    case "deprecate_tool":
      return (
        <>
          <Box x={24} y={2} w={48} h={10} />
          <Box x={24} y={15} w={48} h={10} className="km km-retire-gone km-start" />
          <Box x={24} y={28} w={48} h={10} className="km km-retire-up km-end" />
        </>
      );
    case "rewrite_tool":
      return (
        <>
          <Box x={14} y={6} w={68} h={28} />
          <Lines x={22} y={14} widths={[44, 30, 38]} className="km km-old-line km-start" />
          <line
            x1={22}
            y1={14}
            x2={70}
            y2={14}
            strokeWidth={1.5}
            strokeLinecap="round"
            className="stroke-fg km km-new-line km-end"
          />
          <line
            x1={22}
            y1={20}
            x2={54}
            y2={20}
            strokeWidth={1.5}
            strokeLinecap="round"
            className="stroke-fg km km-new-line km-end"
          />
          <line
            x1={22}
            y1={26}
            x2={62}
            y2={26}
            strokeWidth={1.5}
            strokeLinecap="round"
            className="stroke-fg km km-new-line-2 km-end"
          />
        </>
      );
  }
}
