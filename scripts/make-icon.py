"""Genera el icono propio de NoDiscNoLive (disco + pulso de diagnóstico) -> assets/logo.png y build/icon.ico"""
from PIL import Image, ImageDraw
import math, os
S = 1024
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# fondo: cuadrado redondeado con degradado
bg = Image.new('RGBA', (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        px[x, y] = (int(14 + 20 * t), int(22 + 40 * t), int(46 + 70 * t), 255)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((24, 24, S - 24, S - 24), radius=210, fill=255)
img.paste(bg, (0, 0), mask)
d = ImageDraw.Draw(img)
c = (S // 2, S // 2 - 20)
# plato del disco
for r, col in [(380, (38, 52, 84)), (360, (70, 130, 220)), (340, (24, 34, 60))]:
    d.ellipse((c[0] - r, c[1] - r, c[0] + r, c[1] + r), fill=col)
for r in (300, 255, 210):
    d.ellipse((c[0] - r, c[1] - r, c[0] + r, c[1] + r), outline=(52, 74, 120), width=6)
d.ellipse((c[0] - 105, c[1] - 105, c[0] + 105, c[1] + 105), fill=(76, 154, 255))
d.ellipse((c[0] - 38, c[1] - 38, c[0] + 38, c[1] + 38), fill=(14, 22, 46))
# brazo de lectura
d.line([(c[0] + 330, c[1] + 330), (c[0] + 120, c[1] + 60)], fill=(220, 228, 245), width=26)
d.ellipse((c[0] + 300, c[1] + 300, c[0] + 372, c[1] + 372), fill=(220, 228, 245))
# pulso de diagnóstico
pts = [(110, 800), (330, 800), (400, 690), (480, 905), (570, 640), (650, 800), (914, 800)]
d.line(pts, fill=(56, 214, 130), width=46, joint='curve')
for p in (pts[0], pts[-1]):
    d.ellipse((p[0] - 23, p[1] - 23, p[0] + 23, p[1] + 23), fill=(56, 214, 130))
img.save(os.path.join(root, 'assets', 'logo.png'))
img.resize((512, 512), Image.LANCZOS).save(os.path.join(root, 'build', 'icon.png'))
img.save(os.path.join(root, 'build', 'icon.ico'), sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(128,128),(256,256)])
print('ok')
