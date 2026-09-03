# The Worker

The whole backend: the page, the API, the queue, the moderation, the admin
desk. One Cloudflare Worker and one D1 database.

```sh
npm install
npx wrangler login
npx wrangler d1 create printer   # answer DB when it asks for a binding name
node setup.mjs                   # the database id, three secrets, and a
                                 # my-tokens.txt you keep
npm run db:remote                # create the tables
npm run deploy
```

Full instructions, including what to do when a step fails, are in
[docs/01-quick-start.md](../docs/01-quick-start.md).

## The schema

`schema.sql` is the entire schema and it is **idempotent**: every statement is
`CREATE ... IF NOT EXISTS` or `INSERT OR IGNORE`. Run it against a fresh
database or an old one, as often as you like. That is why there are no
migration files to keep in order.

The one rule: never put a destructive statement in it.

## Tests

```sh
npm test
```

They run against a real SQLite engine rather than a hand-written fake database
(`test/helpers/d1.mjs`), because a fake cannot disagree with your SQL — it
returns whatever the test author expected. Two of the worst bugs this project
ever shipped walked straight through a suite of hand-written fakes.

`test/d1-cost.test.mjs` is the unusual one. It asserts on the **cost** of
queries rather than their results, by reading the plans SQLite actually
chooses. Read it before you add a query to a hot path.
