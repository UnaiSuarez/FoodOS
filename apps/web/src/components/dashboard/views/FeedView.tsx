"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { DEMO_RECIPES } from "@/lib/recipes";
import { actions, allRecipes, buildDemoPosts, findRecipe, useFoodOS } from "@/lib/state";
import { uid } from "@/lib/utils";

export function FeedView({ openRecipe }: { openRecipe: (id: string) => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [comments, setComments] = useState<Record<string, string>>({});

  function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const recipeId = String(data.get("recipeId"));
    const recipe = findRecipe(state, recipeId) ?? DEMO_RECIPES[0];
    mutate((draft) => {
      draft.feedPosts.push({
        id: uid(),
        recipeId,
        author: "tu",
        title: String(data.get("title")).trim() || recipe.title,
        caption: String(data.get("caption")).trim() || "Receta guardada desde mi FoodOS.",
        likes: 0,
        comments: [],
      });
    });
    setMascotMessage("Publicación creada en el feed.");
    showToast("Publicado en feed");
    form.reset();
  }

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={publish}>
          <h2>Publicar receta</h2>
          <div className="form-grid compact">
            <label>
              Título <input name="title" required placeholder="Mi cena alta en proteína" />
            </label>
            <label>
              Receta base
              <select name="recipeId">
                {allRecipes(state).map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Texto <input name="caption" placeholder="Rápida, barata y usando lo que caducaba." />
            </label>
          </div>
          <button className="primary-button" type="submit">
            Publicar en feed
          </button>
        </form>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Comunidad</p>
              <h2>Recetas públicas</h2>
            </div>
            <button
              className="secondary-button"
              onClick={() => {
                mutate((draft) => void (draft.feedPosts = buildDemoPosts()));
                setMascotMessage("Feed demo generado.");
                showToast("Posts demo creados");
              }}
            >
              Crear posts demo
            </button>
          </div>
          <div className="feed-list">
            {state.feedPosts.length ? (
              [...state.feedPosts].reverse().map((post) => {
                const recipe = findRecipe(state, post.recipeId) ?? DEMO_RECIPES[0];
                const saved = state.savedRecipeIds.includes(recipe.id);
                return (
                  <article key={post.id} className="feed-card">
                    <button className="feed-image" onClick={() => openRecipe(recipe.id)} aria-label={`Ver ${recipe.title}`}>
                      <Image src={recipe.image} alt={post.title} width={520} height={330} />
                    </button>
                    <div className="feed-card-body">
                      <span className="badge green">@{post.author}</span>
                      <h3>{post.title}</h3>
                      <p>{post.caption}</p>
                      <div className="feed-stats">
                        <span className="badge">{recipe.kcal} kcal</span>
                        <span className="badge">{recipe.protein}g prot</span>
                        <span className="badge blue">{post.likes} likes</span>
                        <span className="badge">{post.comments.length} comentarios</span>
                      </div>
                      <div className="feed-comments">
                        {post.comments.map((comment, index) => (
                          <p key={index}>
                            <strong>{comment.author}</strong> {comment.text}
                          </p>
                        ))}
                        <div className="inline-form">
                          <input
                            placeholder="Escribe un comentario"
                            value={comments[post.id] ?? ""}
                            onChange={(event) =>
                              setComments((current) => ({ ...current, [post.id]: event.target.value }))
                            }
                          />
                          <button
                            className="small-action"
                            onClick={() => {
                              const text = (comments[post.id] ?? "").trim();
                              if (!text) return;
                              mutate((draft) => {
                                const target = draft.feedPosts.find((entry) => entry.id === post.id);
                                if (target) target.comments.push({ author: "Tú", text });
                              });
                              setComments((current) => ({ ...current, [post.id]: "" }));
                              showToast("Comentario añadido");
                            }}
                          >
                            Enviar
                          </button>
                        </div>
                      </div>
                      <div className="card-actions">
                        <button
                          className="small-action"
                          onClick={() =>
                            mutate((draft) => {
                              const target = draft.feedPosts.find((entry) => entry.id === post.id);
                              if (target) target.likes += 1;
                            })
                          }
                        >
                          Like
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
                            showToast(saved ? "Receta quitada de guardadas" : "Receta guardada");
                          }}
                        >
                          {saved ? "Guardada ✓" : "Guardar receta"}
                        </button>
                        <button
                          className="small-action good"
                          onClick={() => {
                            mutate((draft) => actions.addRecipeToCart(draft, recipe));
                            showToast("Ingredientes añadidos al carrito");
                          }}
                        >
                          Al carrito
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty">Aún no hay publicaciones. Crea posts demo o publica una receta.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
