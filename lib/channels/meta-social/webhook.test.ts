import { describe, expect, it } from "vitest";

import { desenhoDaEntrega, parseMetaSocialWebhook } from "@/lib/channels/meta-social/webhook";

const CONTA = "17841400000000001";
const PESSOA = "9988776655";

function mensagem(extra: Record<string, unknown> = {}, lado: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: CONTA,
        time: 1_800_000_000_000,
        messaging: [
          {
            sender: { id: PESSOA },
            recipient: { id: CONTA },
            timestamp: 1_800_000_001_000,
            message: { mid: "mid-1", text: "oi", ...extra },
            ...lado,
          },
        ],
      },
    ],
  };
}

describe("parseMetaSocialWebhook", () => {
  it("DM de texto vira `mensagem` com conta, participante e instante", () => {
    const [e] = parseMetaSocialWebhook(mensagem());
    expect(e).toMatchObject({ tipo: "mensagem", contaId: CONTA, participanteId: PESSOA, mid: "mid-1", texto: "oi", anexos: [] });
    expect(e?.enviadoEm.getTime()).toBe(1_800_000_001_000);
  });

  it("anexo de imagem entra com tipo e URL", () => {
    const [e] = parseMetaSocialWebhook(
      mensagem({ text: undefined, attachments: [{ type: "image", payload: { url: "https://cdn.exemplo/1.jpg" } }] }),
    );
    expect(e?.texto).toBeNull();
    expect(e?.anexos).toEqual([{ tipo: "image", url: "https://cdn.exemplo/1.jpg" }]);
  });

  it("resposta a um Story guarda o id do Story", () => {
    const [e] = parseMetaSocialWebhook(mensagem({ reply_to: { story: { id: "story-9", url: "https://cdn.exemplo/s" } } }));
    expect(e?.replyToStory).toBe("story-9");
  });

  it("o ECO da DM que o próprio CRM enviou é `eco`, e o participante é o destinatário", () => {
    const [e] = parseMetaSocialWebhook({
      object: "instagram",
      entry: [
        {
          id: CONTA,
          time: 1_800_000_000_000,
          messaging: [
            {
              sender: { id: CONTA },
              recipient: { id: PESSOA },
              timestamp: 1_800_000_002_000,
              message: { mid: "mid-eco", text: "resposta", is_echo: true },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ tipo: "eco", contaId: CONTA, participanteId: PESSOA, mid: "mid-eco" });
  });

  it("clique em botão vira `postback` com o payload", () => {
    const [e] = parseMetaSocialWebhook({
      object: "instagram",
      entry: [
        {
          id: CONTA,
          time: 1_800_000_000_000,
          messaging: [
            { sender: { id: PESSOA }, recipient: { id: CONTA }, timestamp: 1_800_000_003_000, postback: { mid: "mid-p", title: "Quero", payload: "QUERO_1" } },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ tipo: "postback", participanteId: PESSOA, mid: "mid-p", texto: "Quero", payload: "QUERO_1" });
  });

  it("comentário (e comentário em Live) viram `comentario`, para a fase 2 e para serem ignorados na 1", () => {
    const base = (campo: string) => ({
      object: "instagram",
      entry: [
        {
          id: CONTA,
          time: 1_800_000_000,
          changes: [{ field: campo, value: { id: "c-1", text: "eu quero", from: { id: PESSOA, username: "fulano" }, media: { id: "m-1" } } }],
        },
      ],
    });
    expect(parseMetaSocialWebhook(base("comments"))[0]).toMatchObject({ tipo: "comentario", contaId: CONTA, participanteId: PESSOA, mid: "c-1", texto: "eu quero", aoVivo: false });
    expect(parseMetaSocialWebhook(base("live_comments"))[0]).toMatchObject({ tipo: "comentario", aoVivo: true });
  });

  it("campo desconhecido vira `outro`, sem lançar", () => {
    const [e] = parseMetaSocialWebhook({ object: "instagram", entry: [{ id: CONTA, time: 1, changes: [{ field: "story_insights", value: {} }] }] });
    expect(e).toMatchObject({ tipo: "outro", contaId: CONTA });
  });

  it("vários itens na mesma entrega saem na ordem", () => {
    const corpo = mensagem();
    corpo.entry[0]!.messaging.push({ sender: { id: PESSOA }, recipient: { id: CONTA }, timestamp: 1_800_000_004_000, message: { mid: "mid-2", text: "dois" } });
    expect(parseMetaSocialWebhook(corpo).map((e) => e.mid)).toEqual(["mid-1", "mid-2"]);
  });

  it("lixo nunca lança: devolve lista vazia", () => {
    for (const lixo of [null, undefined, "x", 42, {}, { object: "instagram" }, { entry: "x" }, { entry: [null, 3, {}] }, { entry: [{ id: CONTA, messaging: [null, {}] }] }]) {
      expect(parseMetaSocialWebhook(lixo)).toEqual([]);
    }
  });

  it("entrega de outro objeto da Meta (page, whatsapp) não é desta conexão", () => {
    expect(parseMetaSocialWebhook({ ...mensagem(), object: "whatsapp_business_account" })).toEqual([]);
  });
});

describe("DM entregue como mudança (`changes` com field messages) e o desenho da entrega", () => {
  const corpo = (value: unknown) => ({ object: "instagram", entry: [{ id: "17841400000000001", time: 1795000000, changes: [{ field: "messages", value }] }] });

  it("lê a DM do formato `changes` como mensagem recebida, igual ao `messaging[]`", () => {
    const eventos = parseMetaSocialWebhook(
      corpo({ sender: { id: "999" }, recipient: { id: "17841400000000001" }, timestamp: "1795000000", message: { mid: "mid-1", text: "oi" } }),
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ tipo: "mensagem", contaId: "17841400000000001", participanteId: "999", mid: "mid-1", texto: "oi" });
  });

  it("o eco no formato `changes` entra como saída, com o destinatário como participante", () => {
    const [e] = parseMetaSocialWebhook(
      corpo({ sender: { id: "17841400000000001" }, recipient: { id: "999" }, timestamp: "1795000000", message: { mid: "mid-2", text: "ola", is_echo: true } }),
    );
    expect(e).toMatchObject({ tipo: "eco", participanteId: "999", mid: "mid-2" });
  });

  it("`messages` sem o desenho de uma mensagem continua sendo só um campo sem tratamento", () => {
    const [e] = parseMetaSocialWebhook(corpo({ algo: "diferente" }));
    expect(e).toMatchObject({ tipo: "outro" });
  });

  it("o desenho não leva conteúdo: só contas, quantidade de messaging e nomes de campo", () => {
    const d = desenhoDaEntrega(corpo({ sender: { id: "999" }, message: { mid: "m", text: "segredo da conversa" } }));
    expect(d).toEqual({ objeto: "instagram", entradas: [{ conta: "17841400000000001", messaging: 0, campos: ["messages"] }] });
    expect(JSON.stringify(d)).not.toContain("segredo");
  });
});
