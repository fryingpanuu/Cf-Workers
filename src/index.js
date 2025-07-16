// src/index.js
addEventListener("fetch", (event) => {
  event.respondWith(new Response("Hello World from Cloudflare Worker!"));
});
