const defaultState = {
  inventory: [],
  cart: [],
  expenses: [],
  feedPosts: [],
  consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  consumedMeals: [],
  customRecipes: [],
  savedRecipeIds: [],
  nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "Recomposicion" },
  weeklyBudget: 70,
  activeStorage: "Todos",
  inventorySearch: "",
  bankSynced: false,
  mascotId: "zana",
  recipeTag: "todos",
};

let state = FoodOSData.loadLocal(defaultState);

const MASCOTS = [
  { id: "zana", name: "Zana", color: "#fb923c", tagline: "Energética y motivadora", image: "assets/mascot-zana.png" },
  { id: "basil", name: "Basil", color: "#a3e635", tagline: "Sereno y experto" },
  { id: "froggy", name: "Froggy", color: "#22c55e", tagline: "Curioso y con humor" },
  { id: "sage", name: "Sage", color: "#c084fc", tagline: "Tranquilo y analítico" },
  { id: "chip", name: "Chip", color: "#60a5fa", tagline: "Neutro y eficiente" },
  { id: "mushi", name: "Mushi", color: "#f472b6", tagline: "Soñadora y creativa" },
  { id: "bruno", name: "Bruno", color: "#a78bfa", tagline: "Cariñoso y protector" },
  { id: "pica", name: "Pica", color: "#ef4444", tagline: "Intensa y retadora" },
  { id: "okto", name: "Okto", color: "#06b6d4", tagline: "Organizado y multitarea" },
  { id: "kiri", name: "Kiri", color: "#f97316", tagline: "Carismático y creativo" },
  { id: "vera", name: "Vera", color: "#86efac", tagline: "Calmada y equilibrada" },
  { id: "pingo", name: "Pingo", color: "#7dd3fc", tagline: "Metódico y ordenado" },
  { id: "volt", name: "Volt", color: "#fde047", tagline: "Hiperactivo y explosivo" },
  { id: "leo", name: "Leo", color: "#fbbf24", tagline: "Fuerte y motivador" },
  { id: "luna", name: "Luna", color: "#818cf8", tagline: "Misteriosa y tranquila" },
];

const recipes = [
  {
    id: "chicken-rice",
    title: "Bowl proteico de pollo",
    ingredients: ["pechuga", "arroz", "tomate"],
    kcal: 610,
    protein: 54,
    carbs: 72,
    fat: 12,
    cost: 3.8,
    image: "assets/recipe-chicken-bowl.png",
    time: 25,
    servings: 1,
    difficulty: "fácil",
    tags: ["alta proteína", "rápida", "post-gym"],
    steps: ["Dora la pechuga en sartén con sal y especias.", "Calienta el arroz integral y saltea los tomates.", "Monta el bowl y ajusta la ración según tus macros."],
  },
  {
    id: "egg-toast",
    title: "Tostada de huevo y yogur",
    ingredients: ["huevo", "pan", "yogur"],
    kcal: 480,
    protein: 32,
    carbs: 48,
    fat: 18,
    cost: 2.4,
    image: "assets/recipe-egg-toast.png",
    time: 12,
    servings: 1,
    difficulty: "muy fácil",
    tags: ["desayuno", "rápida", "vegetariana"],
    steps: ["Tuesta el pan y cocina el huevo a la plancha.", "Sirve el yogur con semillas o fruta.", "Ajusta sal y hierbas al gusto."],
  },
  {
    id: "tuna-pasta",
    title: "Pasta rapida con atun",
    ingredients: ["atun", "pasta", "tomate"],
    kcal: 690,
    protein: 42,
    carbs: 96,
    fat: 14,
    cost: 2.9,
    image: "assets/recipe-tuna-pasta.png",
    time: 20,
    servings: 2,
    difficulty: "muy fácil",
    tags: ["económica", "rápida", "despensa"],
    steps: ["Cuece la pasta al dente.", "Mezcla tomate con atún y calienta a fuego suave.", "Integra pasta y salsa, termina con albahaca."],
  },
  {
    id: "lentils",
    title: "Lentejas de despensa",
    ingredients: ["lentejas", "arroz", "zanahoria"],
    kcal: 540,
    protein: 28,
    carbs: 92,
    fat: 7,
    cost: 1.8,
    image: "assets/recipe-lentils.png",
    time: 35,
    servings: 2,
    difficulty: "fácil",
    tags: ["económica", "vegana", "alta fibra"],
    steps: ["Sofríe zanahoria y especias.", "Añade lentejas, arroz y agua o caldo.", "Cocina hasta que quede meloso y corrige de sal."],
  },
];

// Recetas demo + recetas IA generadas por el usuario (estas si persisten).
function allRecipes() {
  return [...(state.customRecipes || []), ...recipes];
}

function findRecipe(recipeId) {
  return allRecipes().find((entry) => entry.id === recipeId);
}

const views = {
  dashboard: "Panel diario",
  inventory: "Inventario",
  recipes: "Recetas",
  feed: "Feed social",
  cart: "Carrito de compra",
  finance: "Finanzas",
  nutrition: "Nutricion",
  assistant: "Asistente FoodOS",
};

function saveState() {
  FoodOSData.persist(state);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function todayPlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayMinus(days) {
  return todayPlus(-days);
}

function eur(value) {
  return `${Number(value || 0).toFixed(2)} EUR`;
}

function clampPct(value, max) {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function daysUntil(dateString) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateString);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end - start) / 86400000);
}

