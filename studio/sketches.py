"""SolidCraft-Skizzen als 3D-Linienzüge für die Tablet-Ansicht.

Der GLB-Export enthält nur Körper. Die Skizzen holt das Studio deshalb mit dem rein lesenden Befehl
`sketch.inspect` (Ebene + Kurven in Skizzenkoordinaten) und rechnet sie hier in Weltkoordinaten
(mm, Z oben) um. Kreise, Bögen, Ellipsen, Kegelschnitte und Splines werden als Polylinie abgetastet.
"""
from __future__ import annotations

import math
from typing import Any

Vec2 = tuple[float, float]
Vec3 = list[float]

SEGMENTS_FULL = 72  # Abtastung eines Vollkreises


def _world(plane: dict, p: Vec2) -> Vec3:
    o, x, y = plane["origin"], plane["x_dir"], plane["y_dir"]
    return [round(o[i] + p[0] * x[i] + p[1] * y[i], 4) for i in range(3)]


def _arc(c: Vec2, r: float, a0: float, sweep: float) -> list[Vec2]:
    n = max(2, math.ceil(abs(sweep) / (2 * math.pi) * SEGMENTS_FULL))
    return [(c[0] + r * math.cos(a0 + sweep * i / n), c[1] + r * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]


def curve_points(cv: dict[str, Any]) -> list[Vec2]:
    """Eine Kurve aus `sketch.inspect` als Punktfolge in Skizzenkoordinaten (leer, wenn unbekannt)."""
    t = cv.get("type")
    if t == "line" and cv.get("start_at") and cv.get("end_at"):
        return [tuple(cv["start_at"]), tuple(cv["end_at"])]
    if t == "circle" and cv.get("center_at"):
        return _arc(tuple(cv["center_at"]), float(cv["radius"]), 0.0, 2 * math.pi)
    if t == "arc" and cv.get("center_at") and cv.get("start_at") and cv.get("end_at"):
        c, s, e = cv["center_at"], cv["start_at"], cv["end_at"]
        r = cv.get("radius") or math.hypot(s[0] - c[0], s[1] - c[1])
        a0 = math.atan2(s[1] - c[1], s[0] - c[0])
        a1 = math.atan2(e[1] - c[1], e[0] - c[0])
        sweep = (a1 - a0) % (2 * math.pi) or 2 * math.pi  # gegen den Uhrzeigersinn von Start nach Ende
        return _arc(tuple(c), float(r), a0, sweep)
    if t == "ellipse" and cv.get("center_at") and cv.get("major_at"):
        c, m = cv["center_at"], cv["major_at"]
        ax, ay = m[0] - c[0], m[1] - c[1]
        ra = math.hypot(ax, ay) or 1e-9
        rb = float(cv.get("minor_radius") or 0)
        ux, uy = ax / ra, ay / ra
        pts = []
        for i in range(SEGMENTS_FULL + 1):
            t_ = 2 * math.pi * i / SEGMENTS_FULL
            u, v = ra * math.cos(t_), rb * math.sin(t_)
            pts.append((c[0] + u * ux - v * uy, c[1] + u * uy + v * ux))
        return pts
    if t == "conic" and cv.get("start_at") and cv.get("end_at") and cv.get("apex_at"):
        # Rationale quadratische Bézierkurve, Gewicht der Spitze aus rho.
        p0, p1, p2 = cv["start_at"], cv["apex_at"], cv["end_at"]
        rho = min(max(float(cv.get("rho") or 0.5), 1e-3), 0.999)
        w = rho / (1 - rho)
        pts = []
        for i in range(25):
            u = i / 24
            b0, b1, b2 = (1 - u) ** 2, 2 * u * (1 - u) * w, u * u
            d = b0 + b1 + b2
            pts.append(((b0 * p0[0] + b1 * p1[0] + b2 * p2[0]) / d, (b0 * p0[1] + b1 * p1[1] + b2 * p2[1]) / d))
        return pts
    if t == "spline":
        pts = [tuple(p) for p in cv.get("points_at") or [] if p]
        if cv.get("periodic") and pts:
            pts.append(pts[0])
        return pts  # Näherung: Polylinie durch die Stütz- bzw. Kontrollpunkte
    return []


def sketch_polylines(si: dict[str, Any]) -> list[dict[str, Any]]:
    """Alle Kurven einer Skizze als Weltkoordinaten-Linienzüge."""
    plane = si.get("plane")
    if not plane:
        return []
    out = []
    for cv in si.get("curves") or []:
        pts = curve_points(cv)
        if len(pts) >= 2:
            out.append({"pts": [_world(plane, p) for p in pts], "construction": bool(cv.get("construction"))})
    return out
