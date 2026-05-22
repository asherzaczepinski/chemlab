"use client";

import { useEffect, useRef, useState } from "react";

/* ============================================================
   2 NO₂  ⇌  N₂O₄     (brown ⇌ colorless,  forward exothermic)

   Equilibrium is NOT scripted. It emerges from a particle sim:
     • Forward (join):  two NO₂ that collide may dimerize.
                        Probability = AF·exp(−EAF/T)   (bimolecular,
                        so it also scales with collision frequency,
                        i.e. with concentration / pressure).
     • Reverse (split): each N₂O₄ may dissociate per frame.
                        Probability = AR·exp(−EAR/T)   (unimolecular).

   Because EAR ≫ EAF (forward is exothermic ⇒ reverse has the higher
   activation energy), raising T speeds the reverse far more than the
   forward — so heat shifts the system toward NO₂. Compressing the box
   raises collision frequency, favoring the forward (fewer-mole) side.
   A catalyst multiplies BOTH rates equally: faster, no shift.
   ============================================================ */

const W = 720;
const H = 520;
const PAD = 16;
const R_NO2 = 7;
const R_N2O4 = 7; // each lobe; drawn as a fused pair
const M_NO2 = 1;
const M_N2O4 = 2;

// kinetics (T in "Kelvin-like" units, slider 200–600)
const AF = 1.4, EAF = 500;   // forward: low activation
const AR = 8, EAR = 2000;    // reverse: high activation (endothermic)
const CAT_MULT = 3;          // catalyst speedup for BOTH directions
const BASE_SPEED = 1.7;      // px/frame for NO₂ at 300 K
const THERMO = 0.04;         // thermostat stiffness toward target speed

type Kind = "no2" | "n2o4";
interface P {
  x: number; y: number; vx: number; vy: number;
  kind: Kind; m: number; r: number; ang: number;
}

interface Params {
  Tk: number;
  volFrac: number;   // 0.45 .. 1.0  (piston position)
  catalyst: boolean;
  speed: number;     // sim speed multiplier
  paused: boolean;
}

interface Snapshot {
  no2: number; n2o4: number;
  cNo2: number; cN2o4: number;   // concentrations = count / volume
  status: "eq" | "fwd" | "rev";
}

function randUnitVel(speed: number) {
  const a = Math.random() * Math.PI * 2;
  return { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed };
}

