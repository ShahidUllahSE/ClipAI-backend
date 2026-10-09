import { once } from 'events'
import fs from 'fs'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c >>> 0
}

function crc32Update(crc: number, chunk: Buffer) {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u16(value: number) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value, 0)
  return buf
}

function u32(value: number) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function encodeName(name: string) {
  return Buffer.from(name.replace(/[/\\]/g, '-').slice(0, 120), 'utf8')
}

interface ZipEntry {
  name: Buffer
  crc: number
  size: number
  offset: number
}

export async function streamStoredZip(
  files: Array<{ name: string; path: string }>,
  output: NodeJS.WritableStream,
) {
  let offset = 0
  const entries: ZipEntry[] = []

  const write = async (chunk: Buffer) => {
    offset += chunk.length
    if (!output.write(chunk)) await once(output, 'drain')
  }

  for (const file of files) {
    const name = encodeName(file.name)
    const localOffset = offset
    await write(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        u16(20),
        u16(8),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(0),
        u32(0),
        u16(name.length),
        u16(0),
        name,
      ]),
    )

    let crc = 0
    let size = 0
    const input = fs.createReadStream(file.path)
    for await (const chunk of input) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      crc = crc32Update(crc, buf)
      size += buf.length
      await write(buf)
    }

    await write(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x07, 0x08]),
        u32(crc),
        u32(size),
        u32(size),
      ]),
    )
    entries.push({ name, crc, size, offset: localOffset })
  }

  const centralStart = offset
  for (const entry of entries) {
    await write(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(8),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.crc),
        u32(entry.size),
        u32(entry.size),
        u16(entry.name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(entry.offset),
        entry.name,
      ]),
    )
  }

  await write(
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(offset - centralStart),
      u32(centralStart),
      u16(0),
    ]),
  )
}
