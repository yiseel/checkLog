// PWA·파비콘용 PNG 아이콘 생성 (public/favicon.svg 와 같은 그림).
// 외부 패키지 없이 node 만으로 실행: node scripts/make-pwa-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const BG = [0x2f, 0x6b, 0x80]
const PAPER = [0xfb, 0xfa, 0xf2]
const DASH = [0xa3, 0xcc, 0xda]

/* ---------- 도형 판정 (64×64 좌표계, favicon.svg 와 같은 값) ---------- */
function inRoundRect(x, y, rx, ry, w, h, r) {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r)
  const cy = Math.min(Math.max(y, ry + r), ry + h - r)
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h && Math.hypot(x - cx, y - cy) <= r
}
const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r
function distSeg(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

/** 한 점의 색 (위에 그린 것이 우선). null 이면 투명 */
function colorAt(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 14)) return null
  // 체크 표시: M21.5 29.5 l6 6 l13 -13, 굵기 5
  if (Math.min(distSeg(x, y, 21.5, 29.5, 27.5, 35.5), distSeg(x, y, 27.5, 35.5, 40.5, 22.5)) <= 2.5) return BG
  // 점선: y=44, x 22~26 / 30~34 / 38~42, 굵기 2
  for (const sx of [22, 30, 38]) if (distSeg(x, y, sx, 44, sx + 4, 44) <= 1) return DASH
  // 메모지 위 구멍
  if (inCircle(x, y, 24, 12, 3) || inCircle(x, y, 40, 12, 3)) return BG
  if (inRoundRect(x, y, 14, 12, 36, 40, 6)) return PAPER
  return BG
}

/* ---------- PNG 인코딩 ---------- */
function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const name = Buffer.from(type)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, crc])
}

const SS = 4 // 4×4 슈퍼샘플링으로 가장자리 부드럽게
function png(size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  const k = 64 / size
  for (let py = 0; py < size; py++) {
    raw[py * stride] = 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k)
          if (!c) continue
          r += c[0]; g += c[1]; b += c[2]; a += 1
        }
      }
      const i = py * stride + 1 + px * 4
      raw[i] = a ? Math.round(r / a) : 0
      raw[i + 1] = a ? Math.round(g / a) : 0
      raw[i + 2] = a ? Math.round(b / a) : 0
      raw[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const out = new URL('../public/', import.meta.url)
for (const [name, size] of [
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  writeFileSync(new URL(name, out), png(size))
  console.log('wrote', name)
}
