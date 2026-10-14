(() => {
  const input = document.getElementById("key");
  const btn = document.getElementById("toggleKey");
  if (!input || !btn) return;

  btn.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "مخفی کردن کلید" : "نمایش کلید");
    input.focus();
  });
})();
