import Anthropic from "@anthropic-ai/sdk";
import { URGENCY_OPTIONS, GRID_STATUS_OPTIONS, SERVICE_OPTIONS } from "@/lib/lead";

// Pulls structured lead fields from a conversation. Returns null when the
// dialogue lacks enough signal (so we never persist a half-empty "hello").
export interface ExtractedLead {
  capacity: string;
  location: string;
  urgency: (typeof URGENCY_OPTIONS)[number];
  gridStatus: (typeof GRID_STATUS_OPTIONS)[number];
  services: string[];
  message: string;
  name: string;
  company: string;
  email: string;
}

const EXTRACT_SYSTEM = `Extract structured lead data from this sales conversation between a prospect and the GridForge scoping engineer. Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "capacity": string (e.g. "60 MW" — empty "" if unknown),
  "location": string (site location — "" if unknown),
  "urgency": one of ${JSON.stringify(URGENCY_OPTIONS)} (map: site selected/ASAP→immediate, this quarter/few months→90days, exploring/no date→exploratory),
  "gridStatus": one of ${JSON.stringify(GRID_STATUS_OPTIONS)} (map their interconnection situation; "unknown" if unclear),
  "services": array from ${JSON.stringify(SERVICE_OPTIONS)} (best-fit; default ["Not sure yet — need a recommendation"]),
  "message": string (one-line summary of their situation),
  "name": string ("" if not given),
  "company": string ("" if not given),
  "email": string ("" if not given)
}

Rules:
- If you cannot determine capacity AND urgency AND gridStatus from the conversation, return exactly: {"insufficient": true}
- Never invent contact details. Leave name/company/email "" if not explicitly stated.
- Use "" for any field genuinely unknown.`;

export async function extractLead(
  messages: { role: "user" | "assistant"; content: string }[],
  apiKey: string
): Promise<ExtractedLead | null> {
  const anthropic = new Anthropic({ apiKey });
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: transcript }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.insufficient) return null;
    // Minimum viable signal gate
    if (!parsed.capacity || !parsed.urgency || !parsed.gridStatus) return null;
    return parsed as ExtractedLead;
  } catch {
    return null;
  }
}
