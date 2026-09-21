// Storefront filters (progressive enhancement). The pages are fully usable without JavaScript: every product card is
// already in the HTML. This only adds "Digital Download / Physical Product" and category filtering on collection pages.
// It never fetches anything and never touches secrets.
(() => {
  const bar = document.querySelector("[data-filter-bar]");
  const grid = document.querySelector("[data-shop-grid]");

  if (!bar || !grid) {
    return;
  }

  const cards = Array.from(grid.querySelectorAll(".shop-card"));
  const status = bar.querySelector("[data-filter-status]");
  const empty = document.querySelector("[data-filter-empty]");
  const active = { type: "", sub: "" };

  const apply = () => {
    let visible = 0;

    cards.forEach((card) => {
      const matchesType = !active.type || card.dataset.productType === active.type;
      const matchesSub = !active.sub || card.dataset.subcollection === active.sub;
      const show = matchesType && matchesSub;

      card.hidden = !show;

      if (show) {
        visible += 1;
      }
    });

    if (status) {
      status.textContent = `Showing ${visible} of ${cards.length} ${cards.length === 1 ? "piece" : "pieces"}`;
    }

    if (empty) {
      empty.hidden = visible !== 0;
    }
  };

  bar.addEventListener("click", (event) => {
    const chip = event.target.closest(".filter-chip");

    if (!chip || !bar.contains(chip)) {
      return;
    }

    const key = chip.dataset.filter;

    if (key !== "type" && key !== "sub") {
      return;
    }

    active[key] = chip.dataset.value || "";

    chip.parentElement.querySelectorAll(".filter-chip").forEach((other) => {
      const isActive = other === chip;
      other.classList.toggle("is-active", isActive);
      other.setAttribute("aria-pressed", String(isActive));
    });

    apply();
  });

  apply();
})();
