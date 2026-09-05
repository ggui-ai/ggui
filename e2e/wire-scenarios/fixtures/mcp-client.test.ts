import { describe, expect, it } from 'vitest';
import { parseMcpResponse } from './mcp-client';

const envelope = { jsonrpc: '2.0', id: 7, result: { ok: true } };
const data = JSON.stringify(envelope);

describe('parseMcpResponse (streamable HTTP: application/json or text/event-stream)', () => {
  it('parses a plain JSON-RPC body', () => {
    expect(parseMcpResponse(data)).toEqual(envelope);
  });

  it('parses an SSE frame and reads the data: line', () => {
    expect(parseMcpResponse(`event: message\ndata: ${data}\n\n`)).toEqual(envelope);
  });

  it('skips an SSE comment line (": keepalive") the server emits ahead of the frame on a long generation', () => {
    expect(parseMcpResponse(`: keepalive\n\nevent: message\ndata: ${data}\n\n`)).toEqual(envelope);
  });

  it('ignores id:/retry: fields and joins a multi-line data: payload per the SSE spec', () => {
    // Split between JSON tokens — the SSE join puts a newline there, which is
    // whitespace to JSON.parse; splitting inside a string literal would not be.
    const cut = data.indexOf('"id"');
    const [head, tail] = [data.slice(0, cut), data.slice(cut)];
    expect(parseMcpResponse(`id: 3\nretry: 1000\nevent: message\ndata: ${head}\ndata:${tail}\n\n`)).toEqual(envelope);
  });

  it('refuses a stream that never carries a data: line, naming the frame', () => {
    expect(() => parseMcpResponse(': keepalive\n\n: keepalive\n\n')).toThrow(/without data: line/);
  });

  it('refuses an empty body', () => {
    expect(() => parseMcpResponse('  \n')).toThrow(/empty body/);
  });
});