function expiryBadge(item) {
  const days = daysUntil(item.expires);
  if (days < 0) return { label: "Caducado", cls: "red" };
  if (days <= 1) return { label: "Urgente", cls: "red" };
  if (days <= 3) return { label: `${days} dias`, cls: "amber" };
  return { label: "OK", cls: "green" };
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function getActiveMascot() {
  return MASCOTS.find((mascot) => mascot.id === state.mascotId) || MASCOTS[0];
}

function renderMascotAvatar(target, mascot) {
  target.style.background = mascot.color;
  target.innerHTML = mascot.image
    ? `<img src="${mascot.image}" alt="${mascot.name}, mascota de FoodOS" />`
    : `<span>${mascot.name[0]}</span>`;
}

function setMascot(message) {
  const mascot = getActiveMascot();
  renderMascotAvatar(document.getElementById("mascotAvatar"), mascot);
  document.getElementById("mascotName").textContent = mascot.name;
  document.getElementById("mascotMessage").textContent = message;
}

function renderMascotSelector() {
  const grid = document.getElementById("mascotGrid");
  if (!grid) return;
  grid.innerHTML = MASCOTS.map((mascot) => `
    <button class="mascot-choice ${mascot.id === state.mascotId ? "active" : ""}" data-mascot-id="${mascot.id}">
      <span class="mascot-token" style="background:${mascot.color}">
        ${mascot.image ? `<img src="${mascot.image}" alt="${mascot.name}" />` : mascot.name[0]}
      </span>
      <strong>${mascot.name}</strong>
      <small>${mascot.tagline}</small>
    </button>
  `).join("");
  const active = getActiveMascot();
  document.getElementById("mascotSelectedText").textContent = `${active.name} - ${active.tagline}`;
  setMascot(document.getElementById("mascotMessage").textContent || "Lista para organizar tu comida.");
}

function setView(view) {
  document.querySelectorAll(".view").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.getElementById(view).classList.add("active");
  document.getElementById("viewTitle").textContent = views[view];
}

// Gasto de comida de los ultimos 7 dias: es lo que compara contra el
// presupuesto SEMANAL (antes sumaba el historico completo).
function getFoodSpend() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  return state.expenses
    .filter((expense) => expense.type === "expense" && expense.category === "Comida")
    .filter((expense) => new Date(expense.date || Date.now()) >= weekAgo)
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
}

function getBudgetLeft() {
  return Math.max(0, Number(state.weeklyBudget) - getFoodSpend());
}

function getRecipeMatch(recipe) {
  const names = state.inventory.map((item) => item.name.toLowerCase());
  const matches = recipe.ingredients.filter((ingredient) => names.some((name) => name.includes(ingredient)));
  return { matches, pct: Math.round((matches.length / recipe.ingredients.length) * 100) };
}

function getIngredientStatus(recipe) {
  const names = state.inventory.map((item) => item.name.toLowerCase());
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient,
    has: names.some((name) => name.includes(ingredient) || ingredient.includes(name.split(" ")[0])),
  }));
}

function bestRecipe() {
  return [...allRecipes()].sort((a, b) => getRecipeMatch(b).pct - getRecipeMatch(a).pct || b.protein - a.protein)[0];
}

function renderDashboard() {
  const expiring = state.inventory.filter((item) => daysUntil(item.expires) <= 3);
  const budgetLeft = getBudgetLeft();
  const proteinLeft = Math.max(0, state.nutrition.protein - state.consumed.protein);
  const pendingCart = state.cart.filter((item) => !item.checked);
  const recipe = bestRecipe();
  const match = recipe ? getRecipeMatch(recipe) : { pct: 0, matches: [] };

  document.getElementById("expiryCount").textContent = expiring.length;
  document.getElementById("proteinLeft").textContent = `${Math.round(proteinLeft)}g`;
  document.getElementById("budgetLeft").textContent = eur(budgetLeft);
  document.getElementById("cartCount").textContent = pendingCart.length;

  if (state.inventory.length === 0) {
    document.getElementById("dailySuggestion").textContent = "Anade alimentos para generar una sugerencia.";
    document.getElementById("dailySuggestionMeta").textContent = "La app cruzara inventario, macros y presupuesto.";
  } else {
    document.getElementById("dailySuggestion").textContent = recipe.title;
    document.getElementById("dailySuggestionMeta").textContent =
      `${match.pct}% disponible · ${recipe.protein}g proteina · coste estimado ${eur(recipe.cost)} · presupuesto restante ${eur(budgetLeft)}`;
  }

  const kcalPct = clampPct(state.consumed.kcal, state.nutrition.kcal);
  document.getElementById("kcalProgress").textContent = `${kcalPct}%`;
  document.getElementById("macroRing").style.background =
    `radial-gradient(circle, #11170d 0 55%, transparent 56%), conic-gradient(var(--green) 0 ${kcalPct * 3.6}deg, rgba(240, 244, 238, 0.1) ${kcalPct * 3.6}deg)`;

  updateBar("protein", state.consumed.protein, state.nutrition.protein, "g");
  updateBar("carbs", state.consumed.carbs, state.nutrition.carbs, "g");
  updateBar("fat", state.consumed.fat, state.nutrition.fat, "g");

  const alerts = [
    ...expiring.map((item) => `${item.name} caduca ${daysUntil(item.expires) < 0 ? "ya" : `en ${daysUntil(item.expires)} dias`}.`),
    ...(budgetLeft <= state.weeklyBudget * 0.2 ? ["Presupuesto de comida por debajo del 20%."] : []),
    ...(proteinLeft > 40 ? [`Te quedan ${Math.round(proteinLeft)}g de proteina para hoy.`] : []),
  ];

  renderSimpleList("alertsList", alerts, "Sin alertas criticas ahora mismo.");
}

function updateBar(id, value, max, unit) {
  const pct = clampPct(value, max);
  document.getElementById(`${id}Bar`).style.width = `${pct}%`;
  document.getElementById(`${id}BarText`).textContent = `${Math.round(value)}/${Math.round(max)}${unit}`;
}

function renderSimpleList(id, items, emptyText) {
  const list = document.getElementById(id);
  list.innerHTML = items.length
    ? items.map((item) => `<div class="card"><div><h3>${item}</h3><small>FoodOS monitor</small></div></div>`).join("")
    : `<div class="empty">${emptyText}</div>`;
}