export default function LeChatelierLab() {
  const simRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<HTMLCanvasElement>(null);

  // mutable sim state lives in refs (no re-render on every frame)
  const particles = useRef<P[]>([]);
  const params = useRef<Params>({ Tk: 360, volFrac: 1, catalyst: false, speed: 1, paused: false });
  const history = useRef<{ no2: number; n2o4: number }[]>([]);
  const rate = useRef<{ fwd: number; rev: number }>({ fwd: 0, rev: 0 });
  const dragging = useRef(false);

  // UI display state (throttled)
  const [snap, setSnap] = useState<Snapshot>({ no2: 0, n2o4: 0, cNo2: 0, cN2o4: 0, status: "eq" });
  const [temp, setTemp] = useState(360);
  const [vol, setVol] = useState(100);
  const [catalyst, setCatalyst] = useState(false);

  // ---- geometry helpers ----
  const pistonX = () => PAD + (W - 2 * PAD) * params.current.volFrac;
  const boxArea = () => (pistonX() - PAD) * (H - 2 * PAD);
  const targetSpeed = (kind: Kind) => {
    const base = BASE_SPEED * Math.sqrt(params.current.Tk / 300);
    return kind === "no2" ? base : base / Math.sqrt(2);
  };

  // ---- seed the box ----
  function seed(nNO2: number) {
    const arr: P[] = [];
    const px = pistonX();
    for (let i = 0; i < nNO2; i++) {
      const { vx, vy } = randUnitVel(targetSpeed("no2"));
      arr.push({
        x: PAD + R_NO2 + Math.random() * (px - 2 * PAD - 2 * R_NO2),
        y: PAD + R_NO2 + Math.random() * (H - 2 * PAD - 2 * R_NO2),
        vx, vy, kind: "no2", m: M_NO2, r: R_NO2, ang: Math.random() * Math.PI,
      });
    }
    particles.current = arr;
    history.current = [];
  }

  function addMolecule(kind: Kind, count = 6) {
    const px = pistonX();
    for (let i = 0; i < count; i++) {
      const r = kind === "no2" ? R_NO2 : R_N2O4 * 1.6;
      const { vx, vy } = randUnitVel(targetSpeed(kind));
      particles.current.push({
        x: PAD + r + Math.random() * (px - 2 * PAD - 2 * r),
        y: PAD + r + Math.random() * (H - 2 * PAD - 2 * r),
        vx, vy, kind, m: kind === "no2" ? M_NO2 : M_N2O4, r: kind === "no2" ? R_NO2 : R_N2O4,
        ang: Math.random() * Math.PI,
      });
    }
  }

  function removeMolecule(kind: Kind, count = 6) {
    const arr = particles.current;
    for (let k = 0; k < count; k++) {
      const idx = arr.map((p, i) => (p.kind === kind ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) break;
      arr.splice(idx[(Math.random() * idx.length) | 0], 1);
    }
  }

  // =====================================================
  //  main loop
  // =====================================================
  useEffect(() => {
    seed(90);

    const sim = simRef.current!;
    const graph = graphRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    sim.width = W * dpr; sim.height = H * dpr;
    graph.width = W * dpr; graph.height = 150 * dpr;
    const ctx = sim.getContext("2d")!;
    const gctx = graph.getContext("2d")!;
    ctx.scale(dpr, dpr);
    gctx.scale(dpr, dpr);

    let raf = 0;
    let frame = 0;

    const step = () => {
      raf = requestAnimationFrame(step);
      frame++;
      const pr = params.current;

      if (!pr.paused) {
        physics();
      }
      draw(ctx);
      drawGraph(gctx);

      // throttle UI updates
      if (frame % 6 === 0) publishSnapshot();
    };

    function physics() {
      const pr = params.current;
      const arr = particles.current;
      const px = pistonX();
      const sub = pr.speed; // motion multiplier
      const catMult = pr.catalyst ? CAT_MULT : 1;
      const Pf = Math.min(1, AF * Math.exp(-EAF / pr.Tk) * catMult);
      const Pr = Math.min(1, AR * Math.exp(-EAR / pr.Tk) * catMult);

      // 1. integrate + walls + thermostat
      for (const p of arr) {
        // thermostat: nudge speed toward thermal target
        const tgt = targetSpeed(p.kind);
        const sp = Math.hypot(p.vx, p.vy) || 1e-6;
        const f = 1 + THERMO * (tgt - sp) / sp;
        p.vx *= f; p.vy *= f;

        p.x += p.vx * sub;
        p.y += p.vy * sub;
        p.ang += 0.03 * sub;

        const rr = p.r;
        if (p.x < PAD + rr) { p.x = PAD + rr; p.vx = Math.abs(p.vx); }
        if (p.x > px - rr)  { p.x = px - rr;  p.vx = -Math.abs(p.vx); }
        if (p.y < PAD + rr) { p.y = PAD + rr; p.vy = Math.abs(p.vy); }
        if (p.y > H - PAD - rr) { p.y = H - PAD - rr; p.vy = -Math.abs(p.vy); }
      }

      // 2. pairwise: reactions (forward) + elastic bounce
      const consumed = new Array(arr.length).fill(false);
      const born: P[] = [];
      let fwd = 0;
      for (let i = 0; i < arr.length; i++) {
        if (consumed[i]) continue;
        const a = arr[i];
        for (let j = i + 1; j < arr.length; j++) {
          if (consumed[j]) continue;
          const b = arr[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const minD = a.r + b.r + 2;
          if (dist >= minD || dist === 0) continue;

          // forward reaction: two NO₂ fuse into N₂O₄
          if (a.kind === "no2" && b.kind === "no2" && Math.random() < Pf) {
            consumed[i] = true; consumed[j] = true;
            born.push({
              x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
              vx: (a.vx + b.vx) / 2, vy: (a.vy + b.vy) / 2,
              kind: "n2o4", m: M_N2O4, r: R_N2O4, ang: Math.atan2(dy, dx),
            });
            fwd++;
            break; // a is gone
          }

          // otherwise: elastic collision (mass-weighted, 1-D along normal)
          const nx = dx / dist, ny = dy / dist;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const rel = dvx * nx + dvy * ny;
          if (rel < 0) continue; // separating already
          const imp = (2 * rel) / (a.m + b.m);
          a.vx -= imp * b.m * nx; a.vy -= imp * b.m * ny;
          b.vx += imp * a.m * nx; b.vy += imp * a.m * ny;
          // positional separation to remove overlap
          const overlap = (minD - dist) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;
        }
      }

      // 3. reverse reaction: N₂O₄ dissociates into 2 NO₂
      let rev = 0;
      for (let i = 0; i < arr.length; i++) {
        if (consumed[i]) continue;
        const p = arr[i];
        if (p.kind === "n2o4" && Math.random() < Pr) {
          consumed[i] = true;
          const a = Math.random() * Math.PI * 2;
          const ox = Math.cos(a), oy = Math.sin(a);
          const sp = targetSpeed("no2");
          for (const s of [1, -1]) {
            born.push({
              x: p.x + ox * (R_NO2 + 1) * s,
              y: p.y + oy * (R_NO2 + 1) * s,
              vx: p.vx + ox * sp * 0.6 * s,
              vy: p.vy + oy * sp * 0.6 * s,
              kind: "no2", m: M_NO2, r: R_NO2, ang: Math.random() * Math.PI,
            });
          }
          rev++;
        }
      }

      // 4. rebuild list
      const next: P[] = [];
      for (let i = 0; i < arr.length; i++) if (!consumed[i]) next.push(arr[i]);
      for (const p of born) next.push(p);
      particles.current = next;

      // 5. smoothed rate balance
      rate.current.fwd = rate.current.fwd * 0.9 + fwd * 0.1;
      rate.current.rev = rate.current.rev * 0.9 + rev * 0.1;

      // 6. record history
      let nNO2 = 0, nN2O4 = 0;
      for (const p of next) p.kind === "no2" ? nNO2++ : nN2O4++;
      history.current.push({ no2: nNO2, n2o4: nN2O4 });
      if (history.current.length > 320) history.current.shift();
    }

    // ---------- rendering ----------
    function draw(c: CanvasRenderingContext2D) {
      const arr = particles.current;
      const px = pistonX();
      let nNO2 = 0;
      for (const p of arr) if (p.kind === "no2") nNO2++;
      const frac = arr.length ? nNO2 / arr.length : 0;

      c.clearRect(0, 0, W, H);

      // chamber floor
      c.fillStyle = "#070b14";
      c.fillRect(PAD, PAD, px - PAD, H - 2 * PAD);

      // brown gas haze ∝ NO₂ presence  (the visible Le Châtelier cue)
      const haze = 0.05 + 0.30 * frac;
      c.fillStyle = `rgba(216,118,58,${haze})`;
      c.fillRect(PAD, PAD, px - PAD, H - 2 * PAD);

      // chamber border
      c.strokeStyle = "rgba(255,255,255,0.10)";
      c.lineWidth = 1;
      c.strokeRect(PAD, PAD, px - PAD, H - 2 * PAD);

      // particles
      for (const p of arr) {
        if (p.kind === "no2") drawNO2(c, p);
        else drawN2O4(c, p);
      }

      // piston (right wall)
      drawPiston(c, px);
    }

    function drawNO2(c: CanvasRenderingContext2D, p: P) {
      const g = c.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, R_NO2 + 3);
      g.addColorStop(0, "#ffba74");
      g.addColorStop(0.5, "#d8763a");
      g.addColorStop(1, "rgba(216,118,58,0)");
      c.fillStyle = g;
      c.beginPath(); c.arc(p.x, p.y, R_NO2 + 3, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#b8551f";
      c.beginPath(); c.arc(p.x, p.y, R_NO2, 0, Math.PI * 2); c.fill();
    }

    function drawN2O4(c: CanvasRenderingContext2D, p: P) {
      const ox = Math.cos(p.ang) * R_N2O4 * 0.7;
      const oy = Math.sin(p.ang) * R_N2O4 * 0.7;
      for (const s of [1, -1]) {
        const cx = p.x + ox * s, cy = p.y + oy * s;
        const g = c.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, R_N2O4 + 3);
        g.addColorStop(0, "#d8f0ff");
        g.addColorStop(0.5, "#6fb3d6");
        g.addColorStop(1, "rgba(111,179,214,0)");
        c.fillStyle = g;
        c.beginPath(); c.arc(cx, cy, R_N2O4 + 2, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#4f93b8";
        c.beginPath(); c.arc(cx, cy, R_N2O4 - 1, 0, Math.PI * 2); c.fill();
      }
      // bond
      c.strokeStyle = "rgba(210,240,255,0.7)"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(p.x - ox, p.y - oy); c.lineTo(p.x + ox, p.y + oy); c.stroke();
    }

    function drawPiston(c: CanvasRenderingContext2D, px: number) {
      const grad = c.createLinearGradient(px, 0, px + 18, 0);
      grad.addColorStop(0, "#3a4256");
      grad.addColorStop(1, "#1b2030");
      c.fillStyle = grad;
      c.fillRect(px, PAD, 18, H - 2 * PAD);
      c.strokeStyle = "rgba(255,255,255,0.18)";
      c.strokeRect(px, PAD, 18, H - 2 * PAD);
      // hatch
      c.strokeStyle = "rgba(255,255,255,0.10)";
      for (let y = PAD + 6; y < H - PAD; y += 12) {
        c.beginPath(); c.moveTo(px + 3, y); c.lineTo(px + 15, y + 8); c.stroke();
      }
    }

    function drawGraph(c: CanvasRenderingContext2D) {
      const GW = W, GH = 150;
      c.clearRect(0, 0, GW, GH);
      const hist = history.current;
      if (hist.length < 2) return;
      const maxTotal = Math.max(
        1,
        ...hist.map((h) => h.no2 + h.n2o4)
      );
      const xAt = (i: number) => (i / (hist.length - 1)) * GW;
      const yAt = (v: number) => GH - (v / maxTotal) * (GH - 8) - 4;

      // stacked area: N₂O₄ on bottom, NO₂ on top
      const drawArea = (key: "n2o4" | "no2", base: (i: number) => number, fill: string, stroke: string) => {
        c.beginPath();
        c.moveTo(0, GH);
        for (let i = 0; i < hist.length; i++) c.lineTo(xAt(i), yAt(base(i) + hist[i][key]));
        for (let i = hist.length - 1; i >= 0; i--) c.lineTo(xAt(i), yAt(base(i)));
        c.closePath();
        c.fillStyle = fill; c.fill();
        c.beginPath();
        for (let i = 0; i < hist.length; i++) {
          const x = xAt(i), y = yAt(base(i) + hist[i][key]);
          i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
      };

      drawArea("n2o4", () => 0, "rgba(111,179,214,0.30)", "rgba(111,179,214,0.9)");
      drawArea("no2", (i) => hist[i].n2o4, "rgba(216,118,58,0.30)", "rgba(255,157,84,0.95)");
    }

    function publishSnapshot() {
      const arr = particles.current;
      let nNO2 = 0, nN2O4 = 0;
      for (const p of arr) p.kind === "no2" ? nNO2++ : nN2O4++;
      const vu = boxArea() / 10000; // volume in friendly units
      const cNo2 = nNO2 / vu;
      const cN2o4 = nN2O4 / vu;

      const f = rate.current.fwd, r = rate.current.rev;
      const tot = f + r;
      const balance = tot > 1e-4 ? (f - r) / tot : 0;
      let status: Snapshot["status"] = "eq";
      if (balance > 0.18) status = "fwd";
      else if (balance < -0.18) status = "rev";

      setSnap({ no2: nNO2, n2o4: nN2O4, cNo2, cN2o4, status });
    }

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- bind UI controls to the params ref ----
  useEffect(() => { params.current.Tk = temp; }, [temp]);
  useEffect(() => { params.current.volFrac = vol / 100; }, [vol]);
  useEffect(() => { params.current.catalyst = catalyst; }, [catalyst]);

  // ---- draggable piston ----
  const logicalX = (clientX: number) => {
    const rect = simRef.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  };
  const nearPiston = (x: number) => {
    const px = PAD + (W - 2 * PAD) * (vol / 100);
    return x > px - 16 && x < px + 24;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (nearPiston(logicalX(e.clientX))) {
      dragging.current = true;
      simRef.current!.setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = logicalX(e.clientX);
    simRef.current!.style.cursor = dragging.current || nearPiston(x) ? "ew-resize" : "default";
    if (!dragging.current) return;
    const vf = (x - PAD) / (W - 2 * PAD);
    setVol(Math.round(Math.max(0.45, Math.min(1, vf)) * 100));
  };
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragging.current) {
      dragging.current = false;
      try { simRef.current!.releasePointerCapture(e.pointerId); } catch {}
    }
  };

  // ---- handlers ----
  const act = (a: string) => {
    switch (a) {
      case "add-no2": addMolecule("no2"); break;
      case "rem-no2": removeMolecule("no2"); break;
      case "add-n2o4": addMolecule("n2o4"); break;
      case "rem-n2o4": removeMolecule("n2o4"); break;
    }
  };

  const statusText = snap.status === "eq" ? "at equilibrium"
    : snap.status === "fwd" ? "shifting forward — making N₂O₄"
    : "shifting reverse — making NO₂";

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div>
            <h1>Le&nbsp;Châtelier Lab</h1>
            <p className="sub">Watch a reversible reaction reach equilibrium — molecule by molecule.</p>
          </div>
        </div>
        <div className="equation">
          <span className="mol no2">2&nbsp;NO₂</span>
          <span className="arrows">⇌</span>
          <span className="mol n2o4">N₂O₄</span>
          <span className="dh">ΔH = −57 kJ · forward exothermic</span>
        </div>
      </header>

      <main>
        <section className="stage-wrap">
          <div className="stage">
            <canvas
              ref={simRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
              style={{ width: "100%", height: "auto", display: "block", touchAction: "none" }}
            />
            <div className="legend">
              <span><i className="dot no2" />NO₂ <small>brown · 2 mol</small></span>
              <span><i className="dot n2o4" />N₂O₄ <small>colorless · 1 mol</small></span>
            </div>
          </div>

          <div className="graph-card">
            <div className="graph-head">
              <span>Composition over time</span>
              <span className={`badge ${snap.status}`}>{statusText}</span>
            </div>
            <canvas ref={graphRef} style={{ width: "100%", height: "auto", display: "block" }} />
          </div>
        </section>

        <aside className="panel">
          <div className="readouts">
            <div className="ro">
              <span className="ro-label">NO₂ molecules</span>
              <span className="ro-val no2">{snap.no2}</span>
            </div>
            <div className="ro">
              <span className="ro-label">N₂O₄ molecules</span>
              <span className="ro-val n2o4">{snap.n2o4}</span>
            </div>
          </div>

          <div className="control">
            <label>Temperature <output>{temp} K</output></label>
            <input id="temp" type="range" min={200} max={600} step={1} value={temp}
              onChange={(e) => setTemp(+e.target.value)} />
            <p className="hint">Heat favors the endothermic split — more NO₂ (browner). Cooling favors the exothermic join — more N₂O₄.</p>
          </div>

          <div className="control">
            <label>Volume / Pressure <output>{vol}%</output></label>
            <input type="range" min={45} max={100} step={1} value={vol}
              onChange={(e) => setVol(+e.target.value)} />
            <p className="hint">Drag the piston in the chamber, or use this slider. Compress and the system shifts to the fewer-mole side (N₂O₄); expand and it shifts toward more molecules (NO₂).</p>
          </div>

          <div className="control row">
            <label className="switch">
              <input type="checkbox" checked={catalyst} onChange={(e) => setCatalyst(e.target.checked)} />
              <span className="slider-sw" />
            </label>
            <div>
              <strong>Catalyst</strong>
              <p className="hint">Speeds both directions equally — reaches equilibrium faster, but does <em>not</em> shift its position.</p>
            </div>
          </div>

          <div className="control">
            <label>Concentration</label>
            <div className="conc-row">
              <span className="conc no2">[NO₂] = {snap.cNo2.toFixed(2)} M</span>
              <span className="conc n2o4">[N₂O₄] = {snap.cN2o4.toFixed(2)} M</span>
            </div>
            <div className="btn-grid">
              <button className="btn no2" onClick={() => act("add-no2")}>+ NO₂</button>
              <button className="btn no2 ghost" onClick={() => act("rem-no2")}>− NO₂</button>
              <button className="btn n2o4" onClick={() => act("add-n2o4")}>+ N₂O₄</button>
              <button className="btn n2o4 ghost" onClick={() => act("rem-n2o4")}>− N₂O₄</button>
            </div>
          </div>
        </aside>
      </main>
    </>
  );
}
