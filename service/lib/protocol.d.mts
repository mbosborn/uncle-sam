export interface MCPTool {
 name:string; description:string; inputSchema:Record<string,unknown>;
 readOnlyHint:boolean; handler:(args:Record<string,unknown>)=>Promise<unknown>;
}
export function createMcpHandler(config:{bearerToken?:string;getHealth?:()=>Promise<unknown>;getEvent?:(id:string)=>Promise<unknown>;additionalTools?:MCPTool[]}):(request:Request)=>Promise<Response>;
export function handleSlackRequest(request:Request,config:Record<string,unknown>,dependencies:{acceptEvent:(event:Record<string,unknown>)=>Promise<boolean>}):Promise<Response>;
export function constantTimeSecretEqual(left:string,right:string):Promise<boolean>;
