/**
 * A MaxMind DB file for tests, as DB-IP Lite writes it: an IPv4 tree of 24-bit records. Only what the
 * fixture needs of the format (https://maxmind.github.io/MaxMind-DB/).
 */

export type FixtureRecord = {
  country: { iso_code: string };
  subdivisions?: { names: { en: string } }[];
};
type Value = string | number | Value[] | { [key: string]: Value };

const SEPARATOR = Buffer.alloc(16);
const MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com")]);

/** `networks`: "8.8.8.0/24" and the record of its addresses. */
export function mmdbFixture(networks: Readonly<Record<string, FixtureRecord>>): Buffer {
  const nodes: [Slot, Slot][] = [[null, null]];
  const records: Buffer[] = [];
  let size = 0;
  for (const [network, record] of Object.entries(networks)) {
    const [address, prefix] = network.split("/");
    const data = encode(record as unknown as Value);
    insert(nodes, bitsOf(address).slice(0, Number(prefix)), { data: size });
    records.push(data);
    size += data.length;
  }
  const tree = Buffer.alloc(nodes.length * 6);
  for (const [index, node] of nodes.entries())
    for (const side of [0, 1] as const) {
      const slot = node[side];
      const value =
        slot === null
          ? nodes.length
          : "node" in slot
            ? slot.node
            : nodes.length + SEPARATOR.length + slot.data;
      tree.writeUIntBE(value, index * 6 + side * 3, 3);
    }
  const metadata = encode({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: 1,
    database_type: "Fixture",
    description: { en: "Fixture" },
    ip_version: 4,
    languages: ["en"],
    node_count: nodes.length,
    record_size: 24,
  });
  return Buffer.concat([tree, SEPARATOR, ...records, MARKER, metadata]);
}

type Slot = null | { node: number } | { data: number };

function insert(nodes: [Slot, Slot][], bits: readonly (0 | 1)[], data: { data: number }): void {
  let at = 0;
  for (const [index, bit] of bits.entries()) {
    if (index === bits.length - 1) {
      nodes[at][bit] = data;
      return;
    }
    const next = nodes[at][bit];
    if (next && "node" in next) at = next.node;
    else {
      nodes.push([null, null]);
      nodes[at][bit] = { node: nodes.length - 1 };
      at = nodes.length - 1;
    }
  }
}

function bitsOf(address: string): (0 | 1)[] {
  return address
    .split(".")
    .flatMap((part) =>
      [...Number(part).toString(2).padStart(8, "0")].map((bit) => (bit === "1" ? 1 : 0)),
    );
}

/** A string (2), a map (7), an unsigned integer of 32 bits (6) or an array (11, extended). */
function encode(value: Value): Buffer {
  if (typeof value === "string") {
    const text = Buffer.from(value);
    return Buffer.concat([control(2, text.length), text]);
  }
  if (typeof value === "number") {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return Buffer.concat([control(6, 4), bytes]);
  }
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from([value.length, 11 - 7]), ...value.map(encode)]);
  const entries = Object.entries(value);
  return Buffer.concat([
    control(7, entries.length),
    ...entries.flatMap(([key, item]) => [encode(key), encode(item)]),
  ]);
}

function control(type: number, size: number): Buffer {
  if (size < 29) return Buffer.from([(type << 5) | size]);
  return Buffer.from([(type << 5) | 29, size - 29]);
}
