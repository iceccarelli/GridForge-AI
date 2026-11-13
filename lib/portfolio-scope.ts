// How many halls a Portfolio Screen is, said once. There are three different numbers and they mean three different things; each customer-visible
// sentence about a hall count is built from this file so that none of them can contradict another.
//
//   SOLD     five to fifteen halls   the engagement as it is sold: the price band is for that range and the fee is agreed in writing before work starts.
//   FORM     two to fifteen halls    what the hall-list form accepts (lib/engagement-intake.ts PORTFOLIO_MIN_HALLS / PORTFOLIO_MAX_HALLS). Two is the least a
//                                    ranking means anything for; it is a limit of the form, not a statement that two halls is what is sold.
//   ENGINE   up to 50 halls          what one POST /v1/portfolio request may rank (gridforge/api/metering.py MAX_PORTFOLIO_HALLS). A bound on the work a request
//                                    can demand, not a scope: tests/site/portfolio-scope.test.ts reads it from the engine's source.
//
// More than fifteen halls is a separate engagement. This file is pure data (no React, no I/O) so a client component can import it.
// tests/site/portfolio-scope.test.ts fails if a hall-count phrase is typed anywhere else under app, lib or components.

export const PORTFOLIO_SOLD_MIN_HALLS = 5;
export const PORTFOLIO_SOLD_MAX_HALLS = 15;
export const PORTFOLIO_FORM_MIN_HALLS = 2;
export const PORTFOLIO_FORM_MAX_HALLS = 15;
export const PORTFOLIO_ENGINE_MAX_HALLS = 50;

/** The sold range as a phrase, for use inside a sentence ("... (five to fifteen halls ranked under one methodology) ..."). */
export const PORTFOLIO_SOLD_RANGE = "five to fifteen halls";
/** The same phrase at the start of a sentence. */
export const PORTFOLIO_SOLD_RANGE_CAP = "Five to fifteen halls";
/** The form's range as a phrase. */
export const PORTFOLIO_FORM_RANGE = "two to fifteen halls";

/** 1 of 3. What is sold, and what the price band is for. Names no price. */
export const PORTFOLIO_SOLD_SENTENCE =
  `The Portfolio Screen is sold for ${PORTFOLIO_SOLD_RANGE}: the price band is for that range, and the fee is agreed in writing before work starts.`;

/** 2 of 3. The fewer-than-five case, stated as it is. States no price for it. */
export const PORTFOLIO_FEWER_SENTENCE =
  `Sold for ${PORTFOLIO_SOLD_RANGE}. With fewer, tell us when we scope it: the fee is agreed in writing for the halls you list.`;

/** 3 of 3. Beyond the top of the range. */
export const PORTFOLIO_MORE_SENTENCE = "More than fifteen halls is a separate engagement, scoped on its own.";

/** What the hall-list form accepts, and why two. Used where the form is described, after the scope has been agreed. */
export const PORTFOLIO_FORM_SENTENCE =
  `The hall-list form takes ${PORTFOLIO_FORM_RANGE}; two is the least a ranking means anything for.`;

/** What the metered endpoint accepts, and that it is not the scope of the engagement. For /developers, which describes the endpoint and not the engagement. */
export const PORTFOLIO_ENGINE_SENTENCE =
  `POST /v1/portfolio ranks up to ${PORTFOLIO_ENGINE_MAX_HALLS} halls in one request. That is a limit on the work one request can demand, ` +
  `not the scope of the Portfolio Screen engagement, which is sold for ${PORTFOLIO_SOLD_RANGE}.`;
