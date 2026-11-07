// Who Time to Power is for, one record per buyer, written from that buyer's own decision rather than one paragraph with the noun swapped.
//
// What is here is prose and routing only. Prices, names and turnarounds are read from the catalogue (lib/products.ts) when a page renders, and
// the constraint names from the public reference, so nothing here can drift from what checkout sells or what the engine publishes. No record
// states a customer, a result, a saving or a date: each describes the buyer's situation and what the deliverable would and would not tell them.
// tests/site/audiences.test.ts holds the records to that, and to being genuinely different from each other.

import type { ProductId } from "@/lib/products";

export type AudienceSlug =
  | "existing-owners"
  | "colocation"
  | "ai-operators"
  | "developers"
  | "investors"
  | "engineering-teams"
  | "advisors";

/** One step the buyer can take, and the reason it comes at that point for this buyer. */
export interface PathStep {
  /** A catalogue product, or the free qualifier. */
  kind: "qualifier" | ProductId;
  why: string;
}

export interface Audience {
  slug: AudienceSlug;
  /** Plural, as a heading: "Colocation operators". */
  name: string;
  /** Singular role, used in sentences. */
  role: string;
  /** One line for cards and the index. */
  summary: string;
  /** The page's H1: the buyer's problem in their own words. */
  headline: string;
  /** What this buyer is deciding, and why the answer is hard to get today. */
  situation: string[];
  /** The decision the work informs. */
  decision: string;
  /** What this buyer may already hold, so the first step is small. */
  alreadyHave: string[];
  /** The constraints most likely to decide this buyer's answer, by public slug, and why for them specifically. */
  constraints: { slug: string; why: string }[];
  /** The route through the offers, in order. */
  path: PathStep[];
  /** What you should ask any provider, including us, before relying on the answer. */
  askUs: string[];
  /** What this buyer should not read into the result. */
  notWhat: string[];
  /** The one question a first visit should leave them able to answer. */
  firstQuestion: string;
}

