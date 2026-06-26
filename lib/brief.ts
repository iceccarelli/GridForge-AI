import { SITING_REGIONS, sitingScore, costOfDelay, eurCompact, type SitingRegion } from "@/lib/siting";

// One-page board brief. Branded, transparent, and built from the SAME model the
// dashboard uses, so the figures a developer screenshots match the PDF they
// walk into a board meeting with. This is the artifact that does the selling.
export async function generateSitingBrief(opts: {
  mw: number;
  region: SitingRegion;
  valuePerMwMonth: number;
  analysis?: string | null;
  preparedFor?: string;
}) {
  const { mw, region, valuePerMwMonth, analysis, preparedFor } = opts;
  const { jsPDF } = await import("jspdf");
  const d = costOfDelay(mw, region, valuePerMwMonth);
  const ranked = [...SITING_REGIONS].map((r) => ({ ...r, score: sitingScore(r) })).sort((a, b) => b.score - a.score);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  let y = 56;

  const power: [number, number, number] = [56, 189, 248];
  const ink: [number, number, number] = [15, 23, 42];
  const mute: [number, number, number] = [100, 116, 139];
  const setText = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2]);

  // Header
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); setText(ink);
  doc.text("GridForge Intelligence", M, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); setText(mute);
  doc.text("Behind-the-meter siting brief", M, y + 16);
  doc.text(new Date().toLocaleDateString("en-IE", { year: "numeric", month: "long", day: "numeric" }), W - M, y, { align: "right" });
  if (preparedFor) doc.text("Prepared for " + preparedFor, W - M, y + 16, { align: "right" });
  y += 40;
  setDraw(power); doc.setLineWidth(2); doc.line(M, y, W - M, y); y += 30;

  // Headline figure
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); setText(ink);
  doc.text("RECOMMENDED PATH — " + region.region + " (" + region.market + ")", M, y); y += 24;
  doc.setFontSize(30); setText(power);
  doc.text(eurCompact(d.avoidedEur) + " unlocked", M, y); y += 22;
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); setText(ink);
  doc.text(d.monthsSaved + " months sooner to revenue for a " + mw + " MW site via behind-the-meter power.", M, y); y += 30;

  // Queue vs BTM comparison
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); setText(ink);
  doc.text("Queue path:", M, y);
  doc.setFont("helvetica", "normal"); setText(mute);
  doc.text(region.queueWaitMonths + " months  —  " + eurCompact(d.queueCostEur) + " stranded", M + 90, y); y += 16;
  doc.setFont("helvetica", "bold"); setText(ink);
  doc.text("BTM path:", M, y);
  doc.setFont("helvetica", "normal"); setText(mute);
  doc.text(region.btmMonths + " months  —  " + eurCompact(d.btmCostEur), M + 90, y); y += 28;

  // Ranked table
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); setText(ink);
  doc.text("Global markets ranked — fastest to energize", M, y); y += 18;
  doc.setFontSize(8); setText(mute);
  const cols = [M, M + 180, M + 250, M + 320, M + 390, M + 460];
  doc.text("MARKET / REGION", cols[0], y);
  doc.text("SCORE", cols[1], y); doc.text("€/MWh", cols[2], y);
  doc.text("QUEUE", cols[3], y); doc.text("BTM", cols[4], y); doc.text("RENEW", cols[5], y);
  y += 6; setDraw(mute); doc.setLineWidth(0.5); doc.line(M, y, W - M, y); y += 12;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  ranked.forEach((r, i) => {
    setText(i === 0 ? ink : mute);
    if (i === 0) doc.setFont("helvetica", "bold"); else doc.setFont("helvetica", "normal");
    doc.text(r.region.slice(0, 30), cols[0], y);
    doc.text(String(r.score), cols[1], y);
    doc.text(String(Math.round(r.powerCost)), cols[2], y);
    doc.text(r.queueWaitMonths + "mo", cols[3], y);
    doc.text(r.btmMonths + "mo", cols[4], y);
    doc.text(r.renewablePct + "%", cols[5], y);
    y += 15;
  });
  y += 14;

  // AI analyst recommendation
  if (analysis) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); setText(ink);
    doc.text("Analyst recommendation", M, y); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); setText(ink);
    const lines = doc.splitTextToSize(analysis, W - M * 2);
    for (const ln of lines) {
      if (y > 760) { doc.addPage(); y = 56; }
      doc.text(ln, M, y); y += 13;
    }
    y += 10;
  }

  // Footer / honesty
  if (y > 740) { doc.addPage(); y = 56; }
  setDraw(mute); doc.setLineWidth(0.5); doc.line(M, y, W - M, y); y += 14;
  doc.setFontSize(7.5); setText(mute);
  const disc = "Figures combine live feeds (EPEX day-ahead for Central EU) with documented modeled estimates (US/Nordic queue and cost bands from published ISO reports). Stranded value assumes " + eurCompact(valuePerMwMonth) + "/MW-month. Directional, not bankable — a paid GridForge Power Audit confirms site-specific figures. timetopower.ai";
  const dlines = doc.splitTextToSize(disc, W - M * 2);
  doc.text(dlines, M, y);

  doc.save("GridForge-Siting-Brief-" + region.market + "-" + mw + "MW.pdf");
}
