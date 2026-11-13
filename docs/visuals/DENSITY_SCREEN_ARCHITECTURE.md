# Density Screen Visual Architecture

All 15 diagrams for the Density Screen product page (`/products/density-screen`).

## Placement

| Slug | Section | Notes |
|------|---------|-------|
| density-screen-hero-binding-wall | Hero | Primary visual |
| density-screen-seven-inputs-card | What we need | Intake |
| density-screen-headroom-ladder | What you receive | Ladder |
| density-screen-deliverable-document | What you receive | Artefact |
| density-screen-engineer-review-gate | How it works | Review |
| density-screen-before-after-racks | Outcome | Delta |
| density-screen-data-request-sheet | What you receive | Data request |
| density-screen-time-to-power-delta | Why | Time comparison |
| density-screen-evidence-class-pills | Method | Evidence |
| density-screen-cost-vs-unlock | Outcome | Value |
| density-screen-hall-identity-card | Intake | Identity |
| density-screen-ladder-rung-detail | Ladder | Detail |
| density-screen-credits-against-study | Pricing | Credits |
| density-screen-five-day-timeline | How it works | Timeline |
| density-screen-final-cta-card | CTA | Order |

## Integration

Use the GridForgeVisual component or native Next Image with WebP source.

```tsx
<picture>
  <source srcSet="/images/visuals/density-screen-hero-binding-wall.webp" type="image/webp" />
  <Image src="/images/visuals/density-screen-hero-binding-wall.png" alt="..." width={1600} height={900} />
</picture>
```
