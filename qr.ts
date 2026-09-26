// RS block groups at ECC level L per version: [block count, data codewords, EC codewords].
// Versions 1-5 use one block; versions 6+ split the data across blocks that are
// encoded and interleaved independently (ISO/IEC 18004 Table 9).
const RS_BLOCKS_L: Array<Array<[count: number, dataCodewords: number, ecCodewords: number]>> = [
  [[1, 19, 7]],
  [[1, 34, 10]],
  [[1, 55, 15]],
  [[1, 80, 20]],
  [[1, 108, 26]],
  [[2, 68, 18]],
  [[2, 78, 20]],
  [[2, 97, 24]],
  [[2, 116, 30]],
  [
    [2, 68, 18],
    [2, 69, 18],
  ],
]
const ECC_LEVEL_BITS = 1

// Alignment pattern center coordinates per version (ISO/IEC 18004 Annex E).
const ALIGNMENT_POSITIONS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255])

function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i])
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree).reverse()
  const res = new Uint8Array(data.length + degree)
  res.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (coef === 0) continue
    for (let j = 1; j < gen.length; j++) res[i + j] ^= mul(gen[j], coef)
  }
  return res.slice(data.length)
}

function encodeData(text: string, dataCodewords: number, countBits: number): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  let bits = "0100" + bytes.length.toString(2).padStart(countBits, "0")
  for (const b of bytes) bits += b.toString(2).padStart(8, "0")
  const capacity = dataCodewords * 8
  bits += "0".repeat(Math.min(4, capacity - bits.length))
  bits += "0".repeat((8 - (bits.length % 8)) % 8)
  const out = new Uint8Array(dataCodewords)
  for (let i = 0; i < Math.floor(bits.length / 8); i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  const pad = [0xec, 0x11]
  let idx = 0
  for (let i = Math.floor(bits.length / 8); i < dataCodewords; i++) out[i] = pad[idx++ % 2]
  return out
}

const matrixSize = (v: number) => 17 + 4 * v

function isFunctionModule(v: number, row: number, col: number): boolean {
  const size = matrixSize(v)
  const tl = row < 9 && col < 9
  const tr = row < 9 && col >= size - 8
  const bl = row >= size - 8 && col < 9
  if (tl || tr || bl) return true
  if (row === 6 || col === 6) return true
  const positions = ALIGNMENT_POSITIONS[v - 1]
  for (const centerRow of positions) {
    for (const centerCol of positions) {
      // Patterns overlapping a finder are omitted entirely; their area stays data.
      const overlapsFinder =
        (centerRow === 6 && centerCol === 6) ||
        (centerRow === 6 && centerCol === size - 7) ||
        (centerRow === size - 7 && centerCol === 6)
      if (overlapsFinder) continue
      if (Math.abs(row - centerRow) <= 2 && Math.abs(col - centerCol) <= 2) return true
    }
  }
  if (v >= 7) {
    if (row < 6 && col >= size - 11 && col <= size - 9) return true
    if (col < 6 && row >= size - 11 && row <= size - 9) return true
  }
  return false
}

function buildFormatBits(ecc: number, mask: number): number {
  const data = (ecc << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function buildVersionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25)
  return (version << 12) | rem
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
  return false
}

function maskPenalty(m: boolean[][]): number {
  const size = m.length
  let result = 0
  const runScore = (arr: boolean[]) => {
    let run = 1
    for (let i = 1; i <= arr.length; i++) {
      if (i < arr.length && arr[i] === arr[i - 1]) {
        run++
      } else {
        if (run >= 5) result += 3 + (run - 5)
        run = 1
      }
    }
  }
  for (const row of m) runScore(row)
  for (let c = 0; c < size; c++) {
    const col: boolean[] = []
    for (let r = 0; r < size; r++) col.push(m[r][c])
    runScore(col)
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) result += 3
    }
  }
  const patternA = [true, false, true, true, true, false, true, false, false, false, false]
  const patternB = [false, false, false, false, true, false, true, true, true, false, true]
  const finderPenalty = (arr: boolean[]) => {
    let count = 0
    for (let i = 0, j = arr.length - 11; i < j; i++) {
      const matchA = patternA.every((x, k) => arr[i + k] === x)
      const matchB = patternB.every((x, k) => arr[i + k] === x)
      if (matchA || matchB) {
        const left = i - 4 >= 0 && arr.slice(i - 4, i).every((x) => !x)
        const right = i + 15 <= arr.length && arr.slice(i + 11, i + 15).every((x) => !x)
        if (left || right) count++
      }
    }
    return count * 40
  }
  for (const row of m) result += finderPenalty(row)
  for (let c = 0; c < size; c++) {
    const col: boolean[] = []
    for (let r = 0; r < size; r++) col.push(m[r][c])
    result += finderPenalty(col)
  }
  let dark = 0
  for (const row of m) for (const cell of row) if (cell) dark++
  const percent = (dark * 100) / (size * size)
  result += Math.floor(Math.abs(percent - 50) / 5) * 10
  return result
}

