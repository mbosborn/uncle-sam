export function createNotionWake(config:{env:Record<string,unknown>;store:unknown;fetchImpl?:typeof fetch;clock?:()=>number}):(input:{eventId:unknown;attemptId:string})=>Promise<unknown>;
