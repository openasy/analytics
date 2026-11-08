// Writes a small MaxMind DB (MMDB) file for tests: IPv4 networks with a record each, in the format DB-IP's city file
// uses, so the GeoIP code is tested with the real reader without downloading anything.

type Value = string | number | boolean | Value[] | { [k: string]: Value };

function control(type: number, size: number): Buffer {
  const head = (t: number, s: number) => (t <= 7 ? Buffer.from([(t << 5) | s]) : Buffer.from([s, t - 7]));
  if (size < 29) return head(type, size);
  if (size < 285) return Buffer.concat([head(type, 29), Buffer.from([size - 29])]);
  const n = size - 285;
  return Buffer.concat([head(type, 30), Buffer.from([n >> 8, n & 255])]);
}

function uint(type: number, n: number): Buffer {
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.concat([control(type, bytes.length), Buffer.from(bytes)]);
}

function encode(v: Value): Buffer {
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([control(2, b.length), b]);
  }
  if (typeof v === "boolean") return control(14, v ? 1 : 0);
  if (typeof v === "number") return uint(6, v);
  if (Array.isArray(v)) return Buffer.concat([control(11, v.length), ...v.map(encode)]);
  const entries = Object.entries(v);
  return Buffer.concat([control(7, entries.length), ...entries.flatMap(([k, x]) => [encode(k), encode(x)])]);
}

/** An MMDB file of IPv4 networks such as 203.0.113.0/24, each with its record. */
export function writeMmdb(networks: Array<[string, Value]>, databaseType = "DBIP-City-Lite"): Buffer {
  type Child = number | { data: number } | null;
  const nodes: Array<[Child, Child]> = [[null, null]];
  const data: Buffer[] = [];
  let offset = 0;
  for (const [cidr, record] of networks) {
    const [ip, bits] = cidr.split("/");
    const n = Number(bits);
    const addr = ip!.split(".").reduce((a, o) => a * 256 + Number(o), 0);
    const encoded = encode(record);
    data.push(encoded);
    const at = offset;
    offset += encoded.length;
    let node = 0;
    for (let i = 0; i < n; i++) {
      const bit = Math.floor(addr / 2 ** (31 - i)) % 2;
      if (i === n - 1) nodes[node]![bit] = { data: at };
      else {
        let next = nodes[node]![bit];
        if (typeof next !== "number") {
          next = nodes.length;
          nodes.push([null, null]);
          nodes[node]![bit] = next;
        }
        node = next;
      }
    }
  }
  const count = nodes.length;
  const tree = Buffer.alloc(count * 8);
  nodes.forEach(([l, r], i) => {
    const value = (c: Child) => (c === null ? count : typeof c === "number" ? c : count + 16 + c.data);
    tree.writeUInt32BE(value(l), i * 8);
    tree.writeUInt32BE(value(r), i * 8 + 4);
  });
  const meta = Buffer.concat([
    control(7, 9),
    encode("node_count"),
    uint(6, count),
    encode("record_size"),
    uint(5, 32),
    encode("ip_version"),
    uint(5, 4),
    encode("database_type"),
    encode(databaseType),
    encode("languages"),
    encode(["en"]),
    encode("binary_format_major_version"),
    uint(5, 2),
    encode("binary_format_minor_version"),
    uint(5, 0),
    encode("build_epoch"),
    Buffer.concat([control(9, 4), Buffer.from([0x69, 0x00, 0x00, 0x00])]),
    encode("description"),
    encode({ en: "test" }),
  ]);
  return Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com"), meta]);
}

/** A DB-IP city record. */
export const city = (country: string, region: string, name: string) => ({
  city: { names: { en: name } },
  country: { iso_code: country, names: { en: country } },
  location: { latitude: 1, longitude: 2 },
  subdivisions: [{ names: { en: region } }],
});