function renderInventory() {
  const list = document.getElementById("inventoryList");
  const query = (state.inventorySearch || "").toLowerCase().trim();
  const searchInput = document.getElementById("inventorySearchInput");
  if (searchInput && searchInput.value !== state.inventorySearch) searchInput.value = state.inventorySearch;
  let items = state.activeStorage === "Todos" ? state.inventory : state.inventory.filter((item) => item.storage === state.activeStorage);
  if (query) items = items.filter((item) => item.name.toLowerCase().includes(query) || item.storage.toLowerCase().includes(query));

  list.innerHTML = items.length
    ? items
        .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires))
        .map((item) => {
          const badge = expiryBadge(item);
          return `
            <article class="card">
              <div>
                <h3>${item.name}</h3>
                <small>${item.qty}${item.unit} · ${item.storage} · ${item.kcal} kcal/100g · ${item.protein}g proteina</small>
                <div class="meta-row">
                  <span class="badge ${badge.cls}">${badge.label}</span>
                  <span class="badge blue">${eur(item.price)}</span>
                </div>
              </div>
              <div class="card-actions">
                <button class="small-action good" data-consume="${item.id}">Consumir</button>
                <button class="small-action" data-cart-from-inventory="${item.id}">Al carrito</button>
                <button class="small-action bad" data-delete-inventory="${item.id}">Borrar</button>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="empty">No hay alimentos que coincidan con el filtro.</div>`;
}

function renderRecipes() {
  const list = document.getElementById("recipeList");
  const mode = document.getElementById("recipeMode")?.value || "exact";
  const allTags = ["todos", ...new Set(allRecipes().flatMap((recipe) => recipe.tags || []))];
  let filteredRecipes = [...allRecipes()];
  if (state.recipeTag !== "todos") {
    filteredRecipes = filteredRecipes.filter((recipe) => (recipe.tags || []).includes(state.recipeTag));
  }
  const sortedRecipes = filteredRecipes.sort((a, b) => {
    if (mode === "budget") return a.cost - b.cost;
    if (mode === "ai") return b.protein - a.protein;
    return getRecipeMatch(b).pct - getRecipeMatch(a).pct;
  });
  list.previousElementSibling?.classList.contains("recipe-filter-bar") && list.previousElementSibling.remove();
  list.insertAdjacentHTML("beforebegin", `
    <div class="recipe-filter-bar">
      <span class="badge">Filtrar</span>
      ${allTags.map((tag) => `<button class="filter ${tag === state.recipeTag ? "active" : ""}" data-recipe-tag="${tag}">${tag}</button>`).join("")}
      <span class="badge blue">${sortedRecipes.filter((recipe) => getRecipeMatch(recipe).pct >= 60).length} con ingredientes</span>
    </div>
  `);
  list.innerHTML = sortedRecipes
    .map((recipe) => {
      const match = getRecipeMatch(recipe);
      const cls = match.pct >= 80 ? "green" : match.pct >= 35 ? "amber" : "red";
      return `
        <article class="recipe-card" data-open-recipe="${recipe.id}" tabindex="0" role="button" aria-label="Abrir detalle de ${recipe.title}">
          <div>
            <img class="recipe-image" src="${recipe.image}" alt="${recipe.title}" />
            <span class="badge ${cls}">${match.pct}% disponible</span>
            <h3>${recipe.title}</h3>
            <p>${recipe.kcal} kcal · ${recipe.protein}g proteina · ${recipe.time} min · ${eur(recipe.cost)}</p>
            <div class="meta-row">
              ${(recipe.tags || []).map((tag) => `<span class="badge">${tag}</span>`).join("")}
            </div>
          </div>
          <div class="card-actions">
            <button class="small-action" data-open-recipe="${recipe.id}">Ver detalle</button>
            <button class="small-action" data-add-recipe-cart="${recipe.id}">Ingredientes al carrito</button>
            <button class="small-action good" data-cook-recipe="${recipe.id}">Cocinar</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderFeed() {
  const select = document.getElementById("feedRecipeSelect");
  if (select) {
    select.innerHTML = allRecipes().map((recipe) => `<option value="${recipe.id}">${recipe.title}</option>`).join("");
  }

  const list = document.getElementById("feedList");
  if (!list) return;

  list.innerHTML = state.feedPosts.length
    ? state.feedPosts
        .slice()
        .reverse()
        .map((post) => {
          const recipe = findRecipe(post.recipeId) || recipes[0];
          const saved = (state.savedRecipeIds || []).includes(recipe.id);
          return `
            <article class="feed-card">
              <img src="${recipe.image}" alt="${post.title}" />
              <div class="feed-card-body">
                <span class="badge green">@${post.author}</span>
                <h3>${post.title}</h3>
                <p>${post.caption}</p>
                <div class="feed-stats">
                  <span class="badge">${recipe.kcal} kcal</span>
                  <span class="badge">${recipe.protein}g prot</span>
                  <span class="badge blue">${post.likes} likes</span>
                  <span class="badge">${(post.comments || []).length} comentarios</span>
                </div>
                <div class="feed-comments">
                  ${(post.comments || []).map((comment) => `<p><strong>${comment.author}</strong> ${comment.text}</p>`).join("")}
                  <div class="feed-comment-form">
                    <input data-comment-input="${post.id}" placeholder="Escribe un comentario" />
                    <button class="small-action" data-comment-post="${post.id}">Enviar</button>
                  </div>
                </div>
                <div class="card-actions">
                  <button class="small-action" data-like-post="${post.id}">Like</button>
                  <button class="small-action ${saved ? "good" : ""}" data-save-feed="${recipe.id}">${saved ? "Guardada ✓" : "Guardar receta"}</button>
                  <button class="small-action good" data-add-recipe-cart="${recipe.id}">Al carrito</button>
                </div>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="empty">Aun no hay publicaciones. Crea posts demo o publica una receta.</div>`;
}

function openModal(title, html) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modalOverlay").hidden = false;
}

function closeModal() {
  document.getElementById("modalOverlay").hidden = true;
  document.getElementById("modalBody").innerHTML = "";
}

function openRecipeDetail(recipeId) {
  const recipe = findRecipe(recipeId);
  if (!recipe) return;
  const match = getRecipeMatch(recipe);
  const ingredients = getIngredientStatus(recipe);
  openModal(recipe.title, `
    <div class="recipe-detail-hero">
      <img src="${recipe.image}" alt="${recipe.title}" />
      <div class="recipe-detail-copy">
        <div class="recipe-detail-meta">
          <span class="badge blue">${recipe.time} min</span>
          <span class="badge">${recipe.servings} raciones</span>
          <span class="badge">${recipe.difficulty}</span>
          <span class="badge ${match.pct >= 60 ? "green" : "amber"}">${match.pct}% ingredientes</span>
        </div>
        <h2>${recipe.title}</h2>
        <p>${recipe.kcal} kcal · ${recipe.protein}g proteina · coste estimado ${eur(recipe.cost)}.</p>
        <div class="recipe-detail-tags">${(recipe.tags || []).map((tag) => `<span class="badge">${tag}</span>`).join("")}</div>
      </div>
    </div>
    <div class="recipe-macros-row">
      <div class="macro-item"><span class="macro-val">${recipe.kcal}</span><span class="macro-lbl">kcal</span></div>
      <div class="macro-item"><span class="macro-val">${recipe.protein}g</span><span class="macro-lbl">proteina</span></div>
      <div class="macro-item"><span class="macro-val">${recipe.carbs}g</span><span class="macro-lbl">carbos</span></div>
      <div class="macro-item"><span class="macro-val">${recipe.fat}g</span><span class="macro-lbl">grasas</span></div>
    </div>
    <div class="recipe-detail-grid">
      <section class="recipe-section">
        <h3>Ingredientes</h3>
        <ul class="recipe-ingredients-list">
          ${ingredients.map((ingredient) => `
            <li>
              <span class="ing-dot ${ingredient.has ? "" : "missing"}"></span>
              <span>${ingredient.name}${ingredient.has ? "" : " <small>(te falta)</small>"}</span>
            </li>
          `).join("")}
        </ul>
      </section>
      <section class="recipe-section">
        <h3>Preparacion</h3>
        <ol class="recipe-steps-list">
          ${recipe.steps.map((step, index) => `<li><span class="step-num">${index + 1}</span><span>${step}</span></li>`).join("")}
        </ol>
      </section>
    </div>
    <div class="recipe-detail-actions">
      <button class="secondary-button" data-add-recipe-cart="${recipe.id}">Ingredientes al carrito</button>
      <button class="primary-button" data-cook-recipe="${recipe.id}">Marcar como cocinada</button>
    </div>
  `);
}

function renderCart() {
  const list = document.getElementById("cartList");
  const checked = state.cart.filter((item) => item.checked).length;
  const total = state.cart.length;
  const estimated = state.cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
  document.getElementById("cartSummary").innerHTML = `
    <div><span>Total</span><strong>${total}</strong></div>
    <div><span>Marcados</span><strong>${checked}</strong></div>
    <div><span>Estimado</span><strong>${eur(estimated)}</strong></div>
  `;
  list.innerHTML = state.cart.length
    ? state.cart
        .map((item) => `
          <article class="card">
            <div>
              <h3>${item.name}</h3>
              <small>${item.qty}${item.unit} · ${item.store} · ${eur(item.price)}</small>
              <div class="meta-row"><span class="badge ${item.checked ? "green" : "amber"}">${item.checked ? "Comprado" : "Pendiente"}</span></div>
            </div>
            <div class="card-actions">
              <button class="small-action good" data-toggle-cart="${item.id}">${item.checked ? "Desmarcar" : "Marcar"}</button>
              <button class="small-action bad" data-delete-cart="${item.id}">Borrar</button>
            </div>
          </article>
        `)
        .join("")
    : `<div class="empty">El carrito esta vacio.</div>`;
}

function renderFinance() {
  const list = document.getElementById("expenseList");
  const income = state.expenses.filter((item) => item.type === "income").reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = state.expenses.filter((item) => item.type === "expense").reduce((sum, item) => sum + Number(item.amount), 0);
  document.getElementById("financeBalance").textContent = eur(income - expense);
  document.getElementById("weeklyBudgetInput").value = state.weeklyBudget;
  document.getElementById("financeStats").innerHTML = `
    <div><span>Ingresos</span><strong>${eur(income)}</strong></div>
    <div><span>Gastos</span><strong>${eur(expense)}</strong></div>
    <div><span>Comida</span><strong>${eur(getFoodSpend())}</strong></div>
  `;
  renderCategoryBreakdown();

  list.innerHTML = state.expenses.length
    ? state.expenses
        .slice()
        .reverse()
        .map((item) => `
          <article class="card">
            <div>
              <h3>${item.description || item.category}</h3>
              <small>${item.category} · ${item.type === "income" ? "Ingreso" : "Gasto"}</small>
            </div>
            <div class="card-actions">
              <span class="money">${item.type === "income" ? "+" : "-"}${eur(item.amount)}</span>
              <button class="small-action bad" data-delete-expense="${item.id}">Borrar</button>
            </div>
          </article>
        `)
      .join("")
    : `<div class="empty">No hay movimientos todavia.</div>`;
  requestAnimationFrame(drawFinanceChart);
}

function renderCategoryBreakdown() {
  const container = document.getElementById("categoryBreakdown");
  const map = {};
  state.expenses.filter((item) => item.type === "expense").forEach((item) => {
    map[item.category] = (map[item.category] || 0) + Number(item.amount || 0);
  });
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map((entry) => entry[1]), 1);
  container.innerHTML = entries.length
    ? entries.map(([category, amount]) => `
      <div class="category-row">
        <span>${category}</span>
        <div class="category-track"><i style="width:${Math.round((amount / max) * 100)}%"></i></div>
        <strong>${eur(amount)}</strong>
      </div>
    `).join("")
    : `<div class="empty">Sin gastos categorizados todavia.</div>`;
}

function drawFinanceChart() {
  const canvas = document.getElementById("financeChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const weeks = [3, 2, 1, 0].map((weekOffset) => {
    const start = new Date();
    start.setDate(start.getDate() - (weekOffset + 1) * 7);
    const end = new Date();
    end.setDate(end.getDate() - weekOffset * 7);
    return state.expenses
      .filter((item) => item.type === "expense")
      .filter((item) => {
        const d = new Date(item.date || todayMinus(weekOffset * 7));
        return d > start && d <= end;
      })
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  });
  const max = Math.max(...weeks, 10);
  const pad = 28;
  const gap = (width - pad * 2) / 4;
  const barWidth = Math.max(28, gap * 0.46);

  weeks.forEach((value, index) => {
    const barHeight = (value / max) * (height - 58);
    const x = pad + index * gap + (gap - barWidth) / 2;
    const y = height - 30 - barHeight;
    ctx.fillStyle = index === 3 ? "#4ade80" : "rgba(74,222,128,0.32)";
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = index === 3 ? "#4ade80" : "rgba(240,244,238,0.58)";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(value)} EUR`, x + barWidth / 2, Math.max(16, y - 8));
    ctx.fillStyle = "rgba(150,163,144,0.9)";
    ctx.fillText(["-4s", "-3s", "-2s", "Esta"][index], x + barWidth / 2, height - 8);
  });
}