export const AUDIENCES: Audience[] = [
  {
    slug: "existing-owners",
    name: "Existing data-centre owners",
    role: "owner of an existing data hall",
    summary: "You hold contracted megawatts in a hall built for lower density, and need to know what stops the next AI rack.",
    headline: "The megawatts are contracted. What stops them becoming AI compute?",
    situation: [
      "A hall designed for air-cooled racks in single-digit kilowatts is being asked to take liquid-cooled racks that draw an order of magnitude more. The grid agreement says how much power the site may import; it does not say how much of that can be delivered to a rack position.",
      "Which limit binds first? It may be a component between the transformer and the rack, such as a tap-off unit, a busway run or a UPS block, and the person who knows that rating may not be the person asked for the density commitment.",
      "Is the binding constraint in writing? If it is not, a commitment to a customer rests on a total-kilowatt figure, which says nothing about whether one position can be fed.",
    ],
    decision: "Whether this hall is worth a full densification study, which constraint the study should start with, and what to tell a prospective tenant today.",
    alreadyHave: [
      "Contracted capacity, current peak and current IT load, from the grid agreement and the building management system",
      "Busway ampacity and tap-off rating from the as-built drawings or a walk of the hall",
      "Plant supply temperature and the target platform from the facilities team and the customer's brief",
    ],
    constraints: [
      { slug: "rack-feed-tapoff-rating", why: "It binds at the first rack, not at scale, and is the item an operator is least likely to have checked." },
      { slug: "busway-ampacity", why: "Higher-rated tap-offs do nothing if the busway behind them cannot carry the current." },
      { slug: "transformer-capacity", why: "It can set the date for the whole retrofit when its lead time is the longest on the ladder." },
    ],
    path: [
      { kind: "qualifier", why: "Seven numbers you already know, free, to see which constraint is likely to bind before spending anything." },
      { kind: "density_screen", why: "The first paid step: one hall, a document naming what binds and the first costed rungs, which you can hand to your own engineers." },
      { kind: "envelope_study_deposit", why: "When the screen shows the hall is worth pursuing: the full ladder, architectures compared and a model pack you keep." },
    ],
    askUs: [
      "Which inputs in the result were assumed rather than supplied, and which are the most sensitive?",
      "Which evidence class does each figure carry, and what would it take to raise it?",
      "Does any date rest on a lead time we assumed instead of one a supplier quoted?",
    ],
    notWhat: [
      "It is not a design, a sign-off or a statement that the hall will carry the racks. It identifies what binds so that your engineers check it.",
      "A hall that passes the screen has not been shown to be safe to load: protection, commissioning and structural checks are outside it.",
    ],
    firstQuestion: "Which single component stops the next AI rack in my hall?",
  },
  {
    slug: "colocation",
    name: "Colocation operators",
    role: "colocation operator",
    summary: "You sell capacity to tenants who now ask for density your halls were not built for, and need a number you can defend.",
    headline: "A tenant has asked for liquid-cooled racks. Which of your halls can honestly say yes?",
    situation: [
      "Where vacancy is low, the question from a prospective AI tenant moves from whether you have space to whether the space can be fed and cooled at the density they plan, and by when.",
      "Operators carry many halls of different vintages. A hall-by-hall answer built on each site's own assumptions makes the portfolio impossible to compare, and the hall that looks best on total kilowatts is not always the one that can host the racks soonest.",
      "A commitment made to a tenant is a commercial one. A figure that is wrong in either direction costs something: overpromise and you carry the penalty, underpromise and the tenant signs elsewhere.",
    ],
    decision: "Which halls to offer a given AI tenant, at what density, and which relief to start ordering first.",
    alreadyHave: [
      "Per-hall contracted and committed capacity from your own capacity management records",
      "As-built electrical single-lines and busway layouts for each hall",
      "Existing tenant loads and the density each tenant is already contractually allowed",
    ],
    constraints: [
      { slug: "available-rack-positions", why: "Free positions on paper are not the same as positions that can be fed at the tenant's density." },
      { slug: "ups-capacity", why: "Shared protected capacity across tenants is where one tenant's increase becomes another's limit." },
      { slug: "cdu-capacity-site-conditions", why: "Liquid cooling shifts the question from the room to the distribution unit and the site's own conditions." },
    ],
    path: [
      { kind: "qualifier", why: "Run it on the hall a tenant is asking about to see the likely binding constraint before a commercial conversation." },
      { kind: "density_screen", why: "One hall, with the inputs nobody has measured listed so they can be measured before the tenant signs." },
      { kind: "portfolio_screen_deposit", why: "Several halls ranked under one methodology, so the offer goes to the hall that can deliver soonest." },
      { kind: "hall_watch", why: "Tenants and loads change; a hall re-solved each quarter keeps the answer current." },
    ],
    askUs: [
      "Is the ranking of halls stable if the assumed inputs move within their stated ranges?",
      "Which hall's result rests on the weakest evidence, so we know where to measure first?",
      "How is shared UPS and cooling capacity treated across tenants in the result?",
    ],
    notWhat: [
      "A ranking is not a commitment to any tenant and not a statement of what a tenant's contract permits.",
      "The result does not read your tenants' meter data unless you supply it, and it says so where it did not.",
    ],
    firstQuestion: "Of my halls, which can host this tenant's density soonest, and what sets the date?",
  },
  {
    slug: "ai-operators",
    name: "AI infrastructure operators",
    role: "AI infrastructure operator",
    summary: "You are placing GPU racks in leased or owned halls and need to know how many of a platform a hall will actually carry.",
    headline: "How many racks of the platform you bought can this hall actually carry?",
    situation: [
      "A platform's published rack power and its liquid-cooling flow describe a rack, not a hall. How many racks a hall carries is set by whichever distribution, cooling or physical limit runs out first, and that is a property of the hall.",
      "A purchase order for racks gets ahead of the facility. The compute can arrive months before the hall can feed it, and the cost of idle accelerators is paid while the binding constraint is relieved.",
      "Nameplate megawatts and useful delivered compute are different numbers: the gap between them is distribution headroom, cooling headroom and the operating margin the hall needs to keep.",
    ],
    decision: "How many racks of a chosen platform to order for a hall, in what phases, and which facility work has to run ahead of delivery.",
    alreadyHave: [
      "The target platform and rack count in the purchase plan",
      "The hall's contracted power and cooling capacity from the lease or the operator",
      "A view of the hall's distribution from the operator, or the questions to ask them",
    ],
    constraints: [
      { slug: "cooling-architecture-capability", why: "Whether the hall's cooling architecture can take the platform's liquid share at all is a threshold, not a margin." },
      { slug: "hydraulic-flow-capacity", why: "Liquid-cooled racks ask for flow, and the loop's flow limit is separate from its heat limit." },
      { slug: "rack-feed-tapoff-rating", why: "The platform's rack current meets the hall's oldest copper at the rack position." },
    ],
    path: [
      { kind: "qualifier", why: "Test the hall you are about to lease or load against the platform before the order is firm." },
      { kind: "density_screen", why: "A document you can give the hall's operator, naming what binds and what they would need to relieve." },
      { kind: "procurement_spec", why: "When the relief is decided: a tender-ready specification and a comparison of the bids in racks and weeks." },
    ],
    askUs: [
      "Which published platform figure does the result use, and where does it come from?",
      "How many racks does the hall carry as it stands, and after each costed rung?",
      "Which relief sets the date, and is its lead time assumed or supplied?",
    ],
    notWhat: [
      "It does not model a platform's performance or training throughput. It models the facility's capacity to host the platform.",
      "A platform that is not in the published library is not guessed at: the result says it cannot be solved.",
    ],
    firstQuestion: "How many racks of this platform does this hall carry as it stands, and what raises the number?",
  },
  {
    slug: "developers",
    name: "Data-centre developers",
    role: "data-centre developer",
    summary: "You are converting or extending a facility and need the electrical and thermal envelope early, before design money is committed.",
    headline: "Before you commit design money: what envelope does the building you already have actually give you?",
    situation: [
      "A conversion or extension decision is made early and cheaply, then paid for late and expensively. The envelope of the existing building, meaning what it can distribute and reject at the density you intend, is the input that decides whether the scheme works.",
      "A new grid connection can be years away in some markets, which makes the capacity of what already exists the near-term asset. A design team will find the limits eventually; the value of finding them first is in the price you pay for the site and the programme you commit to.",
      "A screen is not a design. Its job is to tell you which constraints a design will have to relieve and roughly in which order, so the scoping of the design package is not a guess.",
    ],
    decision: "Whether to proceed with a facility, which relief to scope into the design brief, and which long-lead items to start early.",
    alreadyHave: [
      "The facility's as-built or concept electrical and mechanical description",
      "The planned platform and the target density",
      "The utility's connection offer or position, where there is one",
    ],
    constraints: [
      { slug: "firm-supply-capacity", why: "Contracted import and what can be relied on in contingency are different, and the gap is a design driver." },
      { slug: "transformer-capacity", why: "Long-lead equipment that should be ordered, or ruled out, before the design is complete." },
      { slug: "floor-loading", why: "Liquid-cooled racks are heavy, and a slab that cannot take them is not a retrofit item." },
    ],
    path: [
      { kind: "qualifier", why: "A first read from a handful of figures, before any engineer's time is spent." },
      { kind: "density_screen", why: "A defined first deliverable for a defined fee, to decide whether to commission more." },
      { kind: "envelope_study_deposit", why: "The full ladder with time to power and economics, as the input to the design brief." },
    ],
    askUs: [
      "Which constraints in the result depend on a library default instead of the facility's own data?",
      "Which relief is long-lead, and is its lead time a range from a library or a figure someone quoted?",
      "What would the design team have to confirm to raise the result's evidence class?",
    ],
    notWhat: [
      "It does not replace a design, a structural survey or a utility application, and it must not be filed as one.",
      "It does not forecast a connection date. A date it shows is a modelled date with its assumed lead times named.",
    ],
    firstQuestion: "What does this building let me deliver at the density I intend, and what has to be relieved first?",
  },
  {
    slug: "investors",
    name: "Infrastructure investors",
    role: "infrastructure investor",
    summary: "You are underwriting a hall or a portfolio and need to know how much of the stated capacity is useful AI compute, and on what evidence.",
    headline: "The asset is described in megawatts. How many of them can run AI racks, and how sure is anyone?",
    situation: [
      "A data-centre asset may be described by its contracted power. For an AI thesis the relevant number is the compute the hall can host, which depends on constraints that description may not mention.",
      "Underwriting needs the answer and the confidence in it. A figure that rests on a library default is not the same as one built from the seller's measured data, and a diligence note that does not separate them is hiding the variance that matters.",
      "A portfolio view needs one methodology across assets. Ranking halls by figures prepared under different assumptions compares the assumptions, not the halls.",
    ],
    decision: "What an asset is worth as AI capacity, which assets in a set are worth pursuing, and which questions to put to a seller before a price is set.",
    alreadyHave: [
      "The seller's data room: single-lines, capacity records and tenant schedules",
      "The investment thesis, including the platform and density it assumes",
      "A short list of candidate assets",
    ],
    constraints: [
      { slug: "firm-supply-capacity", why: "Capacity that cannot be relied on in contingency is not capacity a lender will count." },
      { slug: "ups-capacity", why: "Protected load is the ceiling on what a tenant can be promised without redundancy being given up." },
      { slug: "transformer-capacity", why: "Its lead time is the single most common reason a stated uplift arrives later than the model." },
    ],
    path: [
      { kind: "density_screen", why: "One asset: a defensible read of what binds it and which inputs the seller has not evidenced." },
      { kind: "portfolio_screen_deposit", why: "Five to fifteen assets ranked under one methodology, so the comparison is between halls and not between spreadsheets." },
    ],
    askUs: [
      "How much of each result is assumed, and what is the weakest evidence class behind the headline figure?",
      "Is a date in the result dependent on a lead time the seller supplied or one the library assumed?",
      "Which inputs, if the seller confirmed them, would move the ranking?",
    ],
    notWhat: [
      "It is not a technical due-diligence report and not a valuation. It is an input to both.",
      "No figure is a forecast of revenue, yield or market growth; the engine does not produce any.",
    ],
    firstQuestion: "How much of the stated capacity is useful AI compute, and how much of that answer is assumption?",
  },
  {
    slug: "engineering-teams",
    name: "Energy and electrical engineering teams",
    role: "electrical or energy engineer",
    summary: "You will be asked to sign off or deliver the work, and need to see the method, the inputs and the equations before you rely on it.",
    headline: "Read the method, check the equations, and run it yourself before you rely on a number.",
    situation: [
      "A screening result is only as useful as your ability to reproduce it. The relations behind each constraint are published with their inputs and a worked example, so you can recompute a result by hand and see where you disagree.",
      "The engine takes inputs a client may not have complete. What matters to an engineer is that every gap is named, every default is labelled an assumption, and the result carries the weakest evidence class that went into it, so you know what to measure.",
      "The engine runs with no dependencies on the standard library, so it can be reviewed and run in an air-gapped environment, and exposes the same solve as an API and an MCP endpoint for tooling you already have.",
    ],
    decision: "Whether the method is sound enough to use as a screening tool, where it disagrees with your own calculation, and what to measure to close the gap.",
    alreadyHave: [
      "Your own single-lines, ratings and calculations to compare against",
      "The hall's measured data, if there is any, which the engine accepts as client-supplied (E5) input",
    ],
    constraints: [
      { slug: "busway-ampacity", why: "A pooled-run model and a run-by-run model give different rack counts; the difference is documented." },
      { slug: "hydraulic-flow-capacity", why: "A flow limit compared against the loop's demand is a check you can repeat from the published relation." },
      { slug: "achievable-facility-water-temperature", why: "A temperature approach is where assumed and measured inputs diverge most." },
    ],
    path: [
      { kind: "qualifier", why: "See what the engine asks for and what it returns, with nothing to sign." },
      { kind: "api_triage", why: "Run the engine from your own tooling with a metered key, screening-mode output only." },
      { kind: "density_screen", why: "A reviewed document for one hall, to put in front of a colleague or a client." },
    ],
    askUs: [
      "Which review findings are still open, and where is the calibration record?",
      "Which models are simulations and which are closed-form relations?",
      "Where do your published limitations say the model is weakest?",
    ],
    notWhat: [
      "The calibration ledger is empty today: the models have not been checked against measured data from a real hall.",
      "Output is screening-mode. It carries no named signatory and no professional indemnity.",
    ],
    firstQuestion: "Can I reproduce this number, and which of its inputs are assumptions?",
  },
  {
    slug: "advisors",
    name: "Procurement and technical advisors",
    role: "procurement or technical advisor",
    summary: "You advise a client on what to buy and when, and need a specification and a way to compare bids on the capacity they deliver.",
    headline: "Compare bids by the racks and weeks they deliver, not only by their price.",
    situation: [
      "Once a constraint is known, the work moves to buying its relief. A tender whose specification was written from a supplier's reference case compares bids against the supplier's assumptions and not the client's site.",
      "A bid is a price, a duty and a delivery time. Which bid is best depends on what each does to the energisation date and the rack count, and that comparison cannot be made without a model of the hall.",
      "Your client needs a document they can send to suppliers and a record of why the winner won. Both are stronger when the duties in the specification are derived from the hall's own capacity model at its own site conditions.",
    ],
    decision: "What to put in the specification, which bid to recommend, and how to show the client why.",
    alreadyHave: [
      "The client's constraint or brief, from a screen or a study, or from your own work",
      "A shortlist of suppliers and the bids as they come in",
    ],
    constraints: [
      { slug: "transformer-capacity", why: "The item with the longest delivery time, so the one where a bid's delivery commitment matters most." },
      { slug: "cdu-capacity-site-conditions", why: "Duty quoted at a supplier's reference condition and duty at the site's own conditions are different numbers." },
      { slug: "chilled-water-plant-capacity", why: "A plant bid has to be compared against the hall's plant headroom, not its nameplate." },
    ],
    path: [
      { kind: "density_screen", why: "Establish what binds and which relief to specify, if you do not already have it." },
      { kind: "procurement_spec", why: "A tender-ready specification for one relief with duties derived from the capacity model, and the bids compared in racks and weeks." },
      { kind: "hall_watch", why: "Keep the model live while the relief is procured, so a change in an input is reflected in the decision." },
    ],
    askUs: [
      "Which duties in the specification were derived from the model, and at which site conditions?",
      "Does the bid comparison use the supplier's quoted delivery time, and is it labelled as quoted?",
      "What does each bid do to the date and to the rack count, and what is the evidence class of each?",
    ],
    notWhat: [
      "We do not sell or recommend a make or a model, hold inventory or take a margin on equipment. The specification is for you to send to suppliers you choose.",
      "A comparison is not a procurement commitment or a supplier endorsement.",
    ],
    firstQuestion: "Which bid delivers the most racks soonest at this hall's own site conditions?",
  },
];

export function audienceBySlug(slug: string): Audience | undefined {
  return AUDIENCES.find((a) => a.slug === slug);
}
