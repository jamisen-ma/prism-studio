import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { commandError, readCommands } from '../shared/commands.mjs';

export function sameToken(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa=Buffer.from(a), bb=Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa,bb);
}

export class PhotoshopBridge {
  constructor({server,token,onEvent=()=>{},commandTimeout=60_000}) {
    this.token=token; this.onEvent=onEvent; this.commandTimeout=commandTimeout;
    this.socket=null; this.info=null; this.pending=new Map(); this.closed=false;
    this.wss=new WebSocketServer({noServer:true,maxPayload:48*1024*1024});
    this.upgrade=(request,socket,head)=>{
      let url;
      try {url=new URL(request.url,'http://127.0.0.1');} catch {socket.destroy();return;}
      if (url.pathname !== '/bridge') {socket.destroy();return;}
      this.wss.handleUpgrade(request,socket,head,ws=>this.accept(ws));
    };
    this.server=server;
    server.on('upgrade',this.upgrade);
    this.heartbeat=setInterval(()=>{
      for (const ws of this.wss.clients) {
        if (ws.alive===false) {ws.terminate();continue;}
        ws.alive=false; ws.ping();
      }
    },20_000);
    this.heartbeat.unref();
  }
  accept(ws) {
    ws.alive=true; let authorized=false;
    const timer=setTimeout(()=>ws.close(4001,'Pairing required'),5000); timer.unref();
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('error',()=>{});
    ws.on('message',bytes=>{
      let data; try {data=JSON.parse(bytes.toString());} catch {ws.close(4002,'Invalid JSON');return;}
      if (!data || typeof data!=='object' || Array.isArray(data)) {ws.close(4002,'Expected a protocol object');return;}
      if (!authorized) {
        if (data.type!=='hello' || !sameToken(data.token,this.token)) {ws.close(4003,'Invalid pairing key');return;}
        if (this.socket && this.socket.readyState===WebSocket.OPEN) {ws.close(4009,'Another Photoshop connection is active');return;}
        if (!Array.isArray(data.capabilities) || data.capabilities.length>100 || !data.capabilities.every(c=>typeof c==='string' && c.length<80)) {ws.close(4002,'Invalid capabilities');return;}
        authorized=true; clearTimeout(timer); this.socket=ws;
        this.info={appVersion:String(data.appVersion || 'unknown').slice(0,80),pluginVersion:String(data.pluginVersion || 'unknown').slice(0,80),capabilities:data.capabilities};
        ws.send(JSON.stringify({type:'welcome',protocolVersion:1}));
        this.onEvent({type:'connected',backend:'photoshop'}); return;
      }
      if (data.type==='result' && typeof data.id==='string') {
        const pending=this.pending.get(data.id); if (!pending) return;
        clearTimeout(pending.timer);this.pending.delete(data.id);
        if (data.error) pending.reject(commandError(String(data.error.code || 'PHOTOSHOP_ERROR'),String(data.error.message || 'Photoshop failed to complete the command.')));
        else pending.resolve(data.result);
      } else if (data.type==='event' && data.event==='document_changed') this.onEvent({type:'document_changed',backend:'photoshop'});
    });
    ws.on('close',()=>{
      clearTimeout(timer);
      if (this.socket!==ws) return;
      this.socket=null;this.info=null;
      for (const [id,pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(commandError('PHOTOSHOP_DISCONNECTED',pending.mutating?'Photoshop disconnected during an edit. Inspect the document before retrying; the edit may have completed.':'Photoshop disconnected.'));
        this.pending.delete(id);
      }
      this.onEvent({type:'disconnected',backend:'photoshop'});
    });
  }
  get connected() {return this.socket?.readyState===WebSocket.OPEN;}
  async execute(command,args) {
    if (!this.connected) throw commandError('PHOTOSHOP_DISCONNECTED','Connect the Prism plugin inside Photoshop to use this backend.');
    if (command==='capabilities') return {backend:'photoshop',commands:this.info.capabilities,limitations:['Live Photoshop support requires the Prism UXP plugin. Available commands depend on the plugin and Photoshop version.']};
    if (!this.info.capabilities.includes(command)) throw commandError('UNSUPPORTED_COMMAND',`The connected Photoshop plugin does not support ${command}.`);
    const id=randomUUID(),mutating=!readCommands.has(command);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(commandError('COMMAND_TIMEOUT',mutating?'Photoshop did not confirm the edit in time. Its outcome is unknown; inspect the document before retrying.':'Photoshop did not respond in time.'));
      },this.commandTimeout); timer.unref();
      this.pending.set(id,{resolve,reject,timer,mutating});
      this.socket.send(JSON.stringify({type:'command',id,command,args}),error=>{
        if (error && this.pending.has(id)) {clearTimeout(timer);this.pending.delete(id);reject(commandError('PHOTOSHOP_DISCONNECTED','The Photoshop connection was lost.'));}
      });
    });
  }
  async close() {
    if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);this.server.off('upgrade',this.upgrade);
    for(const ws of this.wss.clients)ws.terminate();
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(commandError('SERVER_STOPPED','The companion service stopped.'));}
    this.pending.clear();
    await new Promise(resolve=>this.wss.close(resolve));
  }
}
