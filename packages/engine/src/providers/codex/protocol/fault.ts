export type CodexProtocolFaultCode =
  | "DECODER_FAULTED"
  | "DECODER_FINISHED"
  | "MALFORMED_JSON"
  | "INVALID_ENVELOPE"
  | "INVALID_ID"
  | "LINE_TOO_LARGE"
  | "TRUNCATED_FRAME"
  | "QUEUE_OVERFLOW"
  | "PEER_CLOSED"
  | "UNKNOWN_RESPONSE"
  | "DUPLICATE_RESPONSE"
  | "DUPLICATE_SERVER_REQUEST"
  | "REQUEST_LIMIT"
  | "REQUEST_CANCELLED"
  | "ID_EXHAUSTED";

export class CodexProtocolFault extends Error {
  readonly code: CodexProtocolFaultCode;

  constructor(code: CodexProtocolFaultCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexProtocolFault";
    this.code = code;
  }
}
