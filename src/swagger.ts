import script from "swagger-ui-dist/swagger-ui-bundle.js" with { type: "text" };
import style from "swagger-ui-dist/swagger-ui.css" with { type: "text" };

export function swaggerResponse(path: string): Response | undefined {
  if (path === "/swagger/swagger-ui-bundle.js") {
    return new Response(script, { headers: { "content-type": "application/javascript; charset=utf-8" } });
  }
  if (path === "/swagger/swagger-ui.css") {
    return new Response(style, { headers: { "content-type": "text/css; charset=utf-8" } });
  }
  if (path === "/swagger" || path === "/swagger/index.html") {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <title>SyncClipboard API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head>
      <body><div id="swagger-ui"></div><script src="/swagger/swagger-ui-bundle.js"></script>
      <script>SwaggerUIBundle({url:'/swagger/v1/swagger.json',dom_id:'#swagger-ui',validatorUrl:null});</script>
      </body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return undefined;
}
