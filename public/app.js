async function checkSite() {
  const title = document.getElementById("status-title");
  const detail = document.getElementById("status-text");

  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error("Service indisponible");

    const data = await response.json();

    title.textContent = data.status === "online"
      ? "Site accessible"
      : "Vérification en cours";

    detail.textContent = data.status === "online"
      ? "Hébergement Cloudflare opérationnel. Comptes et messagerie à configurer."
      : "La plateforme termine son initialisation.";
  } catch {
    title.textContent = "Vérification indisponible";
    detail.textContent = "Réessaie dans quelques instants.";
  }
}

checkSite();
