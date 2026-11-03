// The arithmetic behind the "rack density against usable power" figure.
//
// Everything here is a published closed-form relation, the same one the constraint reference gives for the rack feed / tap-off
// rating: I = P / (sqrt(3) * V * pf). It is applied to a SYNTHETIC hall whose figures are invented for the illustration and say so.
// It is not the engine's solve and not a result for any real hall: the engine evaluates thirteen constraints together and this
// evaluates one relation and one count, to show a single point: total usable power says nothing about whether one rack can be fed.

export interface SyntheticHall {
  /** IT power the hall can deliver to racks, kW. Invented. */
  usableItKw: number;
  /** Free rack positions. Invented. */
  positions: number;
  /** Busway line-to-line voltage, V. */
  busVoltageV: number;
  powerFactor: number;
}

export const SYNTHETIC_HALL: SyntheticHall = { usableItKw: 2400, positions: 120, busVoltageV: 400, powerFactor: 0.95 };

/** Tap-off ratings compared in the figure, amps. */
export const TAP_OFF_BEFORE_A = 63;
export const TAP_OFF_AFTER_A = 250;

const SQRT3 = Math.sqrt(3);

/** Continuous current one rack draws on a three-phase feed, A. */
export function rackCurrentA(rackKw: number, voltageV: number, powerFactor: number): number {
  if (!(rackKw > 0) || !(voltageV > 0) || !(powerFactor > 0) || powerFactor > 1) throw new RangeError("rackCurrentA: positive kW and V, power factor in (0, 1]");
  return (rackKw * 1000) / (SQRT3 * voltageV * powerFactor);
}

/** The largest rack, kW, a tap-off of the given rating can feed continuously. */
export function maxRackKw(tapOffA: number, voltageV: number, powerFactor: number): number {
  if (!(tapOffA > 0) || !(voltageV > 0) || !(powerFactor > 0) || powerFactor > 1) throw new RangeError("maxRackKw: positive A and V, power factor in (0, 1]");
  return (SQRT3 * voltageV * powerFactor * tapOffA) / 1000;
}

/** Racks the hall's total power would carry if power were the only limit: the view an operator takes from a total-kW figure. */
export function racksByPowerOnly(hall: SyntheticHall, rackKw: number): number {
  return Math.floor(hall.usableItKw / rackKw);
}

/** Racks that can actually be placed: the power count, capped by free positions, and zero where one rack cannot be fed at all. */
export function racksFeedable(hall: SyntheticHall, rackKw: number, tapOffA: number): number {
  if (rackKw > maxRackKw(tapOffA, hall.busVoltageV, hall.powerFactor)) return 0;
  return Math.min(racksByPowerOnly(hall, rackKw), hall.positions);
}

export interface DensityPoint {
  rackKw: number;
  powerOnly: number;
  before: number;
  after: number;
}

/** The figure's data, one point per density step. Pure and deterministic, so the chart and its table cannot disagree. */
export function densitySeries(hall: SyntheticHall = SYNTHETIC_HALL, from = 10, to = 150, step = 5): DensityPoint[] {
  if (!(step > 0) || to < from) throw new RangeError("densitySeries: step must be positive and to >= from");
  const out: DensityPoint[] = [];
  for (let kw = from; kw <= to + 1e-9; kw += step) {
    out.push({
      rackKw: kw,
      powerOnly: racksByPowerOnly(hall, kw),
      before: racksFeedable(hall, kw, TAP_OFF_BEFORE_A),
      after: racksFeedable(hall, kw, TAP_OFF_AFTER_A),
    });
  }
  return out;
}
