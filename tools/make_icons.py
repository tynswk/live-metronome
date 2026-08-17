# アイコン生成（依存ライブラリなし・標準ライブラリのみ）
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
BG = (0x0b, 0x0b, 0x0d)
RING = (0x1f, 0x6f, 0xeb)
ACC = (0xff, 0x3b, 0x30)
DOT = (0xe9, 0xe9, 0xec)


def render(size, ss=3):
    n = size * ss
    px = [[BG for _ in range(n)] for _ in range(n)]
    c = n / 2.0
    r_ring = n * 0.33
    w_ring = n * 0.055
    r_dot = n * 0.062
    r_acc = n * 0.095

    def put(x, y, col):
        if 0 <= x < n and 0 <= y < n:
            px[y][x] = col

    for y in range(n):
        for x in range(n):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            d = math.hypot(dx, dy)
            if abs(d - r_ring) <= w_ring / 2:
                put(x, y, RING)

    # 12時＝アクセント、3/6/9時＝通常拍
    marks = [(-math.pi / 2, ACC, r_acc), (0, DOT, r_dot),
             (math.pi / 2, DOT, r_dot), (math.pi, DOT, r_dot)]
    for ang, col, rr in marks:
        mx, my = c + r_ring * math.cos(ang), c + r_ring * math.sin(ang)
        for y in range(int(my - rr) - 1, int(my + rr) + 2):
            for x in range(int(mx - rr) - 1, int(mx + rr) + 2):
                if math.hypot(x + 0.5 - mx, y + 0.5 - my) <= rr:
                    put(x, y, col)

    # ダウンサンプル
    out = bytearray()
    for y in range(size):
        out.append(0)
        for x in range(size):
            r = g = b = 0
            for j in range(ss):
                row = px[y * ss + j]
                for i in range(ss):
                    p = row[x * ss + i]
                    r += p[0]; g += p[1]; b += p[2]
            k = ss * ss
            out += bytes((r // k, g // k, b // k))
    return bytes(out)


def png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    hdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", hdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


os.makedirs(OUT, exist_ok=True)
for s in (180, 192, 512):
    png(os.path.join(OUT, "icon-%d.png" % s), s, render(s))
    print("icons/icon-%d.png" % s)
