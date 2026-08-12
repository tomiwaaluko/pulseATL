import { useEffect, useMemo, useRef } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type {
  GeoJSON as LeafletGeoJSON,
  Map as LeafletMap,
  Layer,
  LeafletMouseEvent,
  Path,
  PathOptions,
} from "leaflet";
import { GeoJSON, MapContainer, TileLayer } from "react-leaflet";
import npuGeoJsonRaw from "../../data/npus.geojson?raw";
import type { NpuSummary } from "../types";

/** Atlanta city centre — frames all 25 NPUs at zoom 11. */
const ATLANTA_CENTER: [number, number] = [33.762, -84.39];
const DEFAULT_ZOOM = 11;

interface NpuProperties {
  NPU: string;
}

const npuGeoJson = JSON.parse(npuGeoJsonRaw) as FeatureCollection<
  Geometry,
  NpuProperties
>;

/** Score gradient: red at 0 → amber at 50 → green at 100. */
export function scoreColor(score: number | undefined): string {
  if (score === undefined || Number.isNaN(score)) {
    return "#334155";
  }
  const clamped = Math.min(100, Math.max(0, score));
  // Hue 0 (red) → 120 (green), traversing amber at the midpoint.
  const hue = (clamped / 100) * 120;
  return `hsl(${hue.toFixed(0)}, 72%, 45%)`;
}

/** Legend stops, high score first so the swatch column reads green → red. */
const LEGEND_STOPS = [100, 75, 50, 25, 0];

interface PulseMapProps {
  npus: NpuSummary[];
  selectedNpu: string | null;
  onSelectNpu: (npu: string) => void;
}

export default function PulseMap({
  npus,
  selectedNpu,
  onSelectNpu,
}: PulseMapProps): JSX.Element {
  const scores = useMemo(() => {
    const byNpu = new Map<string, number>();
    for (const row of npus) {
      byNpu.set(row.npu, row.pulse_score);
    }
    return byNpu;
  }, [npus]);

  // react-leaflet memoises the GeoJSON layer, so styling reads live values
  // through a ref instead of relying on prop identity.
  const selectedRef = useRef(selectedNpu);
  selectedRef.current = selectedNpu;
  const scoresRef = useRef(scores);
  scoresRef.current = scores;
  const geoJsonRef = useRef<LeafletGeoJSON | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  const style = (feature?: Feature<Geometry, unknown>): PathOptions => {
    const npu = (feature?.properties as NpuProperties | undefined)?.NPU ?? "";
    const isSelected = npu === selectedRef.current;
    return {
      className: `npu-polygon npu-polygon--${npu}${
        isSelected ? " npu-polygon--selected" : ""
      }`,
      fillColor: scoreColor(scoresRef.current.get(npu)),
      fillOpacity: 0.65,
      color: isSelected ? "#f8fafc" : "#0f172a",
      weight: isSelected ? 3.5 : 1,
    };
  };

  // Restyle in place when the selection changes — cheaper than remounting.
  // Leaflet's setStyle only touches paint attributes, so the selection class is
  // toggled on the rendered element directly.
  useEffect(() => {
    const group = geoJsonRef.current;
    if (!group) {
      return;
    }
    group.setStyle(style);
    group.eachLayer((layer) => {
      const path = layer as Path & { feature?: Feature<Geometry, unknown> };
      const npu = (path.feature?.properties as NpuProperties | undefined)?.NPU;
      path
        .getElement()
        ?.classList.toggle("npu-polygon--selected", npu === selectedNpu);
    });
  }, [selectedNpu, scores]);

  // Frame every NPU once the layer exists, so the choropleth fills the
  // viewport instead of relying on a hardcoded zoom.
  const fitToNpus = (): void => {
    const map = mapRef.current;
    const group = geoJsonRef.current;
    if (map && group) {
      map.fitBounds(group.getBounds(), { padding: [24, 24] });
    }
  };

  const onEachFeature = (
    feature: Feature<Geometry, unknown>,
    layer: Layer
  ): void => {
    const npu = (feature.properties as NpuProperties).NPU;
    layer.on("click", (event: LeafletMouseEvent) => {
      event.originalEvent.stopPropagation();
      onSelectNpu(npu);
    });
    layer.bindTooltip(`NPU ${npu}`, { sticky: true });
  };

  return (
    <div className="relative h-full w-full" data-testid="pulse-map">
      <MapContainer
        ref={mapRef}
        center={ATLANTA_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom
        zoomControl={false}
        className="h-full w-full bg-slate-950"
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <GeoJSON
          ref={geoJsonRef}
          data={npuGeoJson}
          style={style}
          onEachFeature={onEachFeature}
          eventHandlers={{ add: fitToNpus }}
        />
      </MapContainer>

      <div
        className="pointer-events-none absolute bottom-6 left-6 z-[500] rounded-lg border border-slate-700/70 bg-slate-900/90 p-4 shadow-xl backdrop-blur"
        data-testid="map-legend"
      >
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
          Pulse score
        </p>
        <ul className="space-y-1">
          {LEGEND_STOPS.map((stop) => (
            <li key={stop} className="flex items-center gap-2 text-xs text-slate-300">
              <span
                className="inline-block h-3 w-6 rounded-sm"
                style={{ backgroundColor: scoreColor(stop) }}
              />
              <span className="tabular-nums">{stop}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
