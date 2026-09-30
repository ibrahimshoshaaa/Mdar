import {Readable} from 'node:stream';
import {handler} from '../server/app.js';

// Web Request preserves the original webhook bytes before JSON parsing.
export default {
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/api/index'&&url.searchParams.has('__path')){
      const path=url.searchParams.getAll('__path').at(-1)||'';
      if(/[?#]/.test(path))return Response.json({error:'Invalid route'},{status:400});
      url.pathname='/'+path.replace(/^\/+/, '');url.searchParams.delete('__path');
    }
    if(Number(request.headers.get('content-length')||0)>1000000)return Response.json({error:'Body too large'},{status:413});
    const body=Buffer.from(await request.arrayBuffer());
    if(body.length>1000000)return Response.json({error:'Body too large'},{status:413});
    const req=Readable.from(body.length?[body]:[]);
    req.method=request.method;req.url=url.pathname+url.search;
    req.headers=Object.fromEntries(request.headers);req.headers.host=url.host;
    let status=200,headers={},output;
    const res={headersSent:false,writeHead(code,value){status=code;headers=value;this.headersSent=true},end(value){output=value}};
    await handler(req,res);
    return new Response(request.method==='HEAD'?null:output,{status,headers});
  }
};
