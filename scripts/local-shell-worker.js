/* Private device cache only. Public Pages still serves encrypted HTML. */
const LOCAL_SHELL_HASH='__LOCAL_SHELL_HASH__';
function isUnlockedShell(response){return response?.headers.get('X-Playroom-Local-Shell')===LOCAL_SHELL_HASH;}
self.addEventListener('message',event=>{
  if(event.data?.kind!=='playroom-store-local-shell')return;
  event.waitUntil((async()=>{
    const reply=ok=>event.ports?.[0]?.postMessage({ok});
    try{
      const client=event.source?.id?await self.clients.get(event.source.id):null;
      const scope=new URL('./',self.location.href),url=client?new URL(client.url):null;
      if(!url||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return reply(false);
      const html=event.data.html;
      if(typeof html!=='string'||html.length>20*1024*1024)return reply(false);
      const bytes=new TextEncoder().encode(html),hash=await crypto.subtle.digest('SHA-256',bytes);
      if([...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')!==LOCAL_SHELL_HASH)return reply(false);
      const cache=await caches.open(CACHE);
      // Same key: a successful atomic put replaces ciphertext, never keeps both.
      await cache.put('./index.html',new Response(bytes,{headers:{'Content-Type':'text/html; charset=utf-8','X-Playroom-Local-Shell':LOCAL_SHELL_HASH}}));
      reply(true);
    }catch(_){reply(false);}
  })());
});
