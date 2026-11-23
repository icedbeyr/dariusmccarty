import { getStore } from "@netlify/blobs";

const ID_PATTERN = /^\d{13}-[0-9a-f-]{36}$/;

export default async (req, context) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const id = context.params.id;
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });

  const store = getStore({ name: "images", consistency: "strong" });
  const entry = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!entry) return new Response("Not found", { status: 404 });

  return new Response(entry.data, {
    headers: {
      "Content-Type": entry.metadata.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

export const config = { path: "/api/image/:id" };
