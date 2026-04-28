with open('src/simulation.ts', 'r') as f:
    src = f.read()

old = '''      const yTextBase = showLabels ? yTextZoom : yTextNormal;
      const yTextAdj = yTextBase + (m.runKm ? 14 : 0); // légère alternance pour réduire les collisions
      const yTextS = yTextAdj.toFixed(1);
      const bgX = (-approxW / 2).toFixed(0);
      const bgY = (-(labelFs + labelBgPadY + 2)).toFixed(0);

      if (showLabels) {
        // Zoom : horizontal.
        return `<g transform="translate(${xS} ${yTextS})">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.86)"/>
  <text x="0" y="0" text-anchor="middle" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.88)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;
      }

      // Normal : vertical (rotation autour du point d'ancrage).
      return `<g transform="rotate(-90 ${xS} ${yTextS}) translate(${xS} ${yTextS})">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.82)"/>
  <text x="0" y="0" text-anchor="middle" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.82)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;'''

new = '''      if (showLabels) {
        // Zoom : horizontal, centré.
        const yTextS = yTextZoom.toFixed(1);
        const bgX = (-approxW / 2).toFixed(0);
        const bgY = (-(labelFs + labelBgPadY + 2)).toFixed(0);
        return `<g transform="translate(${xS} ${yTextS})">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.86)"/>
  <text x="0" y="0" text-anchor="middle" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.88)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;
      }

      // Normal : vertical — translate(xS, yTextNormal) rotate(-90).
      // Dans ce repère, l'axe x local pointe vers le haut de l'écran.
      // text-anchor="end" -> le texte s'étend vers le haut (x<0), entièrement dans la marge.
      const yTextS = yTextNormal.toFixed(1);
      const bgX = (-approxW).toFixed(0);
      const bgY = (-(labelFs + labelBgPadY)).toFixed(0);
      return `<g transform="translate(${xS} ${yTextS}) rotate(-90)">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.82)"/>
  <text x="0" y="0" text-anchor="end" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.82)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;'''

if old in src:
    src = src.replace(old, new, 1)
    with open('src/simulation.ts', 'w') as f:
        f.write(src)
    print("OK: replacement done")
else:
    print("ERROR: old block not found")
    idx = src.find('const yTextBase')
    if idx >= 0:
        print(repr(src[idx:idx+600]))
