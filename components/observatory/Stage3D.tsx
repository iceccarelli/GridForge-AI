"use client";

// The 3D stage. Loaded with next/dynamic({ ssr: false }) by Stage.tsx, and only after the 2D/3D decision (stage-mode.ts) says
// "3d", so none of this (or three.js) is downloaded by a 2D-only visitor.
//
// It draws the SAME SceneModel as Stage2D: a power-path rail of node blocks (shell = capacity as found, solid = load as found,
// amber ring and light = the stage that binds as found, cyan ring = after the plan), a field of rack rows shaded by kW per rack, and a camera
// that dollies between stages. The canvas is aria-hidden: the text alternative and the node table carry the meaning.
//
// Resource rules: pixel ratio capped at 2, ~30 fps cap, rendering stops when the tab is hidden or the canvas is off screen,
// every geometry/material/renderer is disposed on unmount, and a lost or failed context hands control back to the 2D view.
// prefers-reduced-motion: no camera drift, no pulsing, jump cuts only, and no render loop (frames are drawn on demand).
import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Fog,
  GridHelper,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PointLight,
  RingGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from "three";
import type { SceneModel } from "@/lib/observatory/types";
import { toBase } from "@/components/observatory/format";
import { heatHex, nodeVisuals, rackRowVisuals, rackSquares } from "@/components/observatory/scene-visuals";

export interface Stage3DProps {
  model: SceneModel;
  selectedId: string | null;
  reducedMotion: boolean;
  /** Called once if the context cannot be created or is lost; the parent switches to 2D. */
  onFail: (reason: string) => void;
}

const SPACING = 3.1;
const FRAME_MS = 1000 / 30;
const COLOR = {
  edge: 0x3a4c70,
  edgeSelected: 0xf5f7fa,
  found: 0x1193a8,
  after: 0x00e5ff,
  binds: 0xffb020,
  over: 0xf87171,
  plate: 0x131c2e,
  cable: 0x2a3650,
  floorMain: 0x1e2942,
  floorSub: 0x0f1626,
  fog: 0x070b14,
};

type Edges = LineSegments<EdgesGeometry, LineBasicMaterial>;
interface NodeHandle {
  id: string;
  x: number;
  edges: Edges;
  binds: boolean;
}
interface Content {
  group: Group;
  /** World width of the rail, for fitting the camera. */
  width: number;
  nodes: NodeHandle[];
  glows: MeshBasicMaterial[];
  lights: PointLight[];
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    const geom = m.geometry as BufferGeometry | undefined;
    geom?.dispose();
    const mat = m.material as Material | Material[] | undefined;
    const free = (x: Material) => {
      (x as MeshBasicMaterial).map?.dispose();
      x.dispose();
    };
    if (Array.isArray(mat)) mat.forEach(free);
    else if (mat) free(mat);
    if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
  });
}

