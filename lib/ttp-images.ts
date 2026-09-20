// Time to Power — reference photography registry.
//
// Every asset here is a generated (synthetic) reference photograph from
// time-to-power-image-pack-v1. None of it is a customer site, a licensed
// photograph of a named facility, or evidence of measured performance —
// see IMAGE_METADATA.json in the pack for the full provenance record.
//
// Every consumer of TTP_IMAGES must render `caption` (or fold it into the
// visible alt/caption text) so the honesty convention travels with the image
// wherever it is used, per the gridforge / honesty-kernel skills.

export const REFERENCE_PHOTO_NOTICE =
  "Reference photography — not a customer site; not measured evidence.";

export type TtpImageId =
  | "ttp-01"
  | "ttp-02"
  | "ttp-03"
  | "ttp-04"
  | "ttp-05"
  | "ttp-06"
  | "ttp-07"
  | "ttp-08"
  | "ttp-09"
  | "ttp-10"
  | "ttp-11"
  | "ttp-12"
  | "ttp-13"
  | "ttp-14"
  | "ttp-15"
  | "ttp-16"
  | "ttp-17";

export interface TtpImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** Shown near the image, alongside the alt text, to disclose it is synthetic. */
  caption: string;
}

function img(
  file: string,
  width: number,
  height: number,
  alt: string
): TtpImage {
  return {
    src: `/images/ttp/${file}`,
    width,
    height,
    alt,
    caption: REFERENCE_PHOTO_NOTICE,
  };
}

export const TTP_IMAGES: Record<TtpImageId, TtpImage> = {
  "ttp-01": img(
    "ttp-01-existing-data-center-campus-hero.webp",
    3840,
    1646,
    "Elevated view of an existing European data-center campus with on-site electrical substation, transformers and service roads."
  ),
  "ttp-02": img(
    "ttp-02-high-density-ai-rack-liquid-cooling.webp",
    3200,
    1800,
    "Data-center hall with rows of high-density compute racks and overhead liquid-cooling pipework."
  ),
  "ttp-03": img(
    "ttp-03-existing-hall-retrofit.webp",
    3200,
    1800,
    "Existing data-center hall with legacy lower-density racks and a denser liquid-cooled AI rack zone being retrofitted."
  ),
  "ttp-04": img(
    "ttp-04-electrical-room-switchgear-transformer.webp",
    2400,
    1600,
    "Data-center electrical room with distribution switchgear, a transformer section, copper bus and cable trays."
  ),
  "ttp-05": img(
    "ttp-05-busway-tapoff-detail.webp",
    2400,
    1600,
    "Overhead data-center busway and rack tap-off enclosure feeding a high-density rack."
  ),
  "ttp-06": img(
    "ttp-06-transformer-switchgear-corridor.webp",
    3200,
    1800,
    "Service corridor of a data-center electrical plant with transformers and MV/LV switchgear."
  ),
  "ttp-07": img(
    "ttp-07-liquid-cooling-cdu.webp",
    2400,
    1600,
    "Facility coolant distribution unit with pumps, heat-exchange pipework and connections toward liquid-cooled racks."
  ),
  "ttp-08": img(
    "ttp-08-data-center-mechanical-cooling-plant.webp",
    3200,
    1800,
    "Data-center mechanical plant with insulated chilled-water pipework, pumps and heat-exchange equipment."
  ),
  "ttp-09": img(
    "ttp-09-data-center-substation.webp",
    3200,
    1800,
    "Utility substation with transformers and buswork adjacent to data-center buildings."
  ),
  "ttp-10": img(
    "ttp-10-heavy-ai-rack-raised-floor.webp",
    2400,
    1800,
    "High-density AI rack base standing on a raised-floor tile system with liquid-cooling connections at the cabinet."
  ),
  "ttp-11": img(
    "ttp-11-engineer-site-inspection.webp",
    2400,
    1600,
    "Facilities engineer inspecting data-center rack infrastructure while holding a tablet."
  ),
  "ttp-12": img(
    "ttp-12-engineering-data-room-review.webp",
    3200,
    1800,
    "Engineers reviewing data-center drawings and single-line documents in a technical meeting room."
  ),
  "ttp-13": img(
    "ttp-13-procurement-bid-review.webp",
    3200,
    1800,
    "Engineers and procurement professionals reviewing supplier submissions for data-center infrastructure."
  ),
  "ttp-14": img(
    "ttp-14-field-calibration-instrumentation.webp",
    2400,
    1600,
    "Clamp-on electrical measurement and pipe-mounted thermal sensors installed in an operational data-center hall."
  ),
  "ttp-15": img(
    "ttp-15-multi-site-data-center-portfolio.webp",
    3200,
    1800,
    "Aerial view of several data-center campuses and substations in a European industrial landscape."
  ),
  "ttp-16": img(
    "ttp-16-engineer-machine-interface.webp",
    3200,
    1800,
    "Infrastructure engineer working at a workstation beside live server racks, screens unreadable."
  ),
  "ttp-17": img(
    "ttp-17-infrastructure-decision-room.webp",
    3200,
    1800,
    "Infrastructure investment meeting in a boardroom overlooking a data-center campus."
  ),
};
