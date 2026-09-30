import http from 'node:http';
import app from '../api/index.js';

http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const url=new URL('http://'+req.headers.host+req.url);const path=url.pathname.slice(1);url.pathname='/api/index';url.searchParams.set('__path',path);
    const response=await app.fetch(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(err){console.error(err);res.writeHead(500);res.end()}
}).listen(Number(process.env.PORT),()=>console.log('Madar listening on '+process.env.PORT));
