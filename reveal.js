(() => {
  document.querySelectorAll(".eye").forEach((btn) => {
    const input = btn.parentElement.querySelector("input");
    if (!input) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "مخفی کردن کلید" : "نمایش کلید");
      input.focus();
    });
  });
})();