function renderNutrition() {
  const container = document.getElementById("nutritionTotals");
  container.innerHTML = `
    <div><span>kcal</span><strong>${Math.round(state.consumed.kcal)}</strong><small>de ${state.nutrition.kcal}</small></div>
    <div><span>Proteina</span><strong>${Math.round(state.consumed.protein)}g</strong><small>de ${state.nutrition.protein}g</small></div>
    <div><span>Carbos</span><strong>${Math.round(state.consumed.carbs)}g</strong><small>de ${state.nutrition.carbs}g</small></div>
    <div><span>Grasas</span><strong>${Math.round(state.consumed.fat)}g</strong><small>de ${state.nutrition.fat}g</small></div>
  `;
  const mealList = document.getElementById("mealList");
  mealList.innerHTML = (state.consumedMeals || []).length
    ? state.consumedMeals.map((meal) => `
      <article class="meal-item">
        <span class="meal-icon">${meal.icon || "🍽"}</span>
        <div>
          <h3>${meal.name}</h3>
          <p>${meal.kcal} kcal · ${meal.protein}g prot · ${meal.carbs}g carb · ${meal.fat}g grasa</p>
        </div>
        <button class="small-action bad" data-delete-meal="${meal.id}">Borrar</button>
      </article>
    `).join("")
    : `<div class="empty">Todavia no has registrado comidas hoy.</div>`;

  const form = document.getElementById("nutritionForm");
  Object.entries(state.nutrition).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
}

