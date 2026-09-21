import type { AssistantTurn, CalibrationState } from "./types";

// Local stub for the chat response contract.
//
// reports/TTP-AI-AGENT-PLAN.md assigns the real /api/chat rewrite — a
// tool-calling loop against the live gridforge_* engine endpoints — to Agent 2
// (branch agent/ttp-ai-core), which has not merged. This module fabricates
// AssistantTurn objects that satisfy the SAME Zod contract
// (components/ai/types.ts) so every card in this directory can be built and
// screenshotted now, and swapped to the real endpoint later with no change to
// any card component.
//
// IMPORTANT: every number here is clearly-labeled placeholder data, not an
// engine result — see the "(mock)" provenance source on every quantity. Ship
// this against the real /api/chat before this reaches a customer: see
// getAssistantTurn() below for the one place that needs to change.

const CALIBRATION_EMPTY: CalibrationState = {
  empty: true,
  sampleSize: 0,
  note:
    "The calibration ledger has no field-validated results yet — every number here is engine " +
    "output (modelled/simulated/estimated), not measured accuracy against an instrumented site.",
};

function mockQuantity(
  value: number,
  unit: string,
  evidenceClass: "E0" | "E1" | "E2" | "E3",
  source: string,
  opts: Partial<{ low: number; high: number; label: string }> = {}
) {
  return {
    value,
    unit,
    evidenceClass,
    provenance: { digest: `mock:${source}:${value}`, source },
    ...opts,
  };
}

