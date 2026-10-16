const PUBLIC_PREFIXES = ["front/", "rear/"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function responseHeaders(object) {
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function isAllowedKey(key) {
  return PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function badRequest(message, status = 400) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return badRequest("Method not allowed", 405);
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    if (!key || key.includes("..") || !isAllowedKey(key)) {
      return badRequest("Not found", 404);
    }

    const object = await env.MUG_ASSETS.get(key, {
      onlyIf: request.headers,
    });

    if (object === null) {
      return badRequest("Not found", 404);
    }

    const headers = responseHeaders(object);

    if (object.range) {
      headers.set("Content-Range", `bytes ${object.range.offset}-${object.range.end ?? object.range.offset + object.range.length - 1}/${object.size}`);
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(object.body, {
      status: object.range ? 206 : 200,
      headers,
    });
  },
};
