#!/usr/bin/env python3
"""Draws the pixel landscape for the title screen -> public/img/title-scene.svg (pure rects, no assets needed)."""
import math, os, random
random.seed(7)
W, H = 240, 90
rects = []
def R(x, y, w, h, c): rects.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{c}"/>')

def hills(base, amp, freq, phase, color, top=None):
    for x in range(W):
        h = int(base + amp * math.sin(x * freq + phase) + amp * 0.5 * math.sin(x * freq * 2.3 + phase * 1.7))
        R(x, H - h, 1, h, color)
        if top: R(x, H - h, 1, 1, top)

# moon
for dy in range(-6, 7):
    for dx in range(-6, 7):
        if dx * dx + dy * dy <= 36 and not ((dx - 3) ** 2 + (dy + 1) ** 2 <= 30):
            R(190 + dx, 12 + dy, 1, 1, '#fff1a8')
hills(34, 8, 0.045, 0.5, '#2c3b7a')
hills(24, 7, 0.06, 2.0, '#1f5a4a', '#2b7d5d')
hills(14, 5, 0.08, 4.1, '#2f8f3f', '#4cc95a')
# trees on the mid layer
def tree(x, y):
    R(x + 2, y + 5, 2, 4, '#5a3418')
    R(x, y + 2, 6, 3, '#1d6b2c'); R(x + 1, y, 4, 2, '#2f9e44'); R(x + 2, y - 2, 2, 2, '#4cc95a')
for tx in (22, 48, 96, 131, 160):
    ground = H - int(14 + 5 * math.sin(tx * 0.08 + 4.1) + 2.5 * math.sin(tx * 0.08 * 2.3 + 4.1 * 1.7))
    tree(tx, ground - 9)
# dotted path to the chest
px, py = 14, H - 7
pts = []
for i in range(0, 17):
    t = i / 16
    x = int(14 + t * 190)
    y = int(H - 8 - 6 * math.sin(t * math.pi * 1.6) - t * 4)
    pts.append((x, y))
for i, (x, y) in enumerate(pts):
    if i % 2 == 0: R(x, y, 3, 2, '#ffcc33')
# X marks the spot + chest
cx, cy = 214, H - 15
for i in range(7):
    R(cx - 8 + i, cy + 8 + i // 2, 1, 1, '#d1117c'); R(cx - 2 - i, cy + 8 + i // 2, 1, 1, '#d1117c')
chest = [
 '..DDDDDDDD..', '.DLLLLLLLLD.', 'DLLLLLLLLLLD', 'DDDDDDDDDDDD', 'DWWWWYYWWWWD', 'DWWWWYYWWWWD', 'DWWWWWWWWWWD', 'DDDDDDDDDDDD']
col = {'D': '#3b2412', 'W': '#a8672b', 'L': '#d99a4c', 'Y': '#ffcc33'}
for r, row in enumerate(chest):
    for c, ch in enumerate(row):
        if ch != '.': R(cx - 6 + c, cy + r, 1, 1, col[ch])
for sx, sy in ((cx - 9, cy - 4), (cx + 8, cy - 6), (cx - 2, cy - 8)):
    R(sx, sy, 1, 3, '#fff1a8'); R(sx - 1, sy + 1, 3, 1, '#fff1a8')
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" shape-rendering="crispEdges" preserveAspectRatio="xMidYMax slice">' + ''.join(rects) + '</svg>'
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'title-scene.svg')
open(out, 'w').write(svg)
print('wrote', os.path.abspath(out), len(svg), 'bytes')