function buildContent(model: SceneModel): Content {
  const group = new Group();
  const glows: MeshBasicMaterial[] = [];
  const lights: PointLight[] = [];
  const visuals = nodeVisuals(model);
  const n = visuals.length;
  const x0 = -((n - 1) * SPACING) / 2;

  // Capacity shell height comes from the model: relative to the largest capacity that shares its base unit.
  const maxByBase = new Map<string, number>();
  model.nodes.forEach((nd) => {
    if (nd.capacity.value === null) return;
    const b = toBase(nd.capacity.value, nd.capacity.unit);
    maxByBase.set(b.base, Math.max(maxByBase.get(b.base) ?? 0, b.value));
  });

  const nodes: NodeHandle[] = [];
  visuals.forEach((v, i) => {
    const nd = model.nodes[i];
    const x = x0 + i * SPACING;
    let rel = 1;
    if (nd.capacity.value !== null) {
      const b = toBase(nd.capacity.value, nd.capacity.unit);
      const max = maxByBase.get(b.base) ?? b.value;
      rel = max > 0 ? Math.max(0.15, b.value / max) : 1;
    }
    const H = 1.5 + 1.7 * rel;

    const plate = new Mesh(new BoxGeometry(2.4, 0.12, 2.4), new MeshStandardMaterial({ color: COLOR.plate, roughness: 0.9, metalness: 0.1 }));
    plate.position.set(x, 0.06, 0);
    group.add(plate);

    const shellGeom = new BoxGeometry(1.9, H, 1.9);
    const shell = new Mesh(shellGeom, new MeshBasicMaterial({ color: 0x4a6a9a, transparent: true, opacity: 0.07, depthWrite: false }));
    shell.position.set(x, 0.12 + H / 2, 0);
    group.add(shell);
    const edges: Edges = new LineSegments(new EdgesGeometry(shellGeom), new LineBasicMaterial({ color: v.bindsFound ? COLOR.binds : COLOR.edge }));
    edges.position.copy(shell.position);
    group.add(edges);

    const label = makeLabel(v.title, v.bindsFound ? "#FFB020" : "#C9D3E3");
    label.position.set(x, 0.12 + H + 0.75, 0);
    group.add(label);

    if (v.utilFound !== null) {
      const hf = Math.max(0.05, Math.min(1.05, v.utilFound)) * H;
      const fill = new Mesh(
        new BoxGeometry(1.5, hf, 1.5),
        new MeshStandardMaterial({
          color: v.utilFound > 1 ? COLOR.over : COLOR.found,
          roughness: 0.55,
          metalness: 0.2,
          emissive: v.bindsFound ? COLOR.binds : COLOR.found,
          emissiveIntensity: v.bindsFound ? 0.35 : 0.08,
        }),
      );
      fill.position.set(x, 0.12 + hf / 2, 0);
      group.add(fill);
    } else {
      // Not comparable (missing value or different units): a flat grey marker, never an invented level.
      const flat = new Mesh(new BoxGeometry(1.5, 0.05, 1.5), new MeshStandardMaterial({ color: 0x4a5568, roughness: 1 }));
      flat.position.set(x, 0.15, 0);
      group.add(flat);
    }
    // No after-plan level is drawn: the engine does not state a stage's capacity after the plan, so an after-plan load against
    // the as-found shell would show a working design as full or overfull. The after-plan binding stage keeps its cyan ring.

    if (v.bindsFound || v.bindsAfter) {
      const glow = new MeshBasicMaterial({ color: v.bindsFound ? COLOR.binds : COLOR.after, transparent: true, opacity: 0.7, side: DoubleSide, depthWrite: false });
      const ring = new Mesh(new RingGeometry(1.45, 1.75, 48), glow);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.14, 0);
      group.add(ring);
      glows.push(glow);
      const light = new PointLight(v.bindsFound ? COLOR.binds : COLOR.after, 6, 7, 2);
      light.position.set(x, H + 0.8, 1.2);
      group.add(light);
      lights.push(light);
    }
    nodes.push({ id: v.id, x, edges, binds: v.bindsFound });

    if (i > 0) {
      const cable = new Mesh(new BoxGeometry(SPACING - 2.4, 0.07, 0.07), new MeshBasicMaterial({ color: COLOR.cable }));
      cable.position.set(x - SPACING / 2, 0.45, 0);
      group.add(cable);
    }
  });

  // Rack rows in front of the rail: the body is shaded by kW per rack as found, the thin slab on top by kW per rack after.
  const rows = rackRowVisuals(model.rackRows);
  const fieldW = Math.max(SPACING * 3, Math.min(Math.max(n, 1) * SPACING, 24));
  const tmp = new Object3D();
  const color = new Color();
  rows.forEach((r, ri) => {
    const sq = rackSquares(r.racks, 36);
    if (sq.squares === 0) return;
    const pitch = fieldW / Math.max(sq.squares, 8);
    const z = 4.6 + ri * 1.7;
    const body = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.6, metalness: 0.25 }), sq.squares);
    const slab = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }), sq.squares);
    for (let k = 0; k < sq.squares; k++) {
      const x = -fieldW / 2 + (k + 0.5) * pitch;
      tmp.position.set(x, 0.55, z);
      tmp.scale.set(pitch * 0.72, 1.0, 0.8);
      tmp.updateMatrix();
      body.setMatrixAt(k, tmp.matrix);
      body.setColorAt(k, color.setHex(heatHex(r.heatFound)));
      tmp.position.set(x, 1.12, z);
      tmp.scale.set(pitch * 0.72, 0.12, 0.8);
      tmp.updateMatrix();
      slab.setMatrixAt(k, tmp.matrix);
      slab.setColorAt(k, color.setHex(heatHex(r.heatAfter)));
    }
    body.instanceMatrix.needsUpdate = true;
    slab.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (slab.instanceColor) slab.instanceColor.needsUpdate = true;
    group.add(body);
    group.add(slab);
  });

  return { group, width: Math.max(0, n - 1) * SPACING + 2.4, nodes, glows, lights };
}

