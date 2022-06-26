import { Try, MaybeSimple } from "adv-try";

export interface JsonRpcFullResponse {
    success: boolean;
    originalRequest: unknown;
    request: MaybeSimple<JsonRpcRequest>;
    response: JsonRpcResponse;
    error?: unknown;
}

export type JsonRpcId = string|number|null;

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    error?: JsonRpcResponseError;
    result?: unknown;
}

export interface JsonRpcResponseError {
    code: number;
    message: string;
    data?: unknown;
}

export type ApiHandler = (method: string, params: unknown) => unknown;

export const ERROR_CODES = {
    PARSE_ERROR: {code: -32700, message: "Parse error"},
    INVALID_REQUEST: {code: -32600, message: "Invalid request"},
    METHOD_NOT_FOUND: {code: -32601, message: "Method not found"},
    INVALID_PARAMS: {code: -32602, message: "Invalid params"},
    INTERNAL_ERROR: {code: -32603, message: "Internal error"},
    DECODE_ERROR: {code: -32800, message: "Decode error"},
}

export type ErrorCodeName = keyof typeof ERROR_CODES;

export class JsonRpcError extends Error {
    
    errorName: ErrorCodeName;
    code: number;
    override message: string;
    data: any;
    
    constructor(errorName: ErrorCodeName, data?: unknown) {
        super();
        this.errorName = errorName;
        const entry = ERROR_CODES[errorName];
        this.code = entry.code;
        this.message = entry.message;
        this.data = data;
    }
    
    is(errorName: keyof typeof ERROR_CODES): boolean {
        return this.errorName == errorName;
    }
    
    static is(e: unknown, errorName: keyof typeof ERROR_CODES): boolean {
        return e instanceof JsonRpcError && e.is(errorName);
    }
}

export interface IErrorSerializer {
    serialize(e: unknown): MaybeSimple<JsonRpcResponseError>;
}

export interface IEncoder {
    encode<T = unknown>(obj: T): T;
    decode<T = unknown>(obj: T): T;
}

export class BufferEncoder implements IEncoder {
    
    encode<T = unknown>(obj: T): T {
        if (typeof(obj) == "object") {
            if (obj == null) {
                return obj;
            }
            if (Array.isArray(obj)) {
                const res: any[] = [];
                for (const x of obj) {
                    res.push(this.encode(x));
                }
                return <any>res;
            }
            if (obj instanceof Uint8Array) {
                return <T><unknown>{
                    __type: "Buffer",
                    base64: Buffer.from(obj).toString("base64")
                };
            }
            if ((<any>obj).constructor !== Object) {
                return obj;
            }
            const res: any = {};
            for (const name in obj) {
                res[name] = this.encode(obj[name as keyof object]);
            }
            return res;
        }
        return obj;
    }
    
    decode<T = unknown>(obj: T): T {
        if (typeof(obj) == "object") {
            if (obj == null) {
                return obj;
            }
            if (Array.isArray(obj)) {
                const res: any[] = [];
                for (const x of obj) {
                    res.push(this.decode(x));
                }
                return <any>res;
            }
            if ((<any>obj).__type == "Buffer" && ("base64" in obj)) {
                return <any>Buffer.from((<any>obj).base64, "base64");
            }
            if ((<any>obj).constructor !== Object) {
                return obj;
            }
            const res: any = {};
            for (const name in obj) {
                res[name] = this.decode(obj[name]);
            }
            return res;
        }
        return obj;
    }
}

export interface IJsonRpcServer {
    process(jRpc: unknown): Promise<JsonRpcFullResponse>;
    parseJsonRpc(jRpc: unknown): MaybeSimple<JsonRpcRequest>;
    createJsonRpcError(id: JsonRpcId, e: unknown): JsonRpcResponse;
}

export class JsonRpcServer implements IJsonRpcServer {
    
    constructor(
        private apiHandler: ApiHandler,
        private errorSerializer?: IErrorSerializer
    ) {
    }
    
    async process(jRpc: unknown): Promise<JsonRpcFullResponse> {
        const jRequest = this.parseJsonRpc(jRpc);
        try {
            if (!jRequest.success) {
                throw new JsonRpcError("PARSE_ERROR");
            }
            const res = await this.apiHandler(jRequest.value.method, jRequest.value.params);
            return {
                success: true,
                originalRequest: jRpc,
                request: jRequest,
                response: {
                    jsonrpc: "2.0",
                    id: jRequest.value.id,
                    result: res
                }
            };
        }
        catch (e) {
            const id = jRequest.success ? jRequest.value.id : null;
            return {
                success: false,
                originalRequest: jRpc,
                request: jRequest,
                response: this.createJsonRpcError(id, e),
                error: e
            };
        }
    }
    
    parseJsonRpc(jRpc: unknown): MaybeSimple<JsonRpcRequest> {
        return this.isJsonRpcRequest(jRpc) ? {success: true, value: jRpc} : {success: false};
    }
    
    private isJsonRpcRequest(jRpc: unknown): jRpc is JsonRpcRequest {
        return typeof(jRpc) == "object" && (<JsonRpcRequest>jRpc).jsonrpc == "2.0" && typeof((<JsonRpcRequest>jRpc).method) == "string" &&
            (typeof((<JsonRpcRequest>jRpc).id) == "number" || typeof((<JsonRpcRequest>jRpc).id) == "string");
    }
    
    createJsonRpcError(id: JsonRpcId, e: unknown): JsonRpcResponse {
        return {
            jsonrpc: "2.0",
            id: id,
            error: this.createJsonRpcErrorObj(e)
        };
    }
    
    private createJsonRpcErrorObj(e: unknown): JsonRpcResponseError {
        const res: MaybeSimple<JsonRpcResponseError> = this.errorSerializer ? this.errorSerializer.serialize(e) : {success: false};
        if (res.success) {
            return res.value;
        }
        if (e instanceof JsonRpcError) {
            return {code: e.code, message: e.message, data: e.data};
        }
        return ERROR_CODES.INTERNAL_ERROR;
    }
}

export class JsonRpcServerWithEncoder extends JsonRpcServer {
    
    constructor(
        apiHandler: ApiHandler,
        private encoder: IEncoder,
        errorSerializer?: IErrorSerializer,
    ) {
        super(apiHandler, errorSerializer);
    }
    
    override async process(jRpc: unknown): Promise<JsonRpcFullResponse> {
        const pObj = Try.try(() => this.encoder.decode(jRpc));
        if (pObj.success === false) {
            const request = this.parseJsonRpc(jRpc);
            return {
                success: false,
                originalRequest: jRpc,
                request: {success: false},
                response: this.createJsonRpcError(request.success ? request.value.id : null, new JsonRpcError("DECODE_ERROR")),
                error: pObj.error
            };
        }
        const res = await super.process(pObj.value);
        return {
            ...res,
            response: this.encoder.encode(res.response)
        };
    }
}
