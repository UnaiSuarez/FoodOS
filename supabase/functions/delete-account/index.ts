import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Identificamos al usuario con el anon client + su JWT
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client para borrar el usuario y su Storage (requiere service role key)
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // E20-06: borrar las fotos de producto del usuario en Storage ANTES de
    // borrar la cuenta — el cascade de las tablas (auth.users → ... on
    // delete cascade) limpia todas las filas, pero Storage vive en su
    // propio bucket sin cascade automático. Sin este paso, cada foto subida
    // quedaba huérfana en "product-images" para siempre tras eliminar la
    // cuenta. Best-effort: si falla, no bloquea el borrado de la cuenta
    // (que es la parte irreversible e importante) — solo se registra.
    try {
      const { data: files, error: listError } = await adminClient.storage
        .from("product-images")
        .list(user.id, { limit: 1000 });
      if (listError) {
        console.warn("delete-account: no se pudo listar Storage del usuario", listError);
      } else if (files && files.length > 0) {
        const paths = files.map((f) => `${user.id}/${f.name}`);
        const { error: removeError } = await adminClient.storage.from("product-images").remove(paths);
        if (removeError) {
          console.warn("delete-account: no se pudieron borrar todos los archivos de Storage", removeError);
        }
      }
    } catch (storageErr) {
      console.warn("delete-account: error inesperado limpiando Storage", storageErr);
    }

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      return new Response(JSON.stringify({ error: deleteError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
