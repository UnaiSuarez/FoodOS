// Cliente "con forma de supabase-js/PostgREST" sobre PGlite. NO es PostgREST: traduce las llamadas que
// hace apps/web/src/lib/data-layer.ts (from().select/insert/update/upsert/delete + filtros, rpc()) al SQL
// que PostgREST genera para ellas (INSERT … SELECT FROM json_populate_recordset … ON CONFLICT DO UPDATE SET
// solo las columnas del payload; ver supabase/verification/inventory-nutrition-provenance/README.md).
// Cada operación se ejecuta como el rol `authenticated` con auth.uid() = el usuario de la sesión, así que
// RLS, GRANT y triggers se aplican igual que con un JWT real. `opts.clientInfo` simula la cabecera
// X-Client-Info que PostgREST expone en request.headers (por defecto: el cliente nuevo; null = antiguo).
import { asUser, NEW_CLIENT_INFO } from "./schema.mjs";

function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`identificador no permitido: ${name}`);
  return `"${name}"`;
}

/** @param db PGlite  @param session { userId: string } mutable: cambiarlo simula un cambio de sesión */
export function postgrestLikeClient(db, session, opts = {}) {
  const log = [];
  const clientInfo = "clientInfo" in opts ? opts.clientInfo : NEW_CLIENT_INFO;
  const run = (fn) => asUser(db, session.userId, fn, { clientInfo });

  async function exec(spec) {
    const { table, op, payload, onConflict, ignoreDuplicates, filters, order, limitN, cols, returning } = spec;
    const T = `public.${ident(table)}`;
    const where = filters.length ? " where " + filters.map((f, i) => f.render(i + 1)).join(" and ") : "";
    const params = filters.map((f) => f.val);
    return run(async () => {
      if (op === "select") {
        const orderSql = order.length ? " order by " + order.map((o) => `${ident(o.col)} ${o.asc ? "asc" : "desc"}`).join(", ") : "";
        const limitSql = limitN != null ? ` limit ${Number(limitN)}` : "";
        const colList = cols.split(",").map((c) => c.trim()).filter(Boolean).map(ident).join(", ") || "*";
        const r = await db.query(
          `select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) as rows from (select ${colList} from ${T}${where}${orderSql}${limitSql}) q`,
          params,
        );
        return r.rows[0].rows;
      }
      if (op === "delete") {
        const r = await db.query(`with d as (delete from ${T}${where} returning *) select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) as rows from d`, params);
        return r.rows[0].rows;
      }
      if (op === "update") {
        const keys = Object.keys(payload);
        const sets = keys.map((k, i) => `${ident(k)} = (json_populate_record(null::${T}, $${params.length + 1}::json)).${ident(k)}`).join(", ");
        const r = await db.query(
          `with u as (update ${T} set ${sets}${where} returning *) select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) as rows from u`,
          [...params, JSON.stringify(payload)],
        );
        return r.rows[0].rows;
      }
      // insert / upsert
      const rows = Array.isArray(payload) ? payload : [payload];
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const colSql = keys.map(ident).join(", ");
      let conflict = "";
      if (op === "upsert") {
        const target = (onConflict ?? "id").split(",").map((c) => ident(c.trim())).join(", ");
        conflict = ignoreDuplicates
          ? ` on conflict (${target}) do nothing`
          : ` on conflict (${target}) do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
      }
      const r = await db.query(
        `with i as (insert into ${T} (${colSql}) select ${colSql} from json_populate_recordset(null::${T}, $1::json) _${conflict} returning *) select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) as rows from i`,
        [JSON.stringify(rows)],
      );
      return r.rows[0].rows;
    });
  }

  function builder(table) {
    const spec = { table, op: null, payload: null, filters: [], order: [], limitN: null, cols: "*", returning: false };
    const b = {
      select(cols = "*") { if (spec.op === null) { spec.op = "select"; spec.cols = cols; } else { spec.returning = true; spec.retCols = cols; } return b; },
      insert(p) { spec.op = "insert"; spec.payload = p; return b; },
      upsert(p, o = {}) { spec.op = "upsert"; spec.payload = p; spec.onConflict = o.onConflict; spec.ignoreDuplicates = !!o.ignoreDuplicates; return b; },
      update(p) { spec.op = "update"; spec.payload = p; return b; },
      delete() { spec.op = "delete"; return b; },
      eq(col, val) { spec.filters.push({ val, render: (n) => `${ident(col)} = $${n}` }); return b; },
      gte(col, val) { spec.filters.push({ val, render: (n) => `${ident(col)} >= $${n}` }); return b; },
      lte(col, val) { spec.filters.push({ val, render: (n) => `${ident(col)} <= $${n}` }); return b; },
      in(col, vals) { spec.filters.push({ val: `{${vals.join(",")}}`, render: (n) => `${ident(col)}::text = any ($${n}::text[])` }); return b; },
      order(col, o = {}) { spec.order.push({ col, asc: o.ascending !== false }); return b; },
      limit(n) { spec.limitN = n; return b; },
      single() { spec.single = true; return b; },
      maybeSingle() { spec.maybe = true; return b; },
      then(resolve, reject) {
        exec(spec)
          .then((rows) => {
            log.push({ user: session.userId, table, op: spec.op, ok: true });
            let data = rows;
            if (spec.single) data = rows[0] ?? null;
            else if (spec.maybe) data = rows[0] ?? null;
            return { data, error: null };
          })
          .catch((e) => {
            log.push({ user: session.userId, table, op: spec.op, ok: false, error: e.message });
            return { data: null, error: { message: e.message, code: e.code } };
          })
          .then(resolve, reject);
      },
    };
    return b;
  }

  return {
    log,
    from: builder,
    async rpc(name, args) {
      try {
        const keys = Object.keys(args ?? {});
        const named = keys.map((k, i) => `${ident(k)} => $${i + 1}${/^p_snapshot$/.test(k) ? "::jsonb" : ""}`).join(", ");
        const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
        const rows = await run(async () => (await db.query(`select public.${ident(name)}(${named}) as r`, vals)).rows);
        log.push({ user: session.userId, rpc: name, ok: true });
        return { data: rows[0].r, error: null };
      } catch (e) {
        log.push({ user: session.userId, rpc: name, ok: false, error: e.message });
        // PostgREST responde PGRST202 («Could not find the function …») cuando la función no existe.
        if (/function .* does not exist/i.test(e.message)) {
          return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } };
        }
        return { data: null, error: { message: e.message, code: e.code } };
      }
    },
  };
}