function buildMatrix(version: number, codewords: Uint8Array, mask: number): boolean[][] {
  const size = matrixSize(version)
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (r: number, c: number, dark: boolean) => (m[r][c] = dark)
  const drawFinder = (row: number, col: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= size || c < 0 || c >= size) continue
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        set(r, c, inside && (border || core))
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) {
    if (i % 2 === 0) {
      set(6, i, true)
      set(i, 6, true)
    }
  }
  const positions = ALIGNMENT_POSITIONS[version - 1]
  for (const centerRow of positions) {
    for (const centerCol of positions) {
      const overlapsFinder =
        (centerRow === 6 && centerCol === 6) ||
        (centerRow === 6 && centerCol === size - 7) ||
        (centerRow === size - 7 && centerCol === 6)
      if (overlapsFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isCenter = dr === 0 && dc === 0
          const isRing = Math.abs(dr) === 2 || Math.abs(dc) === 2
          set(centerRow + dr, centerCol + dc, isCenter || isRing)
        }
      }
    }
  }
  if (version >= 7) {
    const versionBits = buildVersionBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >> i) & 1) === 1
      set(Math.floor(i / 3), size - 11 + (i % 3), dark)
      set(size - 11 + (i % 3), Math.floor(i / 3), dark)
    }
  }
  const bits = buildFormatBits(ECC_LEVEL_BITS, mask)
  const bit = (i: number) => ((bits >> (14 - i)) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true)
  let bitIndex = 0
  let upward = true
  let col = size - 1
  while (col > 0) {
    if (col === 6) col--
    for (let row = upward ? size - 1 : 0; upward ? row >= 0 : row < size; row += upward ? -1 : 1) {
      for (let d = 0; d < 2; d++) {
        const c = col - d
        if (c < 0 || isFunctionModule(version, row, c)) continue
        const byte = codewords[Math.floor(bitIndex / 8)]
        let dark = ((byte >> (7 - (bitIndex % 8))) & 1) === 1
        if (maskCondition(mask, row, c)) dark = !dark
        set(row, c, dark)
        bitIndex++
      }
    }
    upward = !upward
    col -= 2
  }
  return m
}

const totalDataCodewords = (version: number) =>
  RS_BLOCKS_L[version - 1].reduce((sum, [count, dataCodewords]) => sum + count * dataCodewords, 0)

function chooseVersion(len: number): number {
  for (let v = 1; v <= RS_BLOCKS_L.length; v++) {
    // Byte-mode character count is 8 bits up to version 9 and 16 bits from version 10.
    const countBits = v >= 10 ? 16 : 8
    if (len <= totalDataCodewords(v) - (4 + countBits) / 8) return v
  }
  throw new Error(`Content is too long for a QR code (${len} bytes)`)
}

// Split the data codewords into blocks, compute one EC sequence per block, then
// interleave both sequences block-by-block as the decoder expects.
function interleave(data: Uint8Array, groups: Array<[number, number, number]>): Uint8Array {
  const blocks: Array<{ data: Uint8Array; ec: Uint8Array }> = []
  let offset = 0
  for (const [count, dataCodewords, ecCodewords] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + dataCodewords)
      offset += dataCodewords
      blocks.push({ data: block, ec: rsEncode(block, ecCodewords) })
    }
  }
  const out: number[] = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  const maxEc = Math.max(...blocks.map((block) => block.ec.length))
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  for (let i = 0; i < maxEc; i++) for (const block of blocks) if (i < block.ec.length) out.push(block.ec[i])
  return new Uint8Array(out)
}

export function makeQR(text: string): boolean[][] {
  const len = new TextEncoder().encode(text).length
  const version = chooseVersion(len)
  const data = encodeData(text, totalDataCodewords(version), version >= 10 ? 16 : 8)
  const codewords = interleave(data, RS_BLOCKS_L[version - 1])
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, codewords, mask)
    const score = maskPenalty(m)
    if (score < bestScore) {
      bestScore = score
      best = m
    }
  }
  return best!
}

export function renderQR(m: boolean[][]): string {
  const size = m.length
  const lines: string[] = []
  for (let r = 0; r < size; r += 2) {
    let line = ""
    for (let c = 0; c < size; c++) {
      const top = m[r][c]
      const bottom = r + 1 < size ? m[r + 1][c] : false
      if (top && bottom) line += "█"
      else if (top) line += "▀"
      else if (bottom) line += "▄"
      else line += " "
    }
    lines.push(line)
  }
  return lines.join("\n")
}
