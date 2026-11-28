import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ingestão das DMs do Instagram direto. A persistência (contato, conversa,
 * mensagem, idempotência por `external_id`, opt-out, pós-entrada) é do
 * `ingestZernioInbound`, que já recebe uma `socialMessage` pronta — este módulo
 * só RESOLVE a organização pela conta e MONTA essa mensagem. O que se mede aqui:
 * a resolução (e a recusa de conta que ninguém conectou), a forma da mensagem
 * (a chave de idempotência, a direção, a thread) e o que NÃO entra (eco que
 * dispararia a IA, comentário, tipo desconhecido).
 */

const ingestZernio = vi.fn(async (..._a: unknown[]) => ({ status: "ingested" as const, conversationId: "conv-1", messageId: "msg-1" }));
let sessao: { id: string; organization_id: string } | null = { id: "sessao-1", organization_id: "org-A" };
let erroNaBusca: { code: string } | null = null;
const filtros: Record<string, unknown> = {};

vi.mock("@/lib/channels/zernio/ingest", () => ({ ingestZernioInbound: (...a: unknown[]) => ingestZernio(...a) }));

function dbFalso() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => ((filtros[c] = v), q),
    is: (c: string, v: unknown) => ((filtros[c] = v), q),
    maybeSingle: async () => ({ data: sessao, error: erroNaBusca }),
  };
  return { from: () => q } as never;
}

import { ingestMetaSocial } from "@/lib/channels/meta-social/ingest";
import type { MetaSocialEvento } from "@/lib/channels/meta-social/webhook";

function evento(extra: Partial<MetaSocialEvento> = {}): MetaSocialEvento {
  return {
    tipo: "mensagem",
    contaId: "17841400000000001",
    participanteId: "9988776655",
    mid: "mid-1",
    texto: "oi",
    anexos: [],
    enviadoEm: new Date("2026-11-27T12:00:00.000Z"),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao = { id: "sessao-1", organization_id: "org-A" };
  erroNaBusca = null;
  for (const k of Object.keys(filtros)) delete filtros[k];
});

describe("ingestMetaSocial", () => {
  it("DM recebida: acha a organização pela conta e entrega ao núcleo social uma mensagem de entrada", async () => {
    const r = await ingestMetaSocial(dbFalso(), evento());
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1" });
    expect(filtros).toMatchObject({ provider: "meta_social", social_account_id: "17841400000000001", archived_at: null });
    const entrada = (ingestZernio.mock.calls[0] as unknown[])[1] as { organizationId: string; channelSessionId: string; socialMessage: Record<string, unknown> };
    expect(entrada.organizationId).toBe("org-A");
    expect(entrada.channelSessionId).toBe("sessao-1");
    expect(entrada.socialMessage).toMatchObject({
      platform: "instagram",
      participantId: "9988776655",
      accountId: "17841400000000001",
      // A thread é o próprio participante: é o id que a Graph API endereça no envio.
      conversationId: "9988776655",
      externalId: "social:17841400000000001:mid-1",
      direction: "inbound",
      kind: "message",
      text: "oi",
      sentAt: "2026-11-27T12:00:00.000Z",
    });
    // Instagram direto não tem telefone: a identidade é o handle, nunca o número.
    expect((entrada.socialMessage.identity as { phone: unknown }).phone).toBeNull();
  });

  it("o eco da DM enviada pelo CRM entra como SAÍDA (nunca como recebida, que acionaria a IA)", async () => {
    await ingestMetaSocial(dbFalso(), evento({ tipo: "eco", mid: "mid-eco", texto: "resposta" }));
    const msg = ((ingestZernio.mock.calls[0] as unknown[])[1] as { socialMessage: Record<string, unknown> }).socialMessage;
    expect(msg).toMatchObject({ direction: "outbound", externalId: "social:17841400000000001:mid-eco", kind: "message" });
  });

  it("anexos viram anexos da mensagem", async () => {
    await ingestMetaSocial(dbFalso(), evento({ texto: null, anexos: [{ tipo: "image", url: "https://cdn.exemplo/1.jpg" }] }));
    const msg = ((ingestZernio.mock.calls[0] as unknown[])[1] as { socialMessage: Record<string, unknown> }).socialMessage;
    expect(msg.attachments).toEqual([{ type: "image", url: "https://cdn.exemplo/1.jpg" }]);
    expect(msg.text).toBeNull();
  });

  it("clique em botão entra como mensagem de entrada com o título do botão", async () => {
    await ingestMetaSocial(dbFalso(), evento({ tipo: "postback", texto: "Quero", payload: "QUERO_1", mid: "mid-p" }));
    const msg = ((ingestZernio.mock.calls[0] as unknown[])[1] as { socialMessage: Record<string, unknown> }).socialMessage;
    expect(msg).toMatchObject({ direction: "inbound", text: "Quero", externalId: "social:17841400000000001:mid-p" });
  });

  it("conta que nenhuma organização conectou: 200 lógico (ignorada), nada é gravado", async () => {
    sessao = null;
    const r = await ingestMetaSocial(dbFalso(), evento());
    expect(r).toEqual({ status: "ignored", reason: "conta_desconhecida" });
    expect(ingestZernio).not.toHaveBeenCalled();
  });

  it("comentário e tipo desconhecido não têm tratamento na fase 1: ignorados, sem tocar no banco", async () => {
    for (const tipo of ["comentario", "outro"] as const) {
      const r = await ingestMetaSocial(dbFalso(), evento({ tipo }));
      expect(r).toEqual({ status: "ignored", reason: "tipo_sem_tratamento" });
    }
    expect(ingestZernio).not.toHaveBeenCalled();
  });

  it("falha ao buscar a sessão sobe como erro (a Meta reentrega), em vez de virar 'conta desconhecida'", async () => {
    erroNaBusca = { code: "XX000" };
    sessao = null;
    await expect(ingestMetaSocial(dbFalso(), evento())).rejects.toThrow(/sessao_meta_social/);
  });

  it("evento sem participante ou sem id de mensagem é ignorado", async () => {
    expect(await ingestMetaSocial(dbFalso(), evento({ participanteId: "" }))).toMatchObject({ status: "ignored" });
    expect(await ingestMetaSocial(dbFalso(), evento({ mid: "" }))).toMatchObject({ status: "ignored" });
    expect(ingestZernio).not.toHaveBeenCalled();
  });
});
