// Which tickets somebody paid for.
//
// Its own module, and that is not tidiness. It is the half of the feature that
// the open-source edition keeps: a queue can be told that some tickets jump
// ahead of the others, and how a ticket earns that is nobody else's business.
// A payment webhook is one answer. A button on a wall, a friend's birthday, or
// a row inserted by hand are others, and they all write the same table.
//
// So the reader lives here and the payment provider lives next door, which is
// what lets the public repository ship the priority without shipping the till.

/** Everything the renderer needs, for the jobs that came from a tip jar. */
export async function supportersFor(db, ids) {
  if (!ids.length) return new Map();
  const holes = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT job_id, kind, from_name, amount, currency, tier_name
         FROM supporters WHERE job_id IN (${holes})`
    )
    .bind(...ids)
    .all();
  return new Map((results ?? []).map((row) => [row.job_id, row]));
}
