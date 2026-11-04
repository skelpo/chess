"""Generate the tuichess 3D chess pieces as animation- and texture-ready GLB files.

Run headless:

    blender -b --factory-startup --python web3d/models/pieces.py -- \
        --out web3d/public/models [--preview preview.png] [--blend pieces.blend]

Conventions (shared by the Three.js web version and the Bloom engine):

* 1 unit = 1 board square. Y-up in glTF, origin at the center of the base,
  the piece stands on y = 0. The front of a piece (the knight's muzzle) faces +Z.
* One mesh per piece, skinned to three bones in a chain: root -> body -> head.
  Bones only, no morph targets (Bloom does not play morph targets yet).
  Every vertex has at most 2 non-zero weights (Bloom/Three allow 4).
* Two materials: "Body" (white base color, tint at runtime or swap textures)
  and "Felt" (the underside). UV0 is a non-overlapping atlas in [0,1]^2 with
  islands at a uniform texel density, so baked/painted textures can be added
  later without touching the meshes. Tangents are exported for normal maps.
* Named animation clips (NLA tracks): idle, select, hop, captured, celebrate.
  Clip timing that game code needs (hop takeoff/landing) is exported in the
  armature node's extras as "tuichess".
"""

import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector, Quaternion

FPS = 30
SEGMENTS = 40          # around the axis
MAX_SEG = 0.024        # max profile segment length -> evenly spaced deformation rings
SHARP_DEG = 38.0       # profile corners sharper than this become hard edges + UV seams

# ---------------------------------------------------------------------------
# Profile helpers. A profile is a list of (r, z) points from the bottom center
# (r = 0, z = 0) around the outside to the top center (r = 0).


def arc(cx, cz, rad, a0, a1, n=10):
    pts = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        pts.append((cx + rad * math.cos(a), cz + rad * math.sin(a)))
    return pts


def spline(ctrl, n=8):
    """Centripetal-ish Catmull-Rom through ctrl points (endpoints included)."""
    if len(ctrl) < 3:
        return list(ctrl)
    p = [ctrl[0]] + list(ctrl) + [ctrl[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t +
                       (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
                       (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)
                for j in range(2)))
    out.append(ctrl[-1])
    return out


def base(R):
    """Shared Staunton-style foot: felt underside, rounded plinth, bead."""
    pts = [(0.0, 0.0), (R, 0.0), (R, 0.03)]
    pts += arc(R - 0.035, 0.03, 0.035, 0, 90, 6)[1:]          # rounded top edge
    pts += [(R - 0.05, 0.068)]
    pts += arc(R * 0.80, 0.088, 0.02, -90, 90, 8)              # bead
    return pts


def dedupe(pts):
    out = []
    for p in pts:
        if not out or (abs(p[0] - out[-1][0]) > 1e-5 or abs(p[1] - out[-1][1]) > 1e-5):
            out.append((max(0.0, p[0]), p[1]))
    return out


def corner_flags(pts):
    flags = [False] * len(pts)
    for i in range(1, len(pts) - 1):
        a = Vector((pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
        b = Vector((pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
        if a.length < 1e-9 or b.length < 1e-9:
            continue
        if math.degrees(a.angle(b)) > SHARP_DEG:
            flags[i] = True
    return flags


def resample(pts):
    """Insert points so no segment is longer than MAX_SEG; keep originals."""
    out = [pts[0]]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        d = math.dist(a, b)
        n = max(1, math.ceil(d / MAX_SEG))
        for k in range(1, n + 1):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


# ---------------------------------------------------------------------------
# Piece definitions. Heights: pawn .62, rook .74, knight .86, bishop .92,
# queen 1.06, king 1.2 (squares). Base radius .21 - .27.


def profile_pawn():
    R = 0.21
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.13, 0.135), (0.09, 0.2), (0.07, 0.28), (0.062, 0.33)])
    p += [(0.118, 0.345)] + arc(0.118, 0.36, 0.015, -90, 90, 6)[1:] + [(0.07, 0.375)]
    # head sphere: center (0, .475), radius .105, starting where r = .06
    a0 = math.degrees(math.asin(-0.6))
    p += arc(0.0, 0.475, 0.105, a0, 90, 16)
    return dedupe(p), 0.58


def profile_rook():
    R = 0.25
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.17, 0.14), (0.15, 0.25), (0.145, 0.4), (0.155, 0.5), (0.19, 0.555)])
    p += [(0.205, 0.565), (0.205, 0.64)]
    # top rim; inner cup floor at .6 (merlons sit on the rim, r .14 -> .205)
    p += [(0.14, 0.64), (0.14, 0.6), (0.0, 0.6)]
    return dedupe(p), 0.73


