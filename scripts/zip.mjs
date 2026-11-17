import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// a small ZIP writer and reader, enough for one plugin archive and for the tests that read it back. The archive is
// reproducible (sorted names, a fixed timestamp, fixed attributes), holds regular files only, names are UTF-8 with `/`.

const dosTime = 0; // 00:00:00
const dosDate = (1 << 5) | 1; // 1980-01-01
const unixFile = (0o100644 << 16) >>> 0;

/** `entries`: [{ name, bytes }] -> a Buffer holding the ZIP. */
export function writeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, bytes } of sorted) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(bytes, { level: 9 });
    const stored = packed.length >= bytes.length;
    const body = stored ? bytes : packed;
    const method = stored ? 0 : 8;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(unixFile, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Reads the central directory of a ZIP and inflates every entry, checking its CRC and its sizes. Returns
 * `{ entries: [{ name, bytes, compressed, method, mode }] }`; throws on anything that is not a well-formed archive.
 */
export function readZip(buffer) {
  let end = -1;

  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP: no end-of-central-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("not a ZIP: bad central directory entry");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const mode = buffer.readUInt32LE(at + 38) >>> 16;
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);

    if (flags & 1) throw new Error(`${name}: encrypted entries are not supported`);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(dataAt, dataAt + compressed);
    const bytes = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;

    if (bytes === null) throw new Error(`${name}: unsupported compression method ${method}`);
    if (bytes.length !== size) throw new Error(`${name}: size does not match its header`);
    if (crc32(bytes) !== crc) throw new Error(`${name}: CRC does not match`);
    entries.push({ name, bytes, compressed, method, mode });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries };
}
