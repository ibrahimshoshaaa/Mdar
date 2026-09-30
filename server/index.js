import http from 'node:http';
import {handler,runShopifySync} from './app.js';

http.createServer(handler).listen(Number(process.env.PORT||3000),()=>console.log('Madar listening on '+(process.env.PORT||3000)));
setInterval(()=>runShopifySync().catch(err=>console.error('Shopify sync:',err.message)),20000).unref();