def profile_knight_base():
    R = 0.235
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.17, 0.13), (0.15, 0.17), (0.16, 0.19)])
    p += arc(0.16, 0.2, 0.012, -90, 90, 6)[1:]
    p += [(0.12, 0.215), (0.0, 0.215)]
    return dedupe(p)


def profile_bishop():
    R = 0.23
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.14, 0.14), (0.095, 0.25), (0.072, 0.4), (0.07, 0.47)])
    p += [(0.135, 0.49)] + arc(0.135, 0.503, 0.013, -90, 90, 6)[1:]
    p += [(0.09, 0.516), (0.075, 0.53)]
    # mitre
    p += spline([(0.075, 0.53), (0.11, 0.57), (0.128, 0.63), (0.115, 0.7), (0.07, 0.78), (0.02, 0.83)], 10)
    p += [(0.012, 0.835)]
    # finial ball
    p += arc(0.0, 0.865, 0.033, -70, 90, 10)
    return dedupe(p), 0.9


def profile_queen():
    R = 0.26
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.15, 0.14), (0.105, 0.26), (0.08, 0.45), (0.078, 0.58)])
    p += [(0.15, 0.6)] + arc(0.15, 0.614, 0.014, -90, 90, 6)[1:]
    p += [(0.1, 0.628), (0.085, 0.64)]
    p += spline([(0.085, 0.64), (0.1, 0.72), (0.135, 0.82), (0.165, 0.89)], 8)
    p += [(0.168, 0.9), (0.14, 0.905)]
    p += spline([(0.14, 0.905), (0.11, 0.94), (0.06, 0.968), (0.025, 0.975)], 6)
    p += arc(0.0, 1.0, 0.03, -55, 90, 10)
    return dedupe(p), 1.03


def profile_king():
    R = 0.27
    p = base(R)
    p += spline([(R * 0.80, 0.108), (0.155, 0.14), (0.11, 0.27), (0.085, 0.5), (0.083, 0.64)])
    p += [(0.16, 0.66)] + arc(0.16, 0.675, 0.015, -90, 90, 6)[1:]
    p += [(0.105, 0.69), (0.09, 0.7)]
    p += spline([(0.09, 0.7), (0.105, 0.79), (0.14, 0.89), (0.16, 0.95)], 8)
    p += [(0.165, 0.962), (0.145, 0.97)]
    p += spline([(0.145, 0.97), (0.1, 1.0), (0.05, 1.015), (0.04, 1.02)], 6)
    p += [(0.04, 1.045), (0.0, 1.045)]
    return dedupe(p), 1.2


# ---------------------------------------------------------------------------
# Mesh building


