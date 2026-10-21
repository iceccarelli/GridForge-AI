// How a value and its unit are written next to each other.
//
// The engine labels dimensionless quantities (a power factor, an efficiency, a derating factor) with the unit "1", which is
// correct for a machine and wrong for a reader: "0.97 1" and "0.9 1" were printed on a buyer's page. A dimensionless unit is
// not shown; every other unit is, separated by a space. Pure: used by server pages and client cards alike.

const DIMENSIONLESS = new Set(["", "1", "-", "–", "—", "dimensionless", "unitless", "none", "n/a", "ratio", "fraction"]);

/** The unit as a reader should see it: empty when it is dimensionless, null or missing. */
export function displayUnit(unit: unknown): string {
  if (typeof unit !== "string") return "";
  const u = unit.trim();
  return DIMENSIONLESS.has(u.toLowerCase()) ? "" : u;
}

/** "0.97" for a dimensionless value, "38 °C" otherwise. A unit that starts with "%" or "°" is still spaced, as the site writes "38 °C". */
export function quantityText(value: number | string, unit: unknown): string {
  const u = displayUnit(unit);
  return u ? `${value} ${u}` : `${value}`;
}
