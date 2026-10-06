import pg from "pg";

const { Pool, types } = pg;

/**
 * BIGINT (OID 20) must stay a string so we never lose precision by routing
 * money through a JS number. We parse it to `bigint` explicitly in the money
 * mapping layer instead. This is pg's default, but we set it explicitly so a
 * stray global override elsewhere cannot silently coerce money to Number.
 */
types.setTypeParser(types.builtins.INT8, (value) => value);

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}
