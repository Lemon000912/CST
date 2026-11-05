import type { ChatSession } from "./types";
export function loadLocalChatCache(owner:string):Promise<ChatSession[]>;
export function saveLocalChatCache(owner:string,sessions:ChatSession[]):Promise<void>;
