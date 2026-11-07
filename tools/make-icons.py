#!/usr/bin/env python3
"""生成 TabDock 的扩展图标（纯标准库写 PNG，无 Pillow 依赖）。

设计：紫色圆角底 + 三个白色标签条，最上面一条高亮（代表当前标签）。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int, pixels) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(pixels[x, y])
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(data)


def in_round_rect(x: float, y: float, w: float, h: float, r: float) -> bool:
    if x < 0 or y < 0 or x > w or y > h:
        return False
    if r <= 0:
        return True
    # 四角圆
    cx = r if x < r else (w - r if x > w - r else x)
    cy = r if y < r else (h - r if y > h - r else y)
    if cx == x and cy == y:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def make_icon(size: int):
    """返回 {(x,y): (r,g,b,a)}"""
    px = {}
    r_corner = size * 0.23

    # 三条标签条：顶部高亮条 + 两条稍暗
    bars = [
        (0.235, 0.255, (255, 255, 255, 255)),   # y比例, 高比例, 颜色
        (0.435, 0.185, (255, 255, 255, 205)),
        (0.675, 0.125, (255, 255, 255, 165)),
    ]
    bar_x0 = size * 0.20
    bar_w = size * 0.60

    for y in range(size):
        for x in range(size):
            if not in_round_rect(x + 0.5, y + 0.5, size, size, r_corner):
                px[x, y] = (0, 0, 0, 0)
                continue

            # 竖向渐变：上浅紫 → 下深紫
            t = y / max(1, size - 1)
            r = int(124 - 46 * t)
            g = int(108 - 48 * t)
            b = int(246 - 30 * t)
            col = (r, g, b, 255)

            # 叠加标签条
            for (by, bh, bcol) in bars:
                y0 = size * by
                y1 = y0 + size * bh
                if y0 <= y < y1 and bar_x0 <= x < bar_x0 + bar_w:
                    # 简易圆角：条两端各让出半个条高
                    rr = (y1 - y0) / 2
                    if x < bar_x0 + rr:
                        if (x - (bar_x0 + rr)) ** 2 + (y + 0.5 - (y0 + y1) / 2) ** 2 > rr * rr:
                            continue
                    if x > bar_x0 + bar_w - rr:
                        if (x - (bar_x0 + bar_w - rr)) ** 2 + (y + 0.5 - (y0 + y1) / 2) ** 2 > rr * rr:
                            continue
                    col = bcol
                    break

            px[x, y] = col
    return px


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        p = make_icon(size)
        out = os.path.abspath(os.path.join(OUT_DIR, f"icon{size}.png"))
        write_png(out, size, p)
        print(f"wrote {out}  ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
