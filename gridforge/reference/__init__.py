"""The public engineering reference — thirteen constraints, published.

The commercial argument for this is simple and it is not a marketing one. Anyone
choosing whether to pay for a capacity study first wants to understand the problem,
and today they read vendor reference designs written by companies whose every
document ends in their own bill of materials. There is no independent, quantitative,
public account of what actually stops an existing hall taking AI racks.

So we write it. Each constraint gets a page: what it limits, the relation that
governs it, what a typical installed value looks like, how to tell whether it is the
one binding in your hall, what relieves it, what that costs and how long it takes.

Two properties make it defensible rather than merely nice:

  * The NUMBERS are computed from the same libraries the engine solves with. A
    competitor can copy the prose in an afternoon; keeping it consistent with a
    working engine for two years is a different problem.
  * Every page ends at a free tool that answers the question for the reader's own
    hall. The reference is not content marketing with a form at the bottom — the
    tool is the point and the reference is how someone arrives believing it.

The prose is authored, because physics explained badly is worse than not explained.
A test asserts the catalogue covers every constraint the engine evaluates and names
no constraint it does not, so the two cannot drift apart.
"""
from .catalogue import (ConstraintDoc, RELIEF_LEAD_TIMES, CONSTRAINT_DOCS,
                        constraint_doc, all_docs, ReferenceError)
from .build import reference_payload, platform_payload

__all__ = ["ConstraintDoc", "CONSTRAINT_DOCS", "RELIEF_LEAD_TIMES", "constraint_doc",
           "all_docs", "ReferenceError", "reference_payload", "platform_payload"]
