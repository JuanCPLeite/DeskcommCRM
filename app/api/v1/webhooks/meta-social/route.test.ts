import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O webhook da Meta para Instagram: UM por app (não por sessão). A organização
 * vem da CONTA que recebeu, resolvida no banco depois da assinatura — nunca do
 * corpo. Mede: handshake, assinatura (antes de qualquer escrita), conta que
 * ninguém conectou (200, nada gravado), comentário (200, ignorado), erro de
 * ingestão (500, para a Meta reentregar) e o arquivo cru fechado.
 */

const SEGREDO = "chave-secreta-do-app-0123456789abcdef";
let app: { appSecret: string | null; verifyToken: string | null } = { appSecret: SEGREDO, verifyToken: "token-de-verificacao" };
const ingest = vi.fn(async (..._a: unknown[]) => ({ status: "ingested" as const }));
let sessao: { id: string; organizationId: string } | null = { id: "sessao-1", organizationId: "org-A" };
const abrir = vi.fn(async (..._a: unknown[]) => "linha-1" as string | null);
const fechar = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("@/lib/channels/meta-social/app", () => ({ appSocialDaMeta: async () => app }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: (...a: unknown[]) => abrir(...a),
  fecharArquivoDoWebhook: (...a: unknown[]) => fechar(...a),
}));
vi.mock("@/lib/channels/meta-social/ingest", () => ({
  ingestMetaSocial: (...a: unknown[]) => ingest(...a),
  sessaoDaConta: async () => sessao,
}));

import { GET, POST } from "./route";

const CONTA = "17841400000000001";

function corpoDeDm(mid = "mid-1") {
  return JSON.stringify({
    object: "instagram",
    entry: [{ id: CONTA, time: 1_800_000_000_000, messaging: [{ sender: { id: "9988" }, recipient: { id: CONTA }, timestamp: 1_800_000_001_000, message: { mid, text: "oi" } }] }],
  });
}

function assinado(corpo: string, segredo = SEGREDO) {
  return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
}

function post(corpo: string, assinatura: string | null) {
  return new Request("https://crm.exemplo.com/api/v1/webhooks/meta-social", {
    method: "POST",
    headers: { "content-type": "application/json", ...(assinatura ? { "x-hub-signature-256": assinatura } : {}) },
    body: corpo,
  }) as never;
}

function get(query: string) {
  const url = `https://crm.exemplo.com/api/v1/webhooks/meta-social?${query}`;
  return Object.assign(new Request(url), { nextUrl: new URL(url) }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  app = { appSecret: SEGREDO, verifyToken: "token-de-verificacao" };
  sessao = { id: "sessao-1", organizationId: "org-A" };
  ingest.mockResolvedValue({ status: "ingested" });
});

describe("GET — handshake da Meta", () => {
  it("devolve o hub.challenge em texto puro quando o token confere", async () => {
    const r = await GET(get("hub.mode=subscribe&hub.verify_token=token-de-verificacao&hub.challenge=12345"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("12345");
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("403 com token errado e com instalação sem token configurado", async () => {
    expect((await GET(get("hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1"))).status).toBe(403);
    app = { appSecret: SEGREDO, verifyToken: null };
    expect((await GET(get("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"))).status).toBe(403);
  });
});

describe("POST — entrega de eventos", () => {
  it("assinatura inválida, ausente, ou instalação sem chave: 401 e NADA é arquivado nem ingerido", async () => {
    const corpo = corpoDeDm();
    expect((await POST(post(corpo, assinado(corpo, "outra-chave-com-mais-de-dezesseis")))).status).toBe(401);
    expect((await POST(post(corpo, null))).status).toBe(401);
    app = { appSecret: null, verifyToken: null };
    expect((await POST(post(corpo, assinado(corpo)))).status).toBe(401);
    expect(abrir).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("DM de conta conectada: arquiva o corpo cru, ingere e fecha como processado", async () => {
    const corpo = corpoDeDm();
    const r = await POST(post(corpo, assinado(corpo)));
    expect(r.status).toBe(200);
    expect(abrir).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org-A", channelSessionId: "sessao-1", provider: "meta_social", rawBody: corpo }));
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(fechar).toHaveBeenCalledWith(expect.anything(), "linha-1", expect.objectContaining({ status: "processed", validSignature: true }));
  });

  it("conta que nenhuma organização conectou: 200 e nada gravado (a Meta não pode entrar em loop de reentrega)", async () => {
    sessao = null;
    const corpo = corpoDeDm();
    const r = await POST(post(corpo, assinado(corpo)));
    expect(r.status).toBe(200);
    expect(abrir).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("evento de comentário (campo já assinado, sem tratamento na fase 1): 200 e ignorado", async () => {
    const corpo = JSON.stringify({ object: "instagram", entry: [{ id: CONTA, time: 1, changes: [{ field: "comments", value: { id: "c1", text: "oi", from: { id: "1" } } }] }] });
    ingest.mockResolvedValue({ status: "ignored", reason: "tipo_sem_tratamento" } as never);
    const r = await POST(post(corpo, assinado(corpo)));
    expect(r.status).toBe(200);
  });

  it("falha na ingestão: 500 (a Meta reentrega) e o arquivo fecha como erro, sem vazar a mensagem do erro", async () => {
    ingest.mockRejectedValueOnce(new Error("segredo-que-nao-pode-vazar"));
    const corpo = corpoDeDm();
    const r = await POST(post(corpo, assinado(corpo)));
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("segredo-que-nao-pode-vazar");
    expect(fechar).toHaveBeenCalledWith(expect.anything(), "linha-1", expect.objectContaining({ status: "error" }));
  });

  it("corpo que não é JSON, com assinatura válida: 400, sem ingestão", async () => {
    const corpo = "isto não é json";
    const r = await POST(post(corpo, assinado(corpo)));
    expect(r.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("a entrega repetida chama a ingestão de novo (a idempotência é do núcleo, por external_id)", async () => {
    const corpo = corpoDeDm("mid-repetido");
    await POST(post(corpo, assinado(corpo)));
    await POST(post(corpo, assinado(corpo)));
    expect(ingest).toHaveBeenCalledTimes(2);
  });
});
