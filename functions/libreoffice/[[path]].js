export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetUrl = `https://wasm-proxy-worker.nguyen-v-tu-9849.workers.dev/libreoffice${url.pathname.replace('/libreoffice', '')}`;

  const response = await fetch(targetUrl, {
    method: context.request.method,
    headers: context.request.headers,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