class Builder:
    """Accumulates verts/faces/uvs/material indices for one piece in a bmesh."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.islands = []          # list of lists of faces (for packing)

    def lathe(self, pts, felt_bottom=True):
        bm, uv = self.bm, self.uv
        flags = corner_flags(pts)
        # split into bands at sharp corners; resample each band
        bands, cur = [], [pts[0]]
        for i in range(1, len(pts)):
            cur.append(pts[i])
            if flags[i]:
                bands.append(cur)
                cur = [pts[i]]
        if len(cur) > 1:
            bands.append(cur)

        ring_cache = {}

        def ring(p):
            key = (round(p[0], 6), round(p[1], 6))
            if key in ring_cache:
                return ring_cache[key]
            r, z = p
            if r < 1e-6:
                v = bm.verts.new((0.0, 0.0, z))
                ring_cache[key] = [v] * SEGMENTS
            else:
                vs = []
                for j in range(SEGMENTS):
                    a = 2 * math.pi * j / SEGMENTS
                    # j = 0 at +Y (the back, since the front is -Y) so the UV seam is hidden
                    vs.append(bm.verts.new((r * math.sin(a), r * math.cos(a), z)))
                ring_cache[key] = vs
            return ring_cache[key]

        for bi, band in enumerate(bands):
            band = resample(band)
            is_bottom_cap = felt_bottom and bi == 0 and band[0][0] < 1e-6 and all(abs(p[1]) < 1e-6 for p in band)
            lengths = [0.0]
            for i in range(1, len(band)):
                lengths.append(lengths[-1] + math.dist(band[i - 1], band[i]))
            rmean = sum(p[0] for p in band) / len(band)
            circ = 2 * math.pi * max(rmean, 0.01)
            island = []
            for i in range(1, len(band)):
                ra, rb = ring(band[i - 1]), ring(band[i])
                for j in range(SEGMENTS):
                    j2 = (j + 1) % SEGMENTS
                    quad = [ra[j], ra[j2], rb[j2], rb[j]]
                    uvs = [(j / SEGMENTS, lengths[i - 1]), ((j + 1) / SEGMENTS, lengths[i - 1]),
                           ((j + 1) / SEGMENTS, lengths[i]), (j / SEGMENTS, lengths[i])]
                    # drop degenerate pole vertices -> triangles
                    vs, us = [], []
                    for v, t in zip(quad, uvs):
                        if v not in vs:
                            vs.append(v)
                            us.append(t)
                    if len(vs) < 3:
                        continue
                    try:
                        f = bm.faces.new(vs)
                    except ValueError:
                        continue
                    for loop, t in zip(f.loops, us):
                        if is_bottom_cap:
                            co = loop.vert.co
                            loop[uv].uv = (co.x, co.y)
                        else:
                            loop[uv].uv = (t[0] * circ, t[1])
                    f.material_index = 1 if is_bottom_cap else 0
                    island.append(f)
            self.islands.append(island)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    def add_mesh(self, mesh, matrix=Matrix.Identity(4)):
        """Append a Blender mesh (faces flagged for smart-project unwrap)."""
        tmp = bmesh.new()
        tmp.from_mesh(mesh)
        tmp.transform(matrix)
        vmap = {}
        for v in tmp.verts:
            vmap[v] = self.bm.verts.new(v.co)
        for f in tmp.faces:
            try:
                nf = self.bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.material_index = 2      # marker: unwrap later
            nf.smooth = f.smooth
        tmp.free()


def make_object(name, builder):
    me = bpy.data.meshes.new(name)
    for m in ensure_materials():       # slots first, or material indices get clamped
        me.materials.append(m)
    builder.bm.to_mesh(me)
    builder.bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box_mesh(sx, sy, sz, bevel=0.0, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=3, affect='EDGES', profile=0.5)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    me = bpy.data.meshes.new("tmp")
    bm.to_mesh(me)
    bm.free()
    return me


def sphere_mesh(rad, center):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=rad)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new("tmp")
    bm.to_mesh(me)
    bm.free()
    return me


def merlon_mesh(r0, r1, z0, z1, a0, a1, steps=6, bevel=0.006):
    """Annular-sector block for the rook's battlements."""
    bm = bmesh.new()
    rings = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        c, s = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((r * s, r * c, z)) for (r, z) in ((r0, z0), (r1, z0), (r1, z1), (r0, z1))])
    for i in range(steps):
        a, b = rings[i], rings[i + 1]
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new([a[k], b[k], b[k2], a[k2]])
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        sharp = [e for e in bm.edges if e.calc_face_angle(0) > math.radians(30)]
        bmesh.ops.bevel(bm, geom=sharp, offset=bevel, segments=2, affect='EDGES', profile=0.5)
    me = bpy.data.meshes.new("tmp")
    bm.to_mesh(me)
    bm.free()
    return me


