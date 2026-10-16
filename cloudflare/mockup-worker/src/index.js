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

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD, OPTIONS",
      ...corsHeaders(),
    },
  });
}

function parseKey(pathname) {
  try {
    const key = decodeURIComponent(pathname.replace(/^\/+/, ""));
    if (!key || key.includes("..") || key.includes("\\")) return null;
    return PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix)) ? key : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed();
    }

    const key = parseKey(new URL(request.url).pathname);
    if (!key) return notFound();

    if (request.method === "HEAD") {
      const object = await env.MUG_ASSETS.head(key);
      if (object === null) return notFound();
      return new Response(null, { status: 200, headers: responseHeaders(object) });
    }

    const object = await env.MUG_ASSETS.get(key);
    if (object === null) return notFound();

    return new Response(object.body, {
      status: 200,
      headers: responseHeaders(object),
    });
  },
};