async function delay(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function capacityTurn(hallLabel: string): AssistantTurn {
  return {
    toolCalls: [{ tool: "gridforge_qualify", status: "ok", detail: hallLabel, durationMs: 640 }],
    blocks: [
      {
        type: "answer",
        text:
          `${hallLabel} carries about 210 GB300 NVL72 racks today as found, rising to roughly ` +
          `340 once the binding constraint is relieved. Busway ampacity sets the ceiling — see the ` +
          `card below for the relief path and the headroom ladder for the full sequence.`,
      },
      {
        type: "metric",
        metricKind: "capacity",
        hallLabel,
        platform: "GB300 NVL72",
        racksAsFound: mockQuantity(210, "racks", "E1", "gridforge_qualify", { low: 195, high: 224 }),
        racksAfterRelief: mockQuantity(340, "racks", "E1", "gridforge_qualify", { low: 310, high: 365 }),
        itLoadKW: mockQuantity(29_400, "kW", "E1", "gridforge_qualify"),
      },
      {
        type: "constraint",
        id: "busway_ampacity",
        name: "Busway ampacity",
        domain: "electrical",
        basis: "Existing busway is rated below the current draw of the target platform at full IT load.",
        maxRacks: mockQuantity(210, "racks", "E1", "gridforge_qualify"),
        binding: true,
        relief: {
          description: "Uprate the busway run to the next standard ampacity band.",
          capexEur: mockQuantity(1_850_000, "EUR", "E0", "mock-cost-library"),
          leadTimeWeeks: mockQuantity(14, "wk", "E0", "mock-cost-library"),
        },
      },
      {
        type: "evidence",
        items: [
          {
            label: "Busway ampacity rating",
            evidenceClass: "E1",
            provenance: { digest: "mock:busway:qualify", source: "gridforge_qualify" },
          },
        ],
        calibration: CALIBRATION_EMPTY,
      },
      {
        type: "commercialAction",
        productId: "density_screen",
        reason:
          "A qualify read is directional. A Density Screen replaces it with a defensible, " +
          "signed-off number for this hall in five working days.",
      },
    ],
  };
}

function bindingConstraintTurn(): AssistantTurn {
  return {
    toolCalls: [{ tool: "gridforge_qualify", status: "ok", durationMs: 580 }],
    blocks: [
      {
        type: "answer",
        text:
          "Tap-off rating binds before cooling does — this is the case in most halls we screen. " +
          "Thermal headroom exists; the electrical distribution built for the previous platform does not.",
      },
      {
        type: "constraint",
        id: "tapoff_rating",
        name: "Tap-off rating",
        domain: "electrical",
        basis: "PDU tap-off breakers are sized for the legacy rack platform's current draw, not the target platform's.",
        maxRacks: mockQuantity(184, "racks", "E1", "gridforge_qualify"),
        binding: true,
        relief: {
          description: "Re-terminate tap-offs at the next breaker frame size; no busway change needed.",
          capexEur: mockQuantity(420_000, "EUR", "E0", "mock-cost-library"),
          leadTimeWeeks: mockQuantity(6, "wk", "E0", "mock-cost-library"),
        },
      },
      {
        type: "constraint",
        id: "plant_supply_temp",
        name: "Plant supply temperature",
        domain: "thermal",
        basis: "Chilled water supply temperature has margin against the platform's max inlet liquid temperature.",
        maxRacks: mockQuantity(410, "racks", "E1", "gridforge_qualify"),
        binding: false,
      },
      {
        type: "evidence",
        items: [],
        calibration: CALIBRATION_EMPTY,
      },
    ],
  };
}

function headroomLadderTurn(hallLabel: string): AssistantTurn {
  return {
    toolCalls: [{ tool: "gridforge_screen", status: "ok", detail: hallLabel, durationMs: 1240 }],
    blocks: [
      {
        type: "answer",
        text: `The headroom ladder for ${hallLabel}: six rungs, each relieving the constraint that then binds.`,
      },
      {
        type: "metric",
        metricKind: "headroomLadder",
        hallLabel,
        steps: [
          { step: 1, label: "As found", racks: mockQuantity(210, "racks", "E1", "gridforge_screen"), reliefDescription: "No change." },
          {
            step: 2,
            label: "Re-terminate tap-offs",
            racks: mockQuantity(248, "racks", "E1", "gridforge_screen"),
            reliefDescription: "Next breaker frame size on existing busway.",
            capexEur: mockQuantity(420_000, "EUR", "E0", "mock-cost-library"),
            leadTimeWeeks: mockQuantity(6, "wk", "E0", "mock-cost-library"),
          },
          {
            step: 3,
            label: "Uprate busway",
            racks: mockQuantity(310, "racks", "E1", "gridforge_screen"),
            reliefDescription: "Uprate the busway run to the next standard ampacity band.",
            capexEur: mockQuantity(1_850_000, "EUR", "E0", "mock-cost-library"),
            leadTimeWeeks: mockQuantity(14, "wk", "E0", "mock-cost-library"),
          },
          {
            step: 4,
            label: "Add DLC loop",
            racks: mockQuantity(340, "racks", "E1", "gridforge_screen"),
            reliefDescription: "Direct-liquid-cooling loop for the residual air fraction.",
            capexEur: mockQuantity(2_600_000, "EUR", "E0", "mock-cost-library"),
            leadTimeWeeks: mockQuantity(20, "wk", "E0", "mock-cost-library"),
          },
          {
            step: 5,
            label: "Increase plant chiller capacity",
            racks: mockQuantity(365, "racks", "E1", "gridforge_screen"),
            reliefDescription: "Add chiller module; plant supply temperature was near its margin.",
            capexEur: mockQuantity(3_100_000, "EUR", "E0", "mock-cost-library"),
            leadTimeWeeks: mockQuantity(26, "wk", "E0", "mock-cost-library"),
          },
          {
            step: 6,
            label: "Contracted MW ceiling",
            racks: mockQuantity(365, "racks", "E1", "gridforge_screen"),
            reliefDescription: "Every relief exhausted — contracted grid supply now the ceiling.",
          },
        ],
      },
      {
        type: "commercialAction",
        productId: "envelope_study_deposit",
        reason:
          "This ladder is directional. The full Envelope Study prices every rung against your " +
          "actual site conditions and gives you a model pack you keep.",
      },
    ],
  };
}

function timeToPowerTurn(hallLabel: string): AssistantTurn {
  const series = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((month) => ({
    month,
    queueMW: month <= 22 ? Math.round((month / 22) * 60) : 60,
    onSiteMW: month <= 6 ? Math.round((month / 6) * 42) : 42,
  }));
  return {
    toolCalls: [{ tool: "gridforge_screen", status: "ok", detail: hallLabel, durationMs: 910 }],
    blocks: [
      {
        type: "answer",
        text:
          `${hallLabel} can be compute-online via the headroom ladder in about 6 months, against a ` +
          `22-month grid queue in this market — 16 months recovered.`,
      },
      {
        type: "metric",
        metricKind: "timeToPower",
        hallLabel,
        queueMonths: mockQuantity(22, "mo", "E0", "mock-market-queue"),
        onSiteMonths: mockQuantity(6, "mo", "E1", "gridforge_screen"),
        monthsRecovered: mockQuantity(16, "mo", "E0", "mock-derived"),
        series,
      },
      {
        type: "commercialAction",
        productId: "hall_watch",
        reason: "Keep this date current — Hall Watch re-solves the model every quarter and on every input change.",
      },
    ],
  };
}

function missingDataTurn(): AssistantTurn {
  return {
    toolCalls: [{ tool: "gridforge_qualify", status: "error", detail: "incomplete intake", durationMs: 210 }],
    blocks: [
      {
        type: "answer",
        text:
          "I can't solve this hall yet — two required inputs are missing. Give me these and I can run " +
          "the qualifier for a real read.",
      },
      {
        type: "missingInput",
        input: "Busway ampacity",
        unit: "A",
        required: true,
        whyItBinds: "Busway ampacity is the most common binding constraint we see — without it the solve can't rule electrical in or out.",
        howToGetIt: "Check the nameplate on the busway riser, or ask facilities for the as-built electrical single-line.",
      },
      {
        type: "missingInput",
        input: "Plant supply temperature",
        unit: "°C",
        required: true,
        assumed: "18°C (site-typical default)",
        whyItBinds: "Sets the thermal margin against the target platform's max inlet liquid temperature.",
        howToGetIt: "Read off the chilled-water plant's setpoint, or the BMS trend for the last 30 days.",
      },
      {
        type: "nextAction",
        label: "Run the free qualifier",
        description: "Seven numbers, no account — /qualify gives a directional read the moment you have them.",
        href: "/qualify",
      },
    ],
  };
}

function landingSuggestions(): AssistantTurn {
  return {
    toolCalls: [],
    blocks: [
      {
        type: "answer",
        text:
          "Tell me about the hall — approximate contracted MW, hall size, and where you are with the " +
          "grid connection — and I'll run it against the real engine, not narrate a guess.",
      },
      {
        type: "evidence",
        items: [],
        calibration: CALIBRATION_EMPTY,
      },
    ],
  };
}

/**
 * The one function to change when PR1 (agent/ttp-ai-core) lands: replace the
 * body with a fetch("/api/chat", ...) call and assistantTurnSchema.parse(json)
 * on the result. Every card component reads AssistantTurn/ResponseBlock only —
 * none of them know this is a mock.
 */
export async function getAssistantTurn(userText: string): Promise<AssistantTurn> {
  await delay(500 + Math.random() * 400);
  const t = userText.toLowerCase();

  if (/headroom|ladder|rung/.test(t)) return headroomLadderTurn("Hall A — Ashburn");
  if (/time to power|queue|months|when.*(online|live)/.test(t)) return timeToPowerTurn("Hall A — Ashburn");
  if (/missing|don't know|dont know|not sure|unknown/.test(t)) return missingDataTurn();
  if (/binding|what.*binds|constraint/.test(t)) return bindingConstraintTurn();
  if (/capacity|racks|how much|mw|power/.test(t)) return capacityTurn("Hall A — Ashburn");

  return landingSuggestions();
}