def knight_head_mesh():
    """Side outline of a horse head, extruded with rounded edges and tapered."""
    # (forward, up) in squares; forward = -Y in Blender = +Z in glTF.
    outline = [
        (-0.165, 0.2, 'A'), (-0.175, 0.32, 'A'), (-0.16, 0.45, 'A'), (-0.125, 0.58, 'A'),
        (-0.085, 0.69, 'A'), (-0.06, 0.765, 'A'), (-0.045, 0.85, 'V'),  # ear tip
        (-0.005, 0.79, 'V'), (0.035, 0.775, 'A'), (0.085, 0.735, 'A'),   # forehead
        (0.155, 0.665, 'A'), (0.215, 0.595, 'A'), (0.245, 0.54, 'A'),     # nose bridge
        (0.24, 0.5, 'A'), (0.215, 0.478, 'V'),                            # muzzle
        (0.175, 0.488, 'A'), (0.12, 0.49, 'A'), (0.07, 0.47, 'A'),        # jaw
        (0.04, 0.43, 'A'), (0.055, 0.36, 'A'), (0.095, 0.29, 'A'),        # throat / chest
        (0.125, 0.235, 'A'), (0.13, 0.2, 'V'),
    ]
    cu = bpy.data.curves.new("knight_head", 'CURVE')
    cu.dimensions = '2D'
    cu.fill_mode = 'BOTH'
    cu.extrude = 0.05
    cu.bevel_depth = 0.036
    cu.bevel_resolution = 3
    cu.resolution_u = 6
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(outline) - 1)
    for bp, (f, u, kind) in zip(sp.bezier_points, outline):
        bp.co = (f, u, 0.0)
        t = 'AUTO' if kind == 'A' else 'VECTOR'
        bp.handle_left_type = t
        bp.handle_right_type = t
    sp.use_cyclic_u = True
    obj = bpy.data.objects.new("knight_head", cu)
    bpy.context.scene.collection.objects.link(obj)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(cu)
    # curve local (x=forward, y=up, z=thickness) -> world (-Y, Z, X)
    rot = Matrix(((0, 0, 1, 0), (-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    me.transform(rot)
    # taper: narrower toward the muzzle and the top of the mane
    for v in me.vertices:
        fwd = -v.co.y
        k = 1.0 - 0.38 * min(1.0, max(0.0, (fwd - 0.02) / 0.22))
        k *= 1.0 - 0.25 * min(1.0, max(0.0, (v.co.z - 0.6) / 0.25))
        v.co.x *= k
    for p in me.polygons:
        p.use_smooth = True
    # eyes: shallow bumps either side of the head
    return me


def mane_mesh():
    """A tapered round ridge down the back of the knight's neck."""
    pts = [(-0.05, 0.775, 0.45), (-0.085, 0.69, 0.85), (-0.125, 0.58, 1.0),
           (-0.155, 0.46, 1.0), (-0.168, 0.34, 0.85), (-0.162, 0.24, 0.6)]
    cu = bpy.data.curves.new("mane", 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 0.03
    cu.bevel_resolution = 3
    cu.resolution_u = 6
    cu.use_fill_caps = True
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for bp, (f, u, r) in zip(sp.bezier_points, pts):
        bp.co = (0.0, -f + 0.006, u)
        bp.radius = r
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new("mane", cu)
    bpy.context.scene.collection.objects.link(obj)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(cu)
    for v in me.vertices:          # flatten sideways a little
        v.co.x *= 0.8
    for p in me.polygons:
        p.use_smooth = True
    return me


def build_piece(kind):
    b = Builder()
    extras = []
    if kind == "pawn":
        prof, H = profile_pawn()
        b.lathe(prof)
    elif kind == "rook":
        prof, H = profile_rook()
        b.lathe(prof)
        n = 6
        for i in range(n):
            a = 2 * math.pi * i / n
            half = math.radians(19)
            b.add_mesh(merlon_mesh(0.14, 0.205, 0.635, 0.73, a - half, a + half))
    elif kind == "knight":
        H = 0.86
        b.lathe(profile_knight_base())
        b.add_mesh(knight_head_mesh())
        b.add_mesh(mane_mesh())
        for side in (-1, 1):
            b.add_mesh(sphere_mesh(0.017, (side * 0.056, -0.115, 0.665)))
    elif kind == "bishop":
        prof, H = profile_bishop()
        b.lathe(prof)
    elif kind == "queen":
        prof, H = profile_queen()
        b.lathe(prof)
        n = 9
        for i in range(n):
            a = 2 * math.pi * (i + 0.5) / n
            b.add_mesh(sphere_mesh(0.022, (0.158 * math.sin(a), 0.158 * math.cos(a), 0.918)))
    elif kind == "king":
        prof, H = profile_king()
        b.lathe(prof)
        b.add_mesh(box_mesh(0.05, 0.05, 0.17, 0.012, (0, 0, 1.035 + 0.085)))
        b.add_mesh(box_mesh(0.15, 0.05, 0.05, 0.012, (0, 0, 1.135)))
    else:
        raise ValueError(kind)

    obj = make_object(kind, b)

    if kind == "bishop":
        cut_bishop_slit(obj)

    finish_uvs(obj)
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(SHARP_DEG))
    return obj, H


def cut_bishop_slit(obj):
    """Diagonal notch in the mitre, via an exact boolean; cutter faces get marker material."""
    me = box_mesh(0.3, 0.022, 0.32)
    cutter = bpy.data.objects.new("slit", me)
    bpy.context.scene.collection.objects.link(cutter)
    # the slit faces the front (-Y), tilted ~40 degrees
    cutter.matrix_world = (Matrix.Translation((0.0, -0.12, 0.7)) @ Matrix.Rotation(math.radians(90), 4, 'Z')
                           @ Matrix.Rotation(math.radians(-40), 4, 'X'))
    # give the cutter the same slots so its faces carry the unwrap marker (index 2)
    for m in ensure_materials():
        cutter.data.materials.append(m)
    for p in cutter.data.polygons:
        p.material_index = 2
    mod = obj.modifiers.new("slit", 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    mod.material_mode = 'TRANSFER'
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    obj.modifiers.remove(mod)
    old = obj.data
    obj.data = new
    new.name = old.name
    bpy.data.meshes.remove(old)
    bpy.data.objects.remove(cutter)
    # the boolean leaves n-gons; tangents need triangles/quads
    bm = bmesh.new()
    bm.from_mesh(new)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(new)
    bm.free()


_materials = None


def ensure_materials():
    global _materials
    if _materials:
        return _materials
    body = bpy.data.materials.new("Body")
    body.use_nodes = True
    bsdf = body.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.35
    felt = bpy.data.materials.new("Felt")
    felt.use_nodes = True
    fb = felt.node_tree.nodes["Principled BSDF"]
    fb.inputs["Base Color"].default_value = (0.06, 0.16, 0.08, 1.0)
    fb.inputs["Roughness"].default_value = 1.0
    marker = bpy.data.materials.new("UnwrapMarker")
    _materials = [body, felt, marker]
    return _materials


def finish_uvs(obj):
    """Smart-project the marker faces, then pack every island without overlap."""
    me = obj.data
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.scene.objects:
        o.select_set(o == obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(me)
    for f in bm.faces:
        f.select = f.material_index == 2
    bmesh.update_edit_mesh(me)
    if any(f.select for f in bm.faces):
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, scale_to_bounds=False)
    bm = bmesh.from_edit_mesh(me)
    for f in bm.faces:
        if f.material_index == 2:
            f.material_index = 0
        f.select = True
    bmesh.update_edit_mesh(me)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.materials.pop(index=2)


# ---------------------------------------------------------------------------
# Rig + animation

BONES = ("root", "body", "head")


def rig(obj, H, kind):
    zb = 0.12 * H if kind != "knight" else 0.2
    zh = {"pawn": 0.62, "rook": 0.7, "knight": 0.6, "bishop": 0.6, "queen": 0.66, "king": 0.66}[kind] * H
    arm_data = bpy.data.armatures.new(kind + "_rig")
    arm = bpy.data.objects.new(kind + "_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.scene.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    root = eb.new("root"); root.head = (0, 0, 0); root.tail = (0, 0, zb)
    body = eb.new("body"); body.head = (0, 0, zb); body.tail = (0, 0, zh); body.parent = root; body.use_connect = True
    head = eb.new("head"); head.head = (0, 0, zh); head.tail = (0, 0, H); head.parent = body; head.use_connect = True
    for b in (root, body, head):
        b.roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')

    # weights: smooth blends around the two joints (2 influences max per vertex)
    groups = {n: obj.vertex_groups.new(name=n) for n in BONES}
    wb, wh = 0.05 * H, 0.08 * H

    def smooth(x):
        x = min(1.0, max(0.0, x))
        return x * x * (3 - 2 * x)

    for v in obj.data.vertices:
        z = v.co.z
        if z < zb + wb:
            t = smooth((z - (zb - wb)) / (2 * wb))
            w = {"root": 1 - t, "body": t}
        else:
            t = smooth((z - (zh - wh)) / (2 * wh))
            w = {"body": 1 - t, "head": t}
        for n, val in w.items():
            if val > 1e-4:
                groups[n].add([v.index], val, 'REPLACE')

    obj.parent = arm
    mod = obj.modifiers.new("Armature", 'ARMATURE')
    mod.object = arm
    return arm, zb, zh


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def keys(table, t):
    """Piecewise smooth interpolation through (time, value) pairs."""
    if t <= table[0][0]:
        return table[0][1]
    for (t0, v0), (t1, v1) in zip(table, table[1:]):
        if t <= t1:
            k = smoothstep(t0, t1, t)
            return v0 + (v1 - v0) * k
    return table[-1][1]


def squash(sy):
    sxz = 1.0 / math.sqrt(sy)        # preserve volume
    return Matrix.Diagonal((sxz, sy, sxz, 1.0))   # bone-local: Y runs along the bone


def rot_local(x_deg=0.0, y_deg=0.0, z_deg=0.0):
    """Bone-local rotation. For our upright bones: local X = world X (pitch,
    + tips the top toward -Y... see below), local Y = up (twist), local Z = world -Y."""
    return (Matrix.Rotation(math.radians(y_deg), 4, 'Y') @ Matrix.Rotation(math.radians(x_deg), 4, 'X')
            @ Matrix.Rotation(math.radians(z_deg), 4, 'Z'))


def clip_idle(t, ctx):
    # 3 s loop: gentle breathing and a slow head sway.
    w = 2 * math.pi * t / 3.0
    return {
        "body": squash(1.0 + 0.012 * math.sin(w)),
        "head": rot_local(x_deg=1.6 * math.sin(w + 1.0), z_deg=1.6 * math.sin(2 * w)),
    }


def clip_select(t, ctx):
    # 1 s loop: an eager little circular wobble.
    w = 2 * math.pi * t / 1.0
    return {
        "root": squash(1.0 + 0.025 * math.sin(2 * w)),
        "body": rot_local(x_deg=3.0 * math.sin(w), z_deg=3.0 * math.cos(w)),
        "head": rot_local(x_deg=2.0 * math.sin(w - 0.6), z_deg=2.0 * math.cos(w - 0.6)),
    }


HOP = {"duration": 0.9, "takeoff": 0.24, "land": 0.6}


def clip_hop(t, ctx):
    # Deformation only; the game moves the piece along its arc between
    # takeoff and land (exported in extras).
    sy = keys([(0.0, 1.0), (0.13, 0.82), (0.24, 1.14), (0.42, 1.03), (0.58, 1.1),
               (0.66, 0.84), (0.78, 1.04), (0.9, 1.0)], t)
    head_nod = keys([(0.0, 0.0), (0.13, -4.0), (0.3, 5.0), (0.58, 3.0), (0.68, -6.0), (0.82, 2.0), (0.9, 0.0)], t)
    return {"root": squash(sy), "head": rot_local(x_deg=head_nod)}


CAPTURED = {"duration": 1.1, "fall": 0.72}


def clip_captured(t, ctx):
    # Recoil, then topple backward (toward +Y in Blender / -Z in glTF, away
    # from the piece's front) pivoting on the rim of the base, with a bounce.
    R = ctx["R"]
    recoil = keys([(0.0, 1.0), (0.1, 0.84), (0.22, 1.06), (0.3, 1.0)], t)
    if t < 0.25:
        ang = 0.0
    elif t < 0.72:
        k = (t - 0.25) / 0.47
        ang = -ctx["rest_angle"] * k * k                      # accelerating fall
    else:
        k = (t - 0.72) / 0.38
        ang = -ctx["rest_angle"] + math.radians(9) * math.sin(math.pi * min(1.0, k * 1.6)) * (1 - k)
    pivot = Vector((0.0, R, 0.0))
    world = (Matrix.Translation(pivot) @ Matrix.Rotation(ang, 4, 'X') @ Matrix.Translation(-pivot))
    shake = 6.0 * math.sin(t * 50.0) * (1.0 - smoothstep(0.0, 0.25, t)) if t < 0.25 else 0.0
    return {"root@world": world, "root": squash(recoil), "head": rot_local(z_deg=shake)}


CELEBRATE = {"duration": 1.6}


def clip_celebrate(t, ctx):
    # Two hops in place with a full spin and squash on each landing.
    D = 1.6
    half = D / 2
    lt = t % half
    h = 0.0
    if 0.12 < lt < 0.62:
        k = (lt - 0.12) / 0.5
        h = 0.22 * 4 * k * (1 - k)
    sy = keys([(0.0, 1.0), (0.08, 0.84), (0.14, 1.15), (0.38, 1.03), (0.6, 1.1), (0.66, 0.84), (0.8, 1.0)], lt)
    spin = 360.0 * smoothstep(0.1, D - 0.15, t)
    world = Matrix.Translation((0, 0, h)) @ Matrix.Rotation(math.radians(spin), 4, 'Z')
    return {"root@world": world, "root": squash(sy), "head": rot_local(x_deg=6.0 * math.sin(2 * math.pi * t / half))}


CLIPS = [
    ("idle", 3.0, clip_idle),
    ("select", 1.0, clip_select),
    ("hop", HOP["duration"], clip_hop),
    ("captured", CAPTURED["duration"], clip_captured),
    ("celebrate", CELEBRATE["duration"], clip_celebrate),
]


def bake_clips(arm, ctx):
    scene = bpy.context.scene
    scene.render.fps = FPS
    arm.animation_data_create()
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    rest = {pb.name: pb.bone.matrix_local.copy() for pb in arm.pose.bones}
    for name, duration, fn in CLIPS:
        action = bpy.data.actions.new(name)
        arm.animation_data.action = action
        frames = round(duration * FPS)
        for f in range(frames + 1):
            t = f / FPS
            pose = fn(t, ctx)
            for pb in arm.pose.bones:
                basis = Matrix.Identity(4)
                if pb.name == "root" and "root@world" in pose:
                    R = rest["root"]
                    basis = R.inverted() @ pose["root@world"] @ R
                if pb.name in pose:
                    basis = basis @ pose[pb.name]
                pb.matrix_basis = basis
                pb.keyframe_insert("location", frame=f + 1)
                pb.keyframe_insert("rotation_quaternion", frame=f + 1)
                pb.keyframe_insert("scale", frame=f + 1)
        # linear between per-frame keys; the exporter samples every frame anyway
        for fc in iter_fcurves(action):
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.name = name
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)


def iter_fcurves(action):
    # Blender 4.4+ layered actions keep fcurves in channelbags.
    if hasattr(action, "layers") and len(action.layers):
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    elif hasattr(action, "fcurves"):
        yield from action.fcurves


# ---------------------------------------------------------------------------

def reset_scene():
    global _materials
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials = None


PIECES = ["pawn", "knight", "bishop", "rook", "queen", "king"]
BASE_R = {"pawn": 0.21, "knight": 0.235, "bishop": 0.23, "rook": 0.25, "queen": 0.26, "king": 0.27}
# how far the piece leans when it lies on its side (depends on its silhouette)
REST_ANGLE = {"pawn": 72, "knight": 78, "bishop": 78, "rook": 80, "queen": 80, "king": 82}


def build_rigged(kind):
    obj, H = build_piece(kind)
    arm, zb, zh = rig(obj, H, kind)
    ctx = {"R": BASE_R[kind], "rest_angle": math.radians(REST_ANGLE[kind])}
    bake_clips(arm, ctx)
    arm["tuichess"] = json.dumps({
        "piece": kind, "height": H, "baseRadius": BASE_R[kind], "fps": FPS,
        "hop": HOP, "captured": CAPTURED, "celebrate": CELEBRATE,
        "bones": {"root": [0, 0], "body": [round(zb, 4)], "head": [round(zh, 4)]},
        "front": "+Z",
    })
    return obj, arm, H


def export(kind, out_dir):
    reset_scene()
    obj, arm, H = build_rigged(kind)
    path = os.path.join(out_dir, kind + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_animations=True,
        export_skins=True,
        export_morph=False,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_extras=True,
        export_yup=True,
        export_animation_mode='NLA_TRACKS',
        export_optimize_animation_size=False,
        export_force_sampling=True,
        export_optimize_animation_keep_anim_armature=True,
        export_frame_range=False,
    )
    # Bloom picks clips by index: NLA tracks export in creation order (= CLIPS).
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[pieces] {kind}: {len(obj.data.vertices)} verts, {tris} tris -> {path}")


def preview(path, blend=None):
    reset_scene()
    xs = 0.0
    for kind in PIECES:
        obj, arm, H = build_rigged(kind)
        arm.location.x = xs
        xs += 0.62
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_cavity = True
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 700
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 3.7
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (1.55, -6.0, 1.6)
    cam.rotation_euler = (math.radians(82), 0, 0)
    scene.camera = cam
    for m in bpy.data.materials:
        if m.name == "Body":
            m.diffuse_color = (0.9, 0.86, 0.78, 1.0)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    # second view: every piece turned 90 degrees (the knight in profile)
    for o in scene.objects:
        if o.type == 'ARMATURE':
            o.rotation_euler.z = math.radians(90)
    scene.render.filepath = path.replace(".png", "-side.png")
    bpy.ops.render.render(write_still=True)
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=blend)
    print(f"[pieces] preview -> {path}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir, prev, blend, only = None, None, None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out_dir = argv[i + 1]; i += 2
        elif argv[i] == "--preview":
            prev = argv[i + 1]; i += 2
        elif argv[i] == "--blend":
            blend = argv[i + 1]; i += 2
        elif argv[i] == "--only":
            only = argv[i + 1].split(","); i += 2
        else:
            raise SystemExit(f"unknown argument {argv[i]}")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        for kind in (only or PIECES):
            export(kind, out_dir)
    if prev:
        preview(os.path.abspath(prev), blend and os.path.abspath(blend))


main()
