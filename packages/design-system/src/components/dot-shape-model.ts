/**
 * Pictures made of dots that form out of noise and dissolve again (`DotShape`): which dots there
 * are, and how bright each is. Pure, and seeded by the picture's name, so a server and a browser
 * draw the same. The motion itself is CSS (`dot-shape` in ratel.css).
 */

export type DotShapeName = keyof typeof DOT_SHAPES;

/** Dots with one brightness and one timing: one element, so that a picture is a few of them. */
export interface DotLayer {
  kind: "shape" | "noise";
  /** SVG path data: a point per dot, in cells. */
  path: string;
  /** Opacity while the picture is dissolved, while it is formed, and in the middle of its hold. */
  noise: number;
  formed: number;
  shimmer: number;
  delayMs: number;
}

/** One loop, as in ratel.css. It starts and ends formed. */
export const DOT_SHAPE_MS = 4_400;
/** Then it rests, formed. */
export const DOT_SHAPE_LOOPS = 3;

/** Each `#` is a dot of the picture. */
export const DOT_SHAPES = {
  topology: {
    width: 76,
    rows: [
      "",
      "                               ##############               ##############",
      "                              #              #             #              #",
      "                           #  # ##  #######  #          #  # ##  #######  #",
      "                       ###### # ##           # ########### # ##           #",
      "                       #   #  # ##  ####     #          #  # ##  ####     #",
      "                       #      #              #             #              #",
      "  ##############       #       ##############               ##############",
      " #              #      #",
      " # ##  #######  #      #",
      " # ##           # ######",
      " # ##  ####     #      #",
      " #              #      #",
      "  ##############       #",
      "                       #       ##############               ##############",
      "                       #      #              #             #              #",
      "                       #   #  # ##  #######  #          #  # ##  #######  #",
      "                       ###### # ##           # ########### # ##           #",
      "                           #  # ##  ####     #          #  # ##  ####     #",
      "                              #              #             #              #",
      "                               ##############               ##############",
      "",
    ],
  },
  topologySmall: {
    width: 42,
    rows: [
      "",
      "                            ############",
      "                           #            #",
      "                        #  # ##  #####  #",
      "                    ###### # ##         #",
      "                    #   #  # ##  ##     #",
      "                    #      #            #",
      "  ############      #       ############",
      " #            #     #",
      " # ##  #####  #     #",
      " # ##         # #####",
      " # ##  ##     #     #",
      " #            #     #",
      "  ############      #",
      "                    #       ############",
      "                    #      #            #",
      "                    #   #  # ##  #####  #",
      "                    ###### # ##         #",
      "                        #  # ##  ##     #",
      "                           #            #",
      "                            ############",
      "",
    ],
  },
  gauge: {
    width: 30,
    rows: [
      "",
      "",
      "           ########",
      "         ############",
      "        ####      ####",
      "       ###          ###",
      "      ###            ###",
      "      ##              ##",
      "     ###              ###",
      "     ##                ##",
      "     ##                ##",
      "     ##     ######     ##",
      "     ##                ##",
      "     ##                ##",
      "     ##                ##",
      "     ###              ###",
      "      ##              ##",
      "      ###            ###",
      "       ##            ##",
      "",
      "",
      "",
    ],
  },
  issues: {
    width: 34,
    rows: [
      "",
      "   ###",
      "  #   #   #################   #",
      "  # # #                        #",
      "  #   #   ############        #",
      "   ###",
      "",
      "",
      "   ###",
      "  #   #   #############       #",
      "  # # #                        #",
      "  #   #   ########            #",
      "   ###",
      "",
      "",
      "   ###",
      "  #   #   ###############     #",
      "  # # #                        #",
      "  #   #   ##########          #",
      "   ###",
      "",
      "",
    ],
  },
  bell: {
    width: 30,
    rows: [
      "",
      "",
      "",
      "              ##",
      "           ########",
      "          ##      ##",
      "         ##        ##",
      "         ##        ##",
      "         ##        ##",
      "         ##        ##",
      "         ##        ##",
      "         ##        ##",
      "        ##          ##",
      "       ##            ##",
      "      ##################",
      "",
      "            ######",
      "             ####",
      "",
      "",
      "",
      "",
    ],
  },
} as const satisfies Record<string, { width: number; rows: readonly string[] }>;

/** Share of the cells around the picture that hold a dot of noise. */
const NOISE_SHARE = 0.34;
/** One layer each. Their mean is the noise's over all cells, so that nothing shows when dissolved. */
const SHAPE_NOISE = [0, 0, 0, 0.15, 0.4, 0.65];
const SHAPE_FORMED = [1, 0.9, 1, 0.85, 1, 0.95];
const NOISE_NOISE = [0.3, 0.4, 0.55, 0.65, 0.75, 0.9];
const NOISE_FORMED = [0.12, 0.22, 0.17, 0.28, 0.1, 0.25];
const NOISE_SHIMMER = [0.28, 0.1, 0.3, 0.14, 0.24, 0.12];
/** The dots do not all turn at once. */
const DELAYS = [0, 120, 40, 200, 80, 160];

export function dotLayers(name: DotShapeName): DotLayer[] {
  const { width, rows } = DOT_SHAPES[name];
  const random = seeded(name);
  const shape: string[] = SHAPE_NOISE.map(() => "");
  const noise: string[] = NOISE_NOISE.map(() => "");
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < width; x++) {
      const layers = rows[y][x] === "#" ? shape : random() < NOISE_SHARE ? noise : null;
      if (layers) layers[Math.floor(random() * layers.length)] += `M${x} ${y}h0`;
    }
  return [
    ...noise.map((path, at) => ({
      kind: "noise" as const,
      path,
      noise: NOISE_NOISE[at],
      formed: NOISE_FORMED[at],
      shimmer: NOISE_SHIMMER[at],
      delayMs: DELAYS[at],
    })),
    ...shape.map((path, at) => ({
      kind: "shape" as const,
      path,
      noise: SHAPE_NOISE[at],
      formed: SHAPE_FORMED[at],
      shimmer: SHAPE_FORMED[at],
      delayMs: DELAYS[at],
    })),
  ];
}

/** Mulberry32, from the text. */
function seeded(text: string): () => number {
  let state = 0;
  for (let at = 0; at < text.length; at++) state = (state * 31 + text.charCodeAt(at)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