function renderAll() {
  renderDashboard();
  renderInventory();
  renderRecipes();
  renderFeed();
  renderCart();
  renderFinance();
  renderNutrition();
  renderMascotSelector();
  saveState();
}

function addInventory(data) {
  state.inventory.push({
    id: uid(),
    name: data.get("name").trim(),
    qty: Number(data.get("qty")),
    unit: data.get("unit"),
    storage: data.get("storage"),
    expires: data.get("expires"),
    price: Number(data.get("price")),
    kcal: Number(data.get("kcal")),
    protein: Number(data.get("protein")),
  });
  setMascot("Alimento guardado. Estoy vigilando caducidades.");
  showToast("Alimento anadido al inventario");
}

function consumeItem(id) {
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item) return;
  const grams = item.unit === "kg" ? item.qty * 1000 : item.qty;
  state.consumed.kcal += (item.kcal * grams) / 100;
  state.consumed.protein += (item.protein * grams) / 100;
  state.consumed.carbs += Math.max(8, item.kcal / 10);
  state.consumed.fat += Math.max(2, item.kcal / 40);
  state.inventory = state.inventory.filter((entry) => entry.id !== id);
  setMascot("Consumo registrado. Macros actualizados.");
  showToast(`${item.name} consumido`);
}

function addInventoryToCart(id) {
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item) return;
  state.cart.push({ id: uid(), name: item.name, qty: item.qty, unit: item.unit, price: item.price, store: "Mercadona", checked: false });
  showToast("Producto enviado al carrito");
}

function addRecipeToCart(recipeId) {
  const recipe = findRecipe(recipeId);
  if (!recipe) return;
  recipe.ingredients.forEach((ingredient) => {
    const existing = state.cart.find((item) => item.name.toLowerCase() === ingredient.toLowerCase() && !item.checked);
    if (existing) {
      existing.qty += 1;
    } else {
      state.cart.push({ id: uid(), name: ingredient, qty: 1, unit: "ud", price: Math.max(0.6, recipe.cost / recipe.ingredients.length), store: "Mercadona", checked: false });
    }
  });
  setMascot("Ingredientes fusionados en el carrito.");
  showToast("Ingredientes anadidos al carrito");
}

function cookRecipe(recipeId) {
  const recipe = findRecipe(recipeId);
  if (!recipe) return;
  state.consumed.kcal += recipe.kcal;
  state.consumed.protein += recipe.protein;
  state.consumed.carbs += recipe.carbs;
  state.consumed.fat += recipe.fat;
  state.consumedMeals ||= [];
  state.consumedMeals.push({
    id: uid(),
    icon: "🍽",
    name: recipe.title,
    kcal: recipe.kcal,
    protein: recipe.protein,
    carbs: recipe.carbs,
    fat: recipe.fat,
  });
  setMascot("Receta cocinada. Objetivos actualizados.");
  showToast("Receta registrada en nutricion");
}

function completeCart() {
  const checked = state.cart.filter((item) => item.checked);
  const total = checked.reduce((sum, item) => sum + Number(item.price), 0);
  if (!checked.length) {
    showToast("Marca items como comprados primero");
    return;
  }
  state.expenses.push({ id: uid(), type: "expense", amount: total, category: "Comida", description: "Compra completada desde carrito", date: todayPlus(0) });
  checked.forEach((item) => {
    state.inventory.push({
      id: uid(),
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      storage: "Despensa",
      expires: todayPlus(14),
      price: item.price,
      kcal: 100,
      protein: 5,
    });
  });
  state.cart = state.cart.filter((item) => !item.checked);
  setMascot("Compra completada. Finanzas e inventario sincronizados.");
  showToast("Compra completada");
}

function moveCheckedToInventory() {
  const checked = state.cart.filter((item) => item.checked);
  checked.forEach((item) => {
    state.inventory.push({
      id: uid(),
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      storage: "Despensa",
      expires: todayPlus(14),
      price: item.price,
      kcal: 100,
      protein: 5,
    });
  });
  state.cart = state.cart.filter((item) => !item.checked);
  showToast(`${checked.length} productos movidos a despensa`);
}

