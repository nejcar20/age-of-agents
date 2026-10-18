import { useMemo, useState } from "react";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { landRect, type IslandView } from "../archipelago";
import { useTradeRoutes } from "./TradeRoutes";

/** Saved handoffs are connections, never a claim that agents are currently trading. */
export function TradeRouteLines({ islands }: { islands: IslandView[] }) {
  const trade = useTradeRoutes();
  const links = useMemo(() => {
    const byRoot = new Map(islands.map(island => [island.root, island]));
    const seen = new Set<string>();
    return (trade?.routes ?? []).flatMap(route => {
      const source = byRoot.get(route.sourceRoot);
      const target = byRoot.get(route.targetRoot);
      const key = JSON.stringify([route.sourceRoot, route.targetRoot]);
      if (!source || !target || seen.has(key)) return [];
      seen.add(key);
      return [{ key, source, target }];
    });
  }, [islands, trade?.routes]);
  return <group>{links.map(link => <RouteLine key={link.key} source={link.source} target={link.target} onSelect={() => trade?.showRoutes()} />)}</group>;
}

function RouteLine({ source, target, onSelect }: { source: IslandView; target: IslandView; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  const { points, arrow, orientation, scale, label } = useMemo(() => {
    const a = landRect(source), b = landRect(target);
    const start = new THREE.Vector3(a.x + a.w / 2, 0.5, a.z + a.d / 2);
    const end = new THREE.Vector3(b.x + b.w / 2, 0.5, b.z + b.d / 2);
    const distance = start.distanceTo(end);
    const direction = end.clone().sub(start).normalize();
    start.addScaledVector(direction, Math.min(distance * 0.25, Math.min(a.w, a.d) * 0.52));
    end.addScaledVector(direction, -Math.min(distance * 0.25, Math.min(b.w, b.d) * 0.52));
    const middle = start.clone().lerp(end, 0.5);
    middle.y += Math.min(7, distance * 0.07);
    const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
    return { points: curve.getPoints(40), arrow: curve.getPoint(0.65), label: curve.getPoint(0.5),
      orientation: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0.65)),
      scale: Math.max(0.15, Math.min(0.45, distance * 0.012)) };
  }, [source, target]);
  return <group onClick={event => { event.stopPropagation(); onSelect(); }} onPointerOver={event => { event.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
    <Line points={points} color={hovered ? "#e0eac8" : "#acd4c0"} lineWidth={hovered ? 2.5 : 1.6} dashed dashSize={0.7} gapSize={0.5} transparent opacity={hovered ? 1 : 0.7} />
    <mesh position={arrow} quaternion={orientation}><coneGeometry args={[scale, scale * 2.8, 3]} /><meshBasicMaterial color="#d6e3b5" toneMapped={false} /></mesh>
    {hovered && <Html position={label} center style={{ pointerEvents: "none", whiteSpace: "nowrap" }}><span className="trade-world-label">{source.name} → {target.name} · View route</span></Html>}
  </group>;
}
