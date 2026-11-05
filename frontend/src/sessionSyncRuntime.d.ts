import type { ChatSession } from "./types";
export class SessionSync {
  constructor(options: {getCurrent?:()=>ChatSession[];prepare:(s:ChatSession[])=>ChatSession[];merge:(a:ChatSession[],b:ChatSession[])=>ChatSession[];save:(s:ChatSession[],revision:number,deleted:string[])=>Promise<any>;load:(revision:number|null)=>Promise<any>;onMerge:(s:ChatSession[])=>void;onDeleteAck:(ids:string[])=>void;onError:(error:Error)=>void});
  revision:number|null;stopped:boolean;
  setCurrent(sessions:ChatSession[],deleted?:string[]):void;
  accept(snapshot:any):void;
  flush():Promise<void>;
  pull():Promise<void>;
}