function seedDemo() {
  state = structuredClone(defaultState);
  state.inventory = [
    { id: uid(), name: "Pechuga de pollo", qty: 260, unit: "g", storage: "Nevera", expires: todayPlus(1), price: 2.8, kcal: 120, protein: 23 },
    { id: uid(), name: "Arroz integral", qty: 500, unit: "g", storage: "Despensa", expires: todayPlus(60), price: 1.7, kcal: 360, protein: 8 },
    { id: uid(), name: "Tomate cherry", qty: 180, unit: "g", storage: "Nevera", expires: todayPlus(3), price: 1.4, kcal: 18, protein: 1 },
    { id: uid(), name: "Yogur griego", qty: 1, unit: "ud", storage: "Nevera", expires: todayPlus(2), price: 0.9, kcal: 95, protein: 10 },
  ];
  state.cart = [{ id: uid(), name: "Huevos", qty: 6, unit: "ud", price: 2.2, store: "Mercadona", checked: false }];
  state.expenses = [{ id: uid(), type: "income", amount: 1200, category: "Ahorro", description: "Ingreso demo", date: todayPlus(0) }];
  state.expenses.push(
    { id: uid(), type: "expense", amount: 58.4, category: "Comida", description: "Mercadona demo", date: todayMinus(1) },
    { id: uid(), type: "expense", amount: 32.5, category: "Comida", description: "Restaurante demo", date: todayMinus(5) },
    { id: uid(), type: "expense", amount: 24.2, category: "Salud", description: "Suplementos demo", date: todayMinus(10) },
    { id: uid(), type: "expense", amount: 47.9, category: "Comida", description: "Lidl demo", date: todayMinus(16) },
    { id: uid(), type: "expense", amount: 19.6, category: "Ocio", description: "Cena fuera demo", date: todayMinus(23) }
  );
  state.feedPosts = buildDemoPosts();
  state.consumedMeals = [];
  setMascot("Datos demo cargados. Prueba cocinar o completar carrito.");
  showToast("Datos demo cargados");
  renderAll();
}

function buildDemoPosts() {
  return [
    {
      id: uid(),
      recipeId: "chicken-rice",
      author: "zana",
      title: "Cena de recomposicion",
      caption: "Pollo, arroz y tomate usando lo que caducaba manana.",
      likes: 42,
      comments: [{ author: "María", text: "La voy a probar para despues del gym." }],
    },
    {
      id: uid(),
      recipeId: "lentils",
      author: "volt",
      title: "Comida por menos de 2 EUR",
      caption: "Lentejas de despensa, saciantes y muy baratas.",
      likes: 27,
      comments: [{ author: "Carlos", text: "Esto salva semanas de presupuesto ajustado." }],
    },
  ];
}

function addBarcodeDemoProduct() {
  state.inventory.push({
    id: uid(),
    name: "Atun al natural",
    qty: 3,
    unit: "ud",
    storage: "Despensa",
    expires: todayPlus(120),
    price: 2.4,
    kcal: 110,
    protein: 24,
  });
  setMascot("Barcode demo leido: Atun al natural.");
  showToast("Producto barcode anadido");
}

function addPhotoDemoProduct() {
  state.inventory.push({
    id: uid(),
    name: "Zanahoria fresca",
    qty: 300,
    unit: "g",
    storage: "Nevera",
    expires: todayPlus(5),
    price: 0.8,
    kcal: 41,
    protein: 1,
  });
  setMascot("Foto IA demo analizada: zanahoria fresca con confianza 0.91.");
  showToast("Foto IA convertida en alimento");
}

function publishFeedPost(data) {
  const recipeId = data.get("recipeId");
  const recipe = findRecipe(recipeId) || recipes[0];
  state.feedPosts.push({
    id: uid(),
    recipeId,
    author: "tu",
    title: data.get("title").trim() || recipe.title,
    caption: data.get("caption").trim() || "Receta guardada desde mi FoodOS.",
    likes: 0,
    comments: [],
  });
  setMascot("Publicacion creada en el feed local.");
  showToast("Publicado en feed");
}

function assistantInsight(kind) {
  const output = document.getElementById("assistantOutput");
  const proteinLeft = Math.max(0, state.nutrition.protein - state.consumed.protein);
  const budgetLeft = getBudgetLeft();
  const cheapest = [...allRecipes()].sort((a, b) => a.cost / a.protein - b.cost / b.protein)[0];
  const messages = {
    ticket: "Ticket demo leido: 18,40 EUR en Comida. He separado supermercado, fruta y proteina. En produccion esto vendria de OCR + Gemini.",
    bank: "Banco demo sincronizado: detecte 3 cargos de supermercado esta semana y actualice el presupuesto disponible.",
    week: `Plan semanal demo: prioriza ${cheapest.title}, pasta con atun y bowl de pollo. Objetivo: cubrir ${Math.round(proteinLeft)}g de proteina pendiente sin pasar de ${eur(budgetLeft)}.`,
    optimize: `Mejor proteina/EUR ahora: ${cheapest.title}. Aporta ${cheapest.protein}g por ${eur(cheapest.cost)}.`,
  };
  output.textContent = messages[kind];
  if (kind === "ticket") {
    state.expenses.push({ id: uid(), type: "expense", amount: 18.4, category: "Comida", description: "Ticket demo OCR", date: todayPlus(0) });
  }
  if (kind === "bank") {
    state.bankSynced = true;
    state.expenses.push({ id: uid(), type: "expense", amount: 9.75, category: "Comida", description: "Banco demo: supermercado", date: todayPlus(0) });
  }
  setMascot("Insight local generado.");
  showToast("Insight generado");
}

