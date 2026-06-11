const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Mascotas ----------

document.querySelectorAll(".mascot").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mascot").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const caption = document.getElementById("mascot-caption");
    caption.textContent = `${button.dataset.name} - ${button.dataset.tagline}`;
  });
});

// ---------- Reveal al hacer scroll ----------

const revealTargets = document.querySelectorAll(
  ".module-card, .intro-grid article, .stack-grid article, .manual-list article, .steps li, .login-card, .qr-panel, .download-options a"
);

revealTargets.forEach((element) => element.classList.add("reveal"));

if (!prefersReducedMotion) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.16 }
  );
  revealTargets.forEach((element) => observer.observe(element));
} else {
  revealTargets.forEach((element) => element.classList.add("is-visible"));
}

// ---------- Hero parallax (placeholder del video scrubbing del PDF) ----------
// En produccion (Next.js) esto se sustituye por GSAP ScrollTrigger + video,
// tal y como describe la seccion 16.3 de la documentacion.

const heroImage = document.querySelector(".hero-image");
if (heroImage && !prefersReducedMotion) {
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const progress = Math.min(1, window.scrollY / window.innerHeight);
        heroImage.style.transform = `scale(${1 + progress * 0.12}) translateY(${progress * 36}px)`;
        ticking = false;
      });
    },
    { passive: true }
  );
}

// ---------- QR conceptual (se dibuja celda a celda desde el centro) ----------

const qrCanvas = document.getElementById("qrCanvas");
if (qrCanvas) {
  const ctx = qrCanvas.getContext("2d");
  const cells = 21;
  const size = qrCanvas.width / cells;

  // Patron pseudoaleatorio pero determinista para que parezca un QR real.
  function cellOn(col, row) {
    const finder = (x, y) => col >= x && col < x + 7 && row >= y && row < y + 7;
    if (finder(0, 0) || finder(cells - 7, 0) || finder(0, cells - 7)) {
      const local = (x, y) => {
        const cx = col - x;
        const cy = row - y;
        return cx === 0 || cx === 6 || cy === 0 || cy === 6 || (cx >= 2 && cx <= 4 && cy >= 2 && cy <= 4);
      };
      if (finder(0, 0)) return local(0, 0);
      if (finder(cells - 7, 0)) return local(cells - 7, 0);
      return local(0, cells - 7);
    }
    return ((col * 31 + row * 17 + ((col * row) % 7)) % 5) < 2;
  }

  const queue = [];
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      if (cellOn(col, row)) {
        const distance = Math.hypot(col - cells / 2, row - cells / 2);
        queue.push({ col, row, distance });
      }
    }
  }
  queue.sort((a, b) => a.distance - b.distance);

  function drawCell({ col, row }) {
    ctx.fillStyle = "#4ade80";
    ctx.fillRect(col * size + 1, row * size + 1, size - 2, size - 2);
  }

  if (prefersReducedMotion) {
    queue.forEach(drawCell);
  } else {
    const qrObserver = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        qrObserver.disconnect();
        let index = 0;
        const step = () => {
          for (let i = 0; i < 6 && index < queue.length; i += 1) {
            drawCell(queue[index]);
            index += 1;
          }
          if (index < queue.length) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      { threshold: 0.4 }
    );
    qrObserver.observe(qrCanvas);
  }
}

// ---------- Login mock (preparado para Supabase Auth) ----------
// Cuando exista el proyecto de Supabase, estos handlers llamaran a
// supabase.auth.signInWithOAuth / signInWithOtp (ver fooOSappweb/data-layer.js,
// que ya implementa ambos flujos).

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  const note = document.getElementById("login-note");
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = new FormData(loginForm).get("email");
    note.textContent = `Demo: aqui se enviaria un enlace magico a ${email} con Supabase Auth.`;
  });
  document.getElementById("googleButton").addEventListener("click", () => {
    note.textContent = "Demo: aqui se abriria el OAuth de Google via Supabase Auth.";
  });
}
