// Helpers shared by the Netlify functions.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

// Keys sort lexicographically, so a reversed timestamp puts the newest entry first.
export const newKey = () =>
  `${String(9999999999999 - Date.now()).padStart(13, "0")}-${crypto.randomUUID()}`;

export const ID_PATTERN = /^\d{13}-[0-9a-f-]{36}$/;

// Keep only the newest `max` entries in a store (used for the moderation log).
export async function trimStore(store, max) {
  const { blobs } = await store.list();
  if (blobs.length <= max) return;
  const keys = blobs.map((b) => b.key).sort();
  await Promise.all(keys.slice(max).map((key) => store.delete(key)));
}
