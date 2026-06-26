"use client";

import Image from "next/image";
import { useState } from "react";
import { DEMO_RECIPES } from "@/lib/recipes";
import { actions, allRecipes, buildDemoPosts, findRecipe, useFoodOS } from "@/lib/state";
import { uid } from "@/lib/utils";

type FeedTab = "all" | "mine";

export function FeedView({ openRecipe }: { openRecipe: (id: string) => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [tab, setTab]           = useState<FeedTab>("all");
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<Record<string, string>>({});
  const [caption, setCaption]   = useState("");
  const [selRecipe, setSelRecipe] = useState("");

  const recipes = allRecipes(state);

  function publish() {
    const recipeId = selRecipe || recipes[0]?.id;
    if (!recipeId) { showToast("No hay recetas disponibles"); return; }
    const recipe = findRecipe(state, recipeId) ?? DEMO_RECIPES[0];
    mutate((draft) => {
      draft.feedPosts.push({
        id: uid(),
        recipeId,
        author: "tu",
        title: recipe.title,
        caption: caption.trim() || `${recipe.protein}g de proteína · ${recipe.time} min · ¡cocinada!`,
        likes: 0,
        comments: [],
      });
    });
    setMascotMessage("Publicado en el feed.");
    showToast("Publicado en feed");
    setCaption("");
  }

  function toggleLike(postId: string) {
    mutate((draft) => {
      const post = draft.feedPosts.find((p) => p.id === postId);
      if (!post) return;
      if (likedIds.has(postId)) {
        post.likes = Math.max(0, post.likes - 1);
        setLikedIds((prev) => { const next = new Set(prev); next.delete(postId); return next; });
      } else {
        post.likes += 1;
        setLikedIds((prev) => new Set(prev).add(postId));
      }
    });
  }

  const visiblePosts = [...state.feedPosts]
    .reverse()
    .filter((p) => tab === "all" || p.author === "tu");

  const myCount = state.feedPosts.filter((p) => p.author === "tu").length;

  return (
    <section className="view">
      <div className="work-grid">
        {/* Panel izquierdo: publicar + botones */}
        <div className="stack-panels">
          <article className="panel form-panel">
            <h2>Compartir receta</h2>
            <label>
              Receta
              <select
                value={selRecipe}
                onChange={(e) => setSelRecipe(e.target.value)}
              >
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>{r.title}</option>
                ))}
              </select>
            </label>
            <label style={{ marginTop: 10 }}>
              Comentario <small>(opcional)</small>
              <input
                placeholder="Rápida y con lo que caducaba 🔥"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
            </label>
            {selRecipe && (() => {
              const r = findRecipe(state, selRecipe) ?? recipes[0];
              if (!r) return null;
              return (
                <div className="feed-recipe-preview">
                  {r.image && (
                    <Image src={r.image} alt={r.title} width={280} height={120} style={{ borderRadius: 8, objectFit: "cover", width: "100%", height: 100 }} />
                  )}
                  <div className="meta-row" style={{ marginTop: 6 }}>
                    <span className="badge green">{r.protein}g prot</span>
                    <span className="badge">{r.kcal} kcal</span>
                    <span className="badge blue">€{r.cost.toFixed(2)}</span>
                    <span className="badge">{r.time} min</span>
                  </div>
                </div>
              );
            })()}
            <button className="primary-button" style={{ marginTop: 12 }} onClick={publish} disabled={recipes.length === 0}>
              Publicar en feed
            </button>
          </article>

          <article className="panel" style={{ padding: "14px 18px" }}>
            <p className="eyebrow" style={{ marginBottom: 8 }}>Datos demo</p>
            <button
              className="secondary-button"
              style={{ width: "100%" }}
              onClick={() => {
                mutate((draft) => void (draft.feedPosts = buildDemoPosts()));
                setMascotMessage("Feed demo generado.");
                showToast("Posts demo cargados");
              }}
            >
              Cargar posts demo
            </button>
          </article>
        </div>

        {/* Panel derecho: feed */}
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Comunidad</p>
              <h2>Recetas públicas</h2>
            </div>
            <div className="feed-tabs">
              <button
                className={`feed-tab ${tab === "all" ? "active" : ""}`}
                onClick={() => setTab("all")}
              >
                Todo <b className="tab-count">{state.feedPosts.length}</b>
              </button>
              <button
                className={`feed-tab ${tab === "mine" ? "active" : ""}`}
                onClick={() => setTab("mine")}
              >
                Mis posts {myCount > 0 && <b className="tab-count">{myCount}</b>}
              </button>
            </div>
          </div>

          <div className="feed-list">
            {visiblePosts.length === 0 ? (
              <div className="empty">
                {tab === "mine"
                  ? "Aún no has publicado nada. Elige una receta y pulsa Publicar."
                  : "Carga los posts demo o publica tu primera receta."}
              </div>
            ) : (
              visiblePosts.map((post) => {
                const recipe = findRecipe(state, post.recipeId) ?? DEMO_RECIPES[0];
                const saved  = state.savedRecipeIds.includes(recipe.id);
                const liked  = likedIds.has(post.id);
                const isOwn  = post.author === "tu";

                return (
                  <article key={post.id} className="feed-card">
                    {recipe.image && (
                      <button
                        className="feed-image"
                        onClick={() => openRecipe(recipe.id)}
                        aria-label={`Ver ${recipe.title}`}
                      >
                        <Image src={recipe.image} alt={post.title} width={520} height={260} />
                      </button>
                    )}
                    <div className="feed-card-body">
                      <div className="feed-card-author">
                        <span className={`badge ${isOwn ? "green" : ""}`}>
                          @{post.author}
                        </span>
                        {isOwn && (
                          <button
                            className="small-action bad"
                            aria-label="Borrar publicación"
                            onClick={() => {
                              mutate((draft) => {
                                draft.feedPosts = draft.feedPosts.filter((p) => p.id !== post.id);
                              });
                              showToast("Publicación eliminada");
                            }}
                          >
                            Borrar
                          </button>
                        )}
                      </div>

                      <h3>{post.title}</h3>
                      <p className="feed-caption">{post.caption}</p>

                      <div className="feed-stats">
                        <span className="badge">{recipe.kcal} kcal</span>
                        <span className="badge">{recipe.protein}g prot</span>
                        <span className="badge blue">€{recipe.cost.toFixed(2)}</span>
                        <span className="badge">{recipe.time} min</span>
                      </div>

                      {/* Comentarios */}
                      {post.comments.length > 0 && (
                        <div className="feed-comments">
                          {post.comments.map((c, i) => (
                            <p key={i}>
                              <strong>{c.author}</strong> {c.text}
                            </p>
                          ))}
                        </div>
                      )}
                      <div className="inline-form">
                        <input
                          placeholder="Escribe un comentario…"
                          value={comments[post.id] ?? ""}
                          onChange={(e) =>
                            setComments((prev) => ({ ...prev, [post.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const text = (comments[post.id] ?? "").trim();
                              if (!text) return;
                              mutate((draft) => {
                                const target = draft.feedPosts.find((p) => p.id === post.id);
                                if (target) target.comments.push({ author: "Tú", text });
                              });
                              setComments((prev) => ({ ...prev, [post.id]: "" }));
                            }
                          }}
                        />
                        <button
                          className="small-action"
                          onClick={() => {
                            const text = (comments[post.id] ?? "").trim();
                            if (!text) return;
                            mutate((draft) => {
                              const target = draft.feedPosts.find((p) => p.id === post.id);
                              if (target) target.comments.push({ author: "Tú", text });
                            });
                            setComments((prev) => ({ ...prev, [post.id]: "" }));
                            showToast("Comentario añadido");
                          }}
                        >
                          →
                        </button>
                      </div>

                      <div className="card-actions">
                        <button
                          className={`small-action ${liked ? "good" : ""}`}
                          onClick={() => toggleLike(post.id)}
                          aria-label={liked ? "Quitar like" : "Dar like"}
                        >
                          {liked ? "❤ " : "🤍 "}{post.likes}
                        </button>
                        <button
                          className={`small-action ${saved ? "good" : ""}`}
                          onClick={() => {
                            mutate((draft) => {
                              if (draft.savedRecipeIds.includes(recipe.id)) {
                                draft.savedRecipeIds = draft.savedRecipeIds.filter((id) => id !== recipe.id);
                              } else {
                                draft.savedRecipeIds.push(recipe.id);
                              }
                            });
                            showToast(saved ? "Quitada de guardadas" : "Receta guardada");
                          }}
                        >
                          {saved ? "Guardada ✓" : "Guardar"}
                        </button>
                        <button
                          className="small-action"
                          onClick={() => {
                            mutate((draft) => actions.addRecipeToCart(draft, recipe));
                            showToast("Ingredientes al carrito");
                          }}
                        >
                          Al carrito
                        </button>
                        <button
                          className="small-action good"
                          onClick={() => {
                            mutate((draft) => actions.cookRecipe(draft, recipe));
                            setMascotMessage("Receta cocinada. ¡Macros actualizados!");
                            showToast("Receta registrada en nutrición");
                          }}
                        >
                          Cocinar
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
