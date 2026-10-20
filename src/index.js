export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "PROJET RESTREINT",
        status: "online",
        backend: "initialisation",
        message: "Le site est deploye. Les fonctions privees seront configurees ensuite."
      }, {
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