document.addEventListener("click", (event) => {
  const recipeTarget = event.target.closest("[data-open-recipe]");
  const target = event.target.closest("button");
  if (!target && recipeTarget) {
    openRecipeDetail(recipeTarget.dataset.openRecipe);
    return;
  }
  if (!target) return;

  if (target.dataset.view) setView(target.dataset.view);
  if (target.dataset.jump) setView(target.dataset.jump);
  if (target.dataset.openRecipe) {
    openRecipeDetail(target.dataset.openRecipe);
    return;
  }

  if (target.dataset.recipeTag) {
    state.recipeTag = target.dataset.recipeTag;
    renderAll();
    return;
  }

  if (target.classList.contains("filter") && target.dataset.storage) {
    state.activeStorage = target.dataset.storage;
    document.querySelectorAll(".filter").forEach((button) => button.classList.toggle("active", button === target));
    renderAll();
  }

  if (target.dataset.consume) consumeItem(target.dataset.consume);
  if (target.dataset.cartFromInventory) addInventoryToCart(target.dataset.cartFromInventory);
  if (target.dataset.deleteInventory) state.inventory = state.inventory.filter((item) => item.id !== target.dataset.deleteInventory);
  if (target.dataset.addRecipeCart) addRecipeToCart(target.dataset.addRecipeCart);
  if (target.dataset.cookRecipe) {
    cookRecipe(target.dataset.cookRecipe);
    closeModal();
  }
  if (target.dataset.toggleCart) {
    const item = state.cart.find((entry) => entry.id === target.dataset.toggleCart);
    if (item) item.checked = !item.checked;
  }
  if (target.dataset.deleteCart) state.cart = state.cart.filter((item) => item.id !== target.dataset.deleteCart);
  if (target.dataset.deleteExpense) state.expenses = state.expenses.filter((item) => item.id !== target.dataset.deleteExpense);
  if (target.dataset.deleteMeal) {
    const meal = (state.consumedMeals || []).find((entry) => entry.id === target.dataset.deleteMeal);
    if (meal) {
      state.consumed.kcal = Math.max(0, state.consumed.kcal - meal.kcal);
      state.consumed.protein = Math.max(0, state.consumed.protein - meal.protein);
      state.consumed.carbs = Math.max(0, state.consumed.carbs - meal.carbs);
      state.consumed.fat = Math.max(0, state.consumed.fat - meal.fat);
    }
    state.consumedMeals = (state.consumedMeals || []).filter((entry) => entry.id !== target.dataset.deleteMeal);
  }
  if (target.dataset.likePost) {
    const post = state.feedPosts.find((entry) => entry.id === target.dataset.likePost);
    if (post) post.likes += 1;
  }
  if (target.dataset.commentPost) {
    const input = document.querySelector(`[data-comment-input="${target.dataset.commentPost}"]`);
    const text = input?.value.trim();
    const post = state.feedPosts.find((entry) => entry.id === target.dataset.commentPost);
    if (post && text) {
      post.comments ||= [];
      post.comments.push({ author: "Tú", text });
      input.value = "";
      showToast("Comentario añadido");
    }
  }
  if (target.dataset.saveFeed) {
    state.savedRecipeIds ||= [];
    const recipeId = target.dataset.saveFeed;
    if (state.savedRecipeIds.includes(recipeId)) {
      state.savedRecipeIds = state.savedRecipeIds.filter((id) => id !== recipeId);
      showToast("Receta quitada de guardadas");
    } else {
      state.savedRecipeIds.push(recipeId);
      setMascot("Receta guardada en tu coleccion.");
      showToast("Receta guardada");
    }
  }
  if (target.dataset.mascotId) {
    state.mascotId = target.dataset.mascotId;
    const active = getActiveMascot();
    setMascot(`${active.name} seleccionado. ${active.tagline}.`);
    showToast(`${active.name} es ahora tu compañero`);
  }

  renderAll();
});

document.getElementById("inventoryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addInventory(new FormData(event.currentTarget));
  event.currentTarget.reset();
  event.currentTarget.elements.expires.value = todayPlus(4);
  renderAll();
});

document.getElementById("inventorySearchInput").addEventListener("input", (event) => {
  state.inventorySearch = event.target.value;
  renderAll();
});

document.getElementById("cartForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.cart.push({
    id: uid(),
    name: data.get("name").trim(),
    qty: Number(data.get("qty")),
    unit: data.get("unit"),
    price: Number(data.get("price")),
    store: data.get("store"),
    checked: false,
  });
  event.currentTarget.reset();
  showToast("Item anadido al carrito");
  renderAll();
});

document.getElementById("expenseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.expenses.push({
    id: uid(),
    type: data.get("type"),
    amount: Number(data.get("amount")),
    category: data.get("category"),
    description: data.get("description").trim(),
    date: todayPlus(0),
  });
  event.currentTarget.reset();
  showToast("Movimiento guardado");
  renderAll();
});

document.getElementById("feedForm").addEventListener("submit", (event) => {
  event.preventDefault();
  publishFeedPost(new FormData(event.currentTarget));
  event.currentTarget.reset();
  renderAll();
});

document.getElementById("nutritionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.nutrition = {
    kcal: Number(data.get("kcal")),
    protein: Number(data.get("protein")),
    carbs: Number(data.get("carbs")),
    fat: Number(data.get("fat")),
    mode: data.get("mode"),
  };
  setMascot(`Objetivo actualizado: ${state.nutrition.mode}.`);
  showToast("Objetivo nutricional actualizado");
  renderAll();
});

document.getElementById("weeklyBudgetInput").addEventListener("change", (event) => {
  state.weeklyBudget = Number(event.target.value);
  showToast("Presupuesto actualizado");
  renderAll();
});

document.getElementById("completeCartButton").addEventListener("click", completeCart);
document.getElementById("moveCheckedButton").addEventListener("click", () => {
  moveCheckedToInventory();
  renderAll();
});
document.getElementById("clearCheckedButton").addEventListener("click", () => {
  state.cart = state.cart.filter((item) => !item.checked);
  showToast("Marcados eliminados");
  renderAll();
});
document.getElementById("seedButton").addEventListener("click", seedDemo);
document.getElementById("modalCloseButton").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (event) => {
  if (event.target.id === "modalOverlay") closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if (event.key === "Enter" && event.target.closest("[data-open-recipe]")) {
    openRecipeDetail(event.target.closest("[data-open-recipe]").dataset.openRecipe);
  }
});
document.getElementById("barcodeDemoButton").addEventListener("click", () => {
  addBarcodeDemoProduct();
  renderAll();
});
document.getElementById("photoDemoButton").addEventListener("click", () => {
  addPhotoDemoProduct();
  renderAll();
});
document.getElementById("seedFeedButton").addEventListener("click", () => {
  state.feedPosts = buildDemoPosts();
  setMascot("Feed demo generado con imagenes PNG.");
  showToast("Posts demo creados");
  renderAll();
});
document.getElementById("resetButton").addEventListener("click", () => {
  if (!confirm("Borrar todos los datos locales de FoodOS?")) return;
  state = structuredClone(defaultState);
  FoodOSData.local.clear();
  showToast("Datos locales borrados");
  renderAll();
});

