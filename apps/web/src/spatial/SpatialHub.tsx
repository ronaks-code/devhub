import { OfficeVisualizer } from "./OfficeVisualizer";
import { fleetSnapshotFixture } from "./fleetSnapshot";

/** Existing spatial-route boundary, intentionally fixture-only for this build. */
export function SpatialHub(): React.JSX.Element {
  return <OfficeVisualizer snapshot={fleetSnapshotFixture} />;
}

export default SpatialHub;
