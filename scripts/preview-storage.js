/* Deployment-only storage boundary. The production runtime is unchanged. */
(() => {
  'use strict';
  const prefix='__PREVIEW_NAMESPACE__';
  if(window.__PlayroomPreviewStorage===prefix)return;
  function storage(native){
    const names=()=>Array.from({length:native.length},(_,i)=>native.key(i)).filter(k=>k?.startsWith(prefix));
    const api={getItem:k=>native.getItem(prefix+String(k)),setItem:(k,v)=>native.setItem(prefix+String(k),String(v)),removeItem:k=>native.removeItem(prefix+String(k)),clear:()=>names().forEach(k=>native.removeItem(k)),key:i=>names()[Number(i)]?.slice(prefix.length)??null};
    return new Proxy(api,{get:(target,key)=>key==='length'?names().length:key in target?target[key]:typeof key==='string'?api.getItem(key):undefined,set:(_,key,value)=>{api.setItem(key,value);return true;},deleteProperty:(_,key)=>{api.removeItem(key);return true;},ownKeys:()=>names().map(k=>k.slice(prefix.length)),getOwnPropertyDescriptor:(_,key)=>api.getItem(key)===null?undefined:{enumerable:true,configurable:true,value:api.getItem(key),writable:true}});
  }
  for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{value:storage(window[name]),configurable:false});
  const idb=window.indexedDB;
  Object.defineProperty(window,'indexedDB',{configurable:false,value:new Proxy(idb,{get:(target,key)=>key==='open'?(name,...args)=>target.open(prefix+String(name),...args):key==='deleteDatabase'?name=>target.deleteDatabase(prefix+String(name)):key==='databases'?async()=> (await target.databases()).filter(row=>row.name?.startsWith(prefix)).map(row=>({...row,name:row.name.slice(prefix.length)})):typeof target[key]==='function'?target[key].bind(target):target[key]})});
  const nativeCaches=window.caches,cachePrefix='playroom-pages-__PREVIEW_PATH__-';
  const owned=name=>name.startsWith(prefix)||name.startsWith(cachePrefix),scoped=name=>owned(String(name))?String(name):prefix+String(name);
  if(nativeCaches)Object.defineProperty(window,'caches',{configurable:false,value:{keys:async()=> (await nativeCaches.keys()).filter(owned),open:name=>nativeCaches.open(scoped(name)),delete:name=>nativeCaches.delete(scoped(name)),has:name=>nativeCaches.has(scoped(name)),match:async(request,options={})=>{if(options.cacheName)return nativeCaches.match(request,{...options,cacheName:scoped(options.cacheName)});for(const name of (await nativeCaches.keys()).filter(owned)){const found=await(await nativeCaches.open(name)).match(request,options);if(found)return found;}}}});
  const locks=navigator.locks;
  if(locks)Object.defineProperty(navigator,'locks',{configurable:false,value:{request:(name,...args)=>locks.request(prefix+String(name),...args),query:async()=>{const state=await locks.query();return Object.fromEntries(Object.entries(state).map(([key,rows])=>[key,rows.filter(row=>row.name.startsWith(prefix)).map(row=>({...row,name:row.name.slice(prefix.length)}))]));}}});
  Object.defineProperty(window,'__PlayroomPreviewStorage',{value:prefix});
})();