document.getElementById("generateRecipeButton").addEventListener("click", () => {
  const names = state.inventory.slice(0, 3).map((item) => item.name).join(", ") || "ingredientes disponibles";
  state.customRecipes ||= [];
  state.customRecipes.unshift({
    id: uid(),
    title: `Receta rapida con ${names}`,
    ingredients: state.inventory.slice(0, 3).map((item) => item.name.toLowerCase().split(" ")[0]).filter(Boolean),
    kcal: 520,
    protein: 38,
    carbs: 55,
    fat: 16,
    cost: 2.6,
    image: "assets/recipe-chicken-bowl.png",
    time: 18,
    servings: 1,
    difficulty: "IA local",
    tags: ["IA", "rápida", "aprovechamiento"],
    steps: ["Revisa ingredientes detectados en tu inventario.", "Saltea la base proteica con verduras.", "Ajusta porción y guarda si te encaja."],
  });
  setMascot("Receta generada localmente. En produccion usaria Gemini.");
  showToast("Receta IA local generada");
  renderAll();
});

document.getElementById("cookSuggestionButton").addEventListener("click", () => {
  const recipe = bestRecipe();
  if (recipe) cookRecipe(recipe.id);
  renderAll();
});

document.getElementById("clearConsumedButton").addEventListener("click", () => {
  state.consumed = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  state.consumedMeals = [];
  showToast("Dia nutricional reiniciado");
  renderAll();
});

document.getElementById("quickMealButton").addEventListener("click", () => {
  const recipe = bestRecipe();
  if (recipe) cookRecipe(recipe.id);
  renderAll();
});

document.getElementById("scanTicketButton").addEventListener("click", () => {
  assistantInsight("ticket");
  renderAll();
});
document.getElementById("syncBankButton").addEventListener("click", () => {
  assistantInsight("bank");
  renderAll();
});
document.getElementById("weekPlanButton").addEventListener("click", () => assistantInsight("week"));
document.getElementById("optimizeBudgetButton").addEventListener("click", () => assistantInsight("optimize"));
document.getElementById("recipeMode").addEventListener("change", renderRecipes);

// ---------- Exportar / importar datos (puente hasta tener Supabase) ----------

document.getElementById("exportButton").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `foodos-datos-${todayPlus(0)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Datos exportados a JSON");
});

document.getElementById("importButton").addEventListener("click", () => {
  document.getElementById("importInput").click();
});

document.getElementById("importInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (typeof imported !== "object" || imported === null || !Array.isArray(imported.inventory)) {
      throw new Error("formato no reconocido");
    }
    state = { ...structuredClone(defaultState), ...imported };
    showToast("Datos importados");
    renderAll();
  } catch {
    showToast("El archivo no es un export valido de FoodOS");
  }
  event.target.value = "";
});

// ---------- Cuenta / sincronizacion con Supabase ----------

function updateDataModeText() {
  const label = document.getElementById("dataModeText");
  if (FoodOSData.mode === "supabase") {
    label.textContent = `Conectado a Supabase · ${FoodOSData.remote.user.email || "sesion activa"}`;
  } else if (FoodOSData.remote.ready) {
    label.textContent = "Supabase configurado · inicia sesion para sincronizar";
  } else {
    label.textContent = "Datos locales · Supabase sin conectar";
  }
}

function openAuthModal() {
  if (!FoodOSData.remote.ready) {
    openModal("Cuenta FoodOS", `
      <p>La base de datos todavia no esta conectada. Tus datos viven en este navegador
      (localStorage) y puedes llevartelos con el boton de exportar.</p>
      <p>Para activar cuentas y sincronizacion:</p>
      <ol class="recipe-steps-list">
        <li><span class="step-num">1</span><span>Crea un proyecto gratuito en supabase.com y ejecuta <code>supabase/schema.sql</code>.</span></li>
        <li><span class="step-num">2</span><span>Copia <code>supabase-config.example.js</code> como <code>supabase-config.js</code> con tus claves.</span></li>
        <li><span class="step-num">3</span><span>Descomenta las dos lineas de "Integracion Supabase" en <code>index.html</code>.</span></li>
      </ol>
      <p>Los pasos completos estan en el README de esta carpeta.</p>
    `);
    return;
  }

  if (FoodOSData.remote.user) {
    openModal("Cuenta FoodOS", `
      <p>Sesion iniciada como <strong>${FoodOSData.remote.user.email || FoodOSData.remote.user.id}</strong>.</p>
      <p>Tus cambios se guardan en local y se sincronizan con Supabase automaticamente.</p>
      <div class="recipe-detail-actions">
        <button class="secondary-button" id="signOutButton">Cerrar sesion</button>
      </div>
    `);
    document.getElementById("signOutButton").addEventListener("click", async () => {
      await FoodOSData.remote.signOut();
      closeModal();
      updateDataModeText();
      showToast("Sesion cerrada. Sigues en modo local.");
    });
    return;
  }

  openModal("Iniciar sesion", `
    <p>Conecta tu cuenta para sincronizar inventario, recetas y finanzas entre dispositivos.</p>
    <div class="recipe-detail-actions">
      <button class="primary-button" id="googleLoginButton">Continuar con Google</button>
    </div>
    <p style="margin-top:16px">O recibe un enlace magico por email:</p>
    <form id="magicLinkForm" class="feed-comment-form">
      <input type="email" name="email" required placeholder="tu@email.com" />
      <button class="small-action good" type="submit">Enviar enlace</button>
    </form>
  `);
  document.getElementById("googleLoginButton").addEventListener("click", () => {
    FoodOSData.remote.signInWithGoogle();
  });
  document.getElementById("magicLinkForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    const { error } = await FoodOSData.remote.signInWithMagicLink(email);
    showToast(error ? `Error: ${error.message}` : "Enlace enviado. Revisa tu correo.");
    if (!error) closeModal();
  });
}

document.getElementById("authButton").addEventListener("click", openAuthModal);

// ---------- Arranque ----------

function initDefaults() {
  const inventoryForm = document.getElementById("inventoryForm");
  inventoryForm.elements.expires.value = todayPlus(4);
  updateDataModeText();
  renderAll();
}

initDefaults();

// Si supabase-js + supabase-config.js estan cargados (ver index.html),
// esto activa sesion y sincronizacion. Si no, la app sigue 100% local.
FoodOSData.init(defaultState, {
  onAuthChange: () => updateDataModeText(),
  onRemoteState: (remoteState) => {
    state = remoteState;
    setMascot("Datos sincronizados desde Supabase.");
    showToast("Estado cargado desde la base de datos");
    renderAll();
  },
}).then(updateDataModeText);
