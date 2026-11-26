/**
 * The pictures of what a place will hold (`VeilShape`), and how they are cut out: pure, so that a
 * server and a browser draw the same. A picture is a bitmap of cells; the veil shows through each
 * `#` cell. The motion itself is CSS (`veil-shape` in ratel.css).
 */

export type VeilShapeName = keyof typeof VEIL_SHAPES;

/** One drift of the glow, as in ratel.css. It starts and ends where it rests. */
export const VEIL_MS = 9_000;
/** Then it rests (WCAG 2.2.2: it stops by itself). */
export const VEIL_LOOPS = 2;

/** Each `#` is a cell of the picture. */
export const VEIL_SHAPES = {
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

/** The cells of a picture as SVG path data. */
export function maskPath(name: VeilShapeName): string {
  return VEIL_SHAPES[name].rows
    .flatMap((row, y) =>
      [...row].flatMap((cell, x) => (cell === "#" ? [`M${x} ${y}h1v1h-1z`] : [])),
    )
    .join("");
}

/** The picture as a CSS mask: an SVG of its cells, as a data URL. */
export function maskImage(name: VeilShapeName): string {
  const { width, rows } = VEIL_SHAPES[name];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${rows.length}"><path d="${maskPath(name)}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
