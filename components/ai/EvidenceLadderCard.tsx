import { ALL_STATED_TEXT, type EvidenceLadder, type LadderRow } from "@/lib/project-spec-relief";

/**
 * "What evidence could move the binding limit": the inside of the ProjectPanel card of that name.
 *
 * Everything shown is read from the ladder lib/project-spec-relief.ts builds from the project's own saved comparison: which limit the
 * engine named, the class it holds for each input behind that limit, the document that would back the input, the review steps the
 * product has, and what the document would not prove. There is no request here, no estimate of a gain, and no promise of one.
 */

const NOT_YET = "Not yet created";

const ROLE_TEXT = {
  binds_now: "Binds now",
  binds_next: "Binds next, after the engine's relief steps",
} as const;

function Row({ row }: { row: LadderRow }) {
  const needsDocument = row.state !== "stated";
  return (
    <li className="space-y-0.5 border-t border-line pt-2">
      <p className="text-ghost">
        {row.label} <span className="data text-faint">· {row.classNow}</span>
      </p>
      <p>{row.stateText}</p>
      {needsDocument ? (
        <p className="text-faint">
          A figure you enter for it is classed {row.classIfEntered.code}: {row.classIfEntered.verb}.
        </p>
      ) : null}
      <p>
        <span className="text-faint">Document that would back it: </span>
        {row.document}
      </p>
      <p>
        <span className="text-faint">It would not prove: </span>
        {row.notProved}.
      </p>
    </li>
  );
}

export function EvidenceLadderCard({ ladder, projectToken }: { ladder: EvidenceLadder; projectToken: string }) {
  const compareHref = `/power/compare?project=${encodeURIComponent(projectToken)}`;
  if (ladder.status === "unreadable") {
    return (
      <>
        <p className="text-flag">A saved comparison exists but could not be read, so no ladder is shown (not &ldquo;none saved&rdquo;).</p>
        <p className="text-faint">{ladder.fileLine}</p>
      </>
    );
  }
  if (ladder.status === "no_comparison") {
    return (
      <>
        <p>{NOT_YET}: no Time-to-Power comparison has been saved to this project, so there is no binding limit to read inputs for.</p>
        <a href={compareHref} className="inline-block underline text-faint">
          Run a comparison and save it to this project
        </a>
        <p className="text-faint">{ladder.fileLine}</p>
      </>
    );
  }

  return (
    <>
      <p className="text-faint">
        From the latest saved comparison, for the scenario it ranked first or, if it ranked none, its baseline: {ladder.scenario}. It reads
        classes, not figures, and promises no gain: the engine decides what a documented figure does to the limit.
      </p>

      {ladder.status === "no_limit" && <p>The saved comparison names no binding limit for this scenario.</p>}
      {ladder.status === "no_inputs" && (
        <p>
          The limit it names ({ladder.named.map((n) => n.constraintName).join("; ")}) rests on something a saved comparison does not carry as
          an input, so this page has no document to name for it.
        </p>
      )}
      {ladder.status === "all_stated" && (
        <p>
          {ALL_STATED_TEXT} A reviewed file would put a document behind a stated figure; it would not change the class.
        </p>
      )}

      {ladder.rungs.map((rung) => (
        <section key={rung.constraint} aria-label={`${ROLE_TEXT[rung.role]}: ${rung.constraintName}`} className="space-y-2 border-t border-line pt-2">
          <p className="text-ghost">
            <span className="text-faint">{ROLE_TEXT[rung.role]}: </span>
            {rung.constraintName}
          </p>
          <ul className="space-y-2">
            {rung.rows.map((row) => (
              <Row key={row.path} row={row} />
            ))}
          </ul>
        </section>
      ))}

      {ladder.named.filter((n) => n.note).map((n) => (
        <p key={n.constraint} className="border-t border-line pt-2">
          <span className="text-faint">{n.constraintName}: </span>
          {n.note}
        </p>
      ))}

      {ladder.unevaluated.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2">
          <p className="text-ghost">Limits the engine could not evaluate</p>
          {ladder.unevaluated.map((u) => (
            <p key={u.path}>
              <span className="text-faint">{u.label}: </span>
              {u.text} Supplying it lets the engine evaluate that limit; whether it then binds is the engine&apos;s call.
            </p>
          ))}
        </div>
      )}

      {ladder.status === "has_assumed" || ladder.status === "all_stated" ? (
        <div className="space-y-1 border-t border-line pt-2">
          <p className="text-ghost">The review steps that exist today</p>
          <ol className="list-decimal space-y-1 pl-5">
            {ladder.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <p className="border-t border-line pt-2 text-faint">{ladder.fileLine}</p>
      <ul className="list-disc space-y-1 pl-5 text-faint">
        {ladder.limits.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
}
