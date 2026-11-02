# Customer discovery kit

Purpose: find out, from real conversations, whether the owner of an existing AI data hall will pay for what is on the ladder, and
for which of its products. **Willingness to pay is not validated.** Nothing in this repository, on the site or in a deliverable may
say otherwise until the evidence rule in section 5 is met. This kit is how that evidence gets collected without bending it.

Prices are never typed in this document or said from memory on a call: read them from the catalogue (`lib/products.ts`, or the
live `/pricing` page). The same goes for turnaround.

## 1. Who to talk to

One person per conversation, chosen by the decision they own, not by title. The buyer lines below are the ones on the product pages
(`lib/product-pages.ts`).

| Engagement | The person who signs for it | The decision it informs |
|---|---|---|
| Density Screen | Operations or engineering lead of an existing hall, or the director who approves a densification study | Whether the hall is worth a full study, and which constraint to start with |
| Envelope Study | Director or head of infrastructure who owns the densification or expansion decision | Which architecture to commit to, what each step of density costs, when capacity can be energised |
| Procurement Specification | Engineer or procurement lead sending a relief item to suppliers | What to ask suppliers for, and which bid brings the energisation date forward |
| Portfolio Screen | Fund, operator or lender ranking several halls | Which halls get capital first |
| Hall Watch | Owner of a hall whose inputs change | Whether anything that changed in the quarter changes the decision taken |

Disqualify early, and write it down: halls that are not yet built, vendors of equipment, consultants who would resell the work.
They are useful for learning, not as evidence of demand.

## 2. The conversation (30 minutes, in this order)

The rule: ask about what they did, not what they would do. A prediction costs them nothing; a past decision is evidence.

**Opening (2 min).** Say who you are and that this is research, not a sales call. Say the product is pilot-stage and founder-led.
Ask permission to take notes.

**Their last time (10 min).**
1. Tell me about the last time someone asked you to put higher-density racks in a hall. What happened?
2. What did you need to know before you could answer? Who did you ask?
3. What did you actually find out, and how long did it take from the question to the answer?
4. What stopped it, if anything stopped it? Who said so, and what was it based on?
5. What did the delay or the wrong answer cost? (Ask for a number or a decision, not an adjective.)

**What they do today (7 min).**
6. How do you get this answered now: in-house, a consultant, the equipment vendor, a spreadsheet?
7. What did the last one cost, in money and in weeks? Who paid for it?
8. What was wrong with it, or missing from it?
9. Have you ever paid for an answer like this and regretted it? Why?

**Authority and budget (5 min).**
10. If you wanted this done for one hall next month, who would have to agree? Is there a budget line, or is it found case by case?
11. What is the smallest amount that gets approved without a meeting? (Listen; do not offer a number first.)

**Show, only now (4 min, optional).** Open `/qualify` or the worked example at `/reference`. Ask: what would you need to see in
this before you could act on it? What is missing? Do not defend it. Write down every objection verbatim.

**Close (2 min).** Ask for something that costs them a little: a second conversation with the person who owns the numbers, a real
hall's inputs for a free qualifier run, an introduction. Their answer is the strongest signal in the call. A polite "send me
something" is a no.

Never in a call: quote a price before question 11 is answered; promise a date; promise a result; imply customers, references or
a track record the project does not have.

## 3. What may be said

Allowed, because the product and its documents say it: the engine screens an existing hall against thirteen constraints, names the
one that binds first, and states an evidence class on every number; most constraints are **UNCALIBRATED** today, and the published
calibration ledger says so; screening-mode output is not an issued engineering opinion; the free qualifier needs no account.

Not allowed: market-leader or "first" claims, named customers, results, savings figures, guarantees, certification, "AI-powered"
as a substitute for saying what it computes, and any statement that a number is measured when it was supplied or assumed.

## 4. Outreach (each under 120 words; send nothing that is not true)

**Operator, cold.**
> Subject: A question about densifying <hall or site>
> I'm researching why existing halls can't confirm AI-density racks. I'm not selling anything on this note. If you've faced the
> question recently, I'd value 30 minutes on how you answered it and what it cost. In return I'll run your hall through a free
> capacity check and send you what binds first. The tool is pilot-stage; it names which of its inputs nobody has measured.

**Introduction request.**
> Who in your network owns the decision when a hall is asked for higher-density racks? I'm doing research, not sales, and would
> be grateful for an introduction.

**Follow-up after a call.**
> Thank you. Here is what I heard: <their situation in two sentences>. Here is what I'm unsure I understood: <one question>.
> If it's useful, send the seven inputs for one hall (or none, we can use ranges) and I'll send back the free check.

## 5. What counts as evidence of willingness to pay

Strongest first. Only the first item validates anything; the others are leading indicators and must be labelled as such everywhere.

1. **A paid engagement** by a buyer who is not the founder, a relative or a paid partner, bought through the checkout.
2. **A signed or written commitment to a priced engagement** from the person with the budget, with the scope and fee named.
3. **Real inputs supplied** for a named hall (an intake, not a hypothetical), by someone who can speak for the hall.
4. **A second meeting that includes the budget holder.**
5. **A stated budget range** the buyer volunteered.
6. Interest, compliments, "send me more", a signed NDA. **These are not evidence.**

The site, deliverables and any investor material say "willingness to pay is not yet validated" until item 1 has happened
more than once, across more than one buyer. A single paid engagement is one data point, and is described that way.

## 6. Logging

Use `docs/templates/discovery-log.csv`: one row per conversation, written the same day, in the buyer's words where it matters.
Keep the personal data to what the conversation needs (name, company, role); do not record credentials, hall access details or
other people's personal data. Delete a row on request.

Fields: `date, person, company, role, hall_status, segment, last_time_story, current_alternative, alternative_cost,
alternative_weeks, decision_owner, budget_signal, objection, strongest_ask_made, ask_result, evidence_level, follow_up_on`.
`evidence_level` is a number 1 to 6 from section 5; it is never raised by the person logging it for any reason other than what
happened.

## 7. Reading the log (a proposal, to be changed by the owner)

These are checkpoints for deciding what to do next, not targets to reach by persuading anyone.
- After about 15 conversations with qualifying people: which segment keeps telling the same last-time story? Narrow the
  outreach to it.
- If most conversations stop at item 6 of section 5, the problem is not messaging; the product, the price or the buyer is wrong.
  Change one of them and ask again.
- If objections cluster, they are the next product work. Record the cluster and its count, not the most memorable quote.
- A price objection is evidence about the price only when question 11 was answered before the price was shown.
