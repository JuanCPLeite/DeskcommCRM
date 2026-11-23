import { describe, expect, it } from "vitest";

import { textPreviews } from "@/lib/channels/meta/previa-do-modelo";

describe("prévia do modelo — a tela espelha o texto da Meta", () => {
  it("modelo SEM variável também mostra o corpo (antes aparecia só o nome)", () => {
    expect(textPreviews([{ type: "BODY", text: "Este é um teste interno do sistema." }])).toEqual([
      { onde: "corpo", text: "Este é um teste interno do sistema." },
    ]);
  });

  it("cabeçalho, corpo, rodapé e botões saem, nessa ordem", () => {
    const p = textPreviews([
      { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
      { type: "BODY", text: "Seu pedido saiu." },
      { type: "FOOTER", text: "Equipe" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Ok" },
          { type: "QUICK_REPLY", text: "Parar" },
        ],
      },
    ]);
    expect(p.map((x) => x.onde)).toEqual(["cabeçalho", "corpo", "rodapé", "botões"]);
    expect(p[3]!.text).toBe("Ok  ·  Parar");
  });

  it("componente sem texto (cabeçalho de mídia) não vira prévia vazia", () => {
    expect(
      textPreviews([
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Oi" },
      ]),
    ).toEqual([{ onde: "corpo", text: "Oi" }]);
  });

  it("carrossel: o texto de cada cartão sai com o prefixo do cartão", () => {
    const p = textPreviews([
      { type: "CAROUSEL", cards: [{ components: [{ type: "BODY", text: "Cartão A" }] }] },
    ]);
    expect(p).toEqual([{ onde: "card 1 › corpo", text: "Cartão A" }]);
  });
});
