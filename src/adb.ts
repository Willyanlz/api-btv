import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { device } from './config.js';
const run=promisify(execFile); const keys={HOME:3,UP:19,DOWN:20,LEFT:21,RIGHT:22,ENTER:66,BACK:4} as const; export type RemoteKey=keyof typeof keys;
async function adb(args:string[],encoding:BufferEncoding='utf8'){return run('adb',args,{timeout:15000,maxBuffer:5_000_000,encoding});}
export class AdbService{
 async status(){let connection='offline';try{await adb(['connect',device]);const {stdout}=await adb(['devices','-l']);connection=stdout.includes(`${device} device`)?'device':stdout.includes('unauthorized')?'unauthorized':stdout.includes('offline')?'offline':'unknown';return {device,connection,details:stdout.trim()};}catch(e){return {device,connection:'unreachable',details:e instanceof Error?e.message:String(e)};}}
 async key(key:RemoteKey){await adb(['-s',device,'shell','input','keyevent',String(keys[key])]);return {ok:true,key};}
 async text(value:string){if(!/^[\p{L}\p{N} .,'!?@_-]{1,120}$/u.test(value))throw new Error('Texto contém caracteres não permitidos');await adb(['-s',device,'shell','input','text',value.replaceAll(' ','%s')]);return {ok:true};}
 async foreground(){const {stdout}=await adb(['-s',device,'shell','dumpsys','activity','activities']);const line=stdout.split('\n').find(x=>x.includes('mResumedActivity'))?.trim()??null;return {foreground:line};}
 async screenshot(){const {stdout}=await adb(['-s',device,'exec-out','screencap','-p'],null as never);return Buffer.from(stdout as unknown as Uint8Array);}
}