/** A text label as a sprite. The canvas is aria-hidden; the same names are in the stage table and the text description. */
function makeLabel(text: string, color: string): Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const g = c.getContext("2d");
  if (g) {
    g.clearRect(0, 0, c.width, c.height);
    g.font = '600 40px system-ui, "Segoe UI", Roboto, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    let t = text;
    while (g.measureText(t).width > c.width - 16 && t.length > 4) t = `${t.slice(0, -2).trimEnd()}…`;
    g.fillText(t, c.width / 2, c.height / 2);
  }
  const tex = new CanvasTexture(c);
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(3.0, 0.56, 1);
  return sprite;
}

interface StageApi {
  dispose(): void;
  setModel(m: SceneModel): void;
  setSelected(id: string | null): void;
  setReducedMotion(b: boolean): void;
}

function createStage(host: HTMLElement, onFail: (reason: string) => void): StageApi | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "default" });
  } catch {
    onFail("WebGL context creation failed");
    return null;
  }
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  renderer.setClearColor(0x000000, 0);
  host.appendChild(canvas);

  const scene = new Scene();
  scene.fog = new Fog(COLOR.fog, 24, 52);
  const camera = new PerspectiveCamera(38, 1.6, 0.1, 120);
  scene.add(new AmbientLight(0xbfd4ff, 0.75));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(6, 12, 9);
  scene.add(sun);
  const floor = new GridHelper(70, 70, COLOR.floorSub, COLOR.floorSub);
  scene.add(floor);

  let content: Content | null = null;
  let model: SceneModel | null = null;
  let selectedId: string | null = null;
  let reduced = false;
  let disposed = false;
  let docVisible = typeof document === "undefined" ? true : !document.hidden;
  let onScreen = true;
  let raf = 0;
  let last = 0;

  const camPos = new Vector3(0, 9, 22);
  const camLook = new Vector3(0, 1.2, 1.5);
  const tgtPos = new Vector3();
  const tgtLook = new Vector3();

  // Distance at which the whole rail (plus its margins) fits the horizontal field of view.
  function overviewDistance(): number {
    const width = Math.max(1, content?.width ?? 20) + 4;
    const hFov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    return Math.max(18, width / 2 / Math.tan(hFov / 2));
  }

  function computeTargets(t: number): void {
    const node = content?.nodes.find((nd) => nd.id === selectedId) ?? null;
    const sway = reduced ? 0 : Math.sin(t / 5200) * 0.5;
    if (node) {
      tgtPos.set(node.x * 0.9 + sway, 4.4, 10.5);
      tgtLook.set(node.x, 1.3, 0.8);
    } else {
      const d = overviewDistance();
      tgtPos.set(sway * 1.5, d * 0.5, d * 0.85);
      tgtLook.set(0, 1.0, 2.2);
    }
  }

  function pulse(t: number): number {
    return reduced ? 1 : 0.65 + 0.35 * Math.sin(t / 650);
  }

  function update(t: number, jump: boolean): void {
    computeTargets(t);
    if (jump || reduced) {
      camPos.copy(tgtPos);
      camLook.copy(tgtLook);
    } else {
      camPos.lerp(tgtPos, 0.07);
      camLook.lerp(tgtLook, 0.07);
    }
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (content) {
      const p = pulse(t);
      content.glows.forEach((g) => {
        g.opacity = 0.35 + 0.45 * p;
      });
      content.lights.forEach((l) => {
        l.intensity = 3 + 4 * p;
      });
    }
  }

  function draw(jump: boolean): void {
    if (disposed) return;
    try {
      update(performance.now(), jump);
      renderer.render(scene, camera);
    } catch {
      fail("rendering failed");
    }
  }

  const shouldRun = () => !disposed && docVisible && onScreen;
  function frame(t: number): void {
    raf = 0;
    if (!shouldRun() || reduced) return;
    if (t - last >= FRAME_MS - 1) {
      last = t;
      draw(false);
    }
    schedule();
  }
  function schedule(): void {
    if (raf || !shouldRun() || reduced) return;
    raf = requestAnimationFrame(frame);
  }
  function stop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function refresh(): void {
    // Reduced motion: no loop, one frame per change. Otherwise the loop runs while visible.
    if (!shouldRun()) return;
    if (reduced) draw(true);
    else schedule();
  }

  let failed = false;
  function fail(reason: string): void {
    if (failed) return;
    failed = true;
    stop();
    onFail(reason);
  }

  const size = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // A narrow canvas needs a wider field of view to keep the rail in frame.
    camera.fov = camera.aspect < 1 ? 58 : camera.aspect < 1.4 ? 46 : 38;
    camera.updateProjectionMatrix();
  };
  size();

  const ro = new ResizeObserver(() => {
    size();
    refresh();
  });
  ro.observe(host);
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          if (onScreen) refresh();
          else stop();
        })
      : null;
  io?.observe(host);
  const onVis = () => {
    docVisible = !document.hidden;
    if (docVisible) refresh();
    else stop();
  };
  document.addEventListener("visibilitychange", onVis);
  const onLost = (e: Event) => {
    e.preventDefault();
    fail("the graphics context was lost");
  };
  canvas.addEventListener("webglcontextlost", onLost, false);

  function applySelection(): void {
    content?.nodes.forEach((nd) => {
      nd.edges.material.color.setHex(nd.id === selectedId ? COLOR.edgeSelected : nd.binds ? COLOR.binds : COLOR.edge);
    });
  }

  return {
    setModel(m) {
      if (disposed) return;
      model = m;
      if (content) {
        scene.remove(content.group);
        disposeTree(content.group);
      }
      content = buildContent(model);
      scene.add(content.group);
      applySelection();
      refresh();
    },
    setSelected(id) {
      if (disposed) return;
      selectedId = id;
      applySelection();
      refresh();
    },
    setReducedMotion(b) {
      if (disposed) return;
      reduced = b;
      stop();
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      ro.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost, false);
      if (content) {
        scene.remove(content.group);
        disposeTree(content.group);
        content = null;
      }
      disposeTree(floor);
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* already lost */
      }
      canvas.remove();
    },
  };
}

export default function Stage3D({ model, selectedId, reducedMotion, onFail }: Stage3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<StageApi | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  // Declaration order matters: the stage is created first, then the model, motion and selection are applied to it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const api = createStage(host, (reason) => failRef.current(reason));
    apiRef.current = api;
    return () => {
      api?.dispose();
      apiRef.current = null;
    };
  }, []);
  useEffect(() => {
    apiRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);
  useEffect(() => {
    apiRef.current?.setModel(model);
    apiRef.current?.setSelected(selectedId);
    // selectedId is applied by the effect below; this one re-applies it only because setModel rebuilds the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  useEffect(() => {
    apiRef.current?.setSelected(selectedId);
  }, [selectedId]);

  return <div ref={hostRef} className="absolute inset-0" aria-hidden="true" />;
}
