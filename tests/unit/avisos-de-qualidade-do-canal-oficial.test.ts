import { describe, expect, it, vi } from "vitest";

import {
  avisoDeCategoriaDoModelo,
  avisoDeQualidadeDoModelo,
  avisoDeQualidadeDoNumero,
  gravarAvisoDeQualidade,
} from "@/lib/channels/meta/avisos-de-qualidade";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

function envelope(field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "9999999999", changes: [{ field, value }] }],
  };
}

describe("parser dos eventos de qualidade e categoria", () => {
  it("categoria do modelo", () => {
    const ev = parseMetaWebhook(
      envelope("message_template_category_update", {
        message_template_name: "boas_vindas",
        message_template_language: "pt_BR",
        previous_category: "UTILITY",
        new_category: "MARKETING",
      }) as never,
    );
    expect(ev).toEqual([
      {
        kind: "template_category",
        wabaId: "9999999999",
        templateName: "boas_vindas",
        templateLanguage: "pt_BR",
        previousCategory: "UTILITY",
        newCategory: "MARKETING",
      },
    ]);
  });

  it("qualidade do modelo", () => {
    const ev = parseMetaWebhook(
      envelope("message_template_quality_update", {
        message_template_name: "boas_vindas",
        message_template_language: "pt_BR",
        previous_quality_score: "GREEN",
        new_quality_score: "RED",
      }) as never,
    );
    expect(ev[0]).toMatchObject({ kind: "template_quality", previousQuality: "GREEN", newQuality: "RED" });
  });

  it("qualidade do número", () => {
    const ev = parseMetaWebhook(
      envelope("phone_number_quality_update", {
        display_phone_number: "+55 31 99999-0000",
        event: "FLAGGED",
        current_limit: "TIER_1K",
      }) as never,
    );
    expect(ev[0]).toMatchObject({ kind: "phone_quality", event: "FLAGGED", currentLimit: "TIER_1K" });
  });

  it("payload capenga não vira evento", () => {
    expect(parseMetaWebhook(envelope("phone_number_quality_update", {}) as never)).toEqual([]);
    expect(parseMetaWebhook(envelope("message_template_category_update", { new_category: "UTILITY" }) as never)).toEqual([]);
  });
});

describe("avisos", () => {
  it("modelo que vira marketing pede atenção e fala de custo", () => {
    const a = avisoDeCategoriaDoModelo({
      templateName: "x",
      templateLanguage: "pt_BR",
      anterior: "UTILITY",
      nova: "MARKETING",
    });
    expect(a).toMatchObject({ kind: "channel_template_review_direct", severity: "warn" });
    expect(a?.title).toContain("utilidade → marketing");
    expect(a?.body).toContain("custam mais");
  });

  it("marketing → utilidade é informação", () => {
    expect(
      avisoDeCategoriaDoModelo({ templateName: "x", templateLanguage: "pt_BR", anterior: "MARKETING", nova: "UTILITY" })?.severity,
    ).toBe("info");
  });

  it("qualidade vermelha do modelo é crítica", () => {
    const a = avisoDeQualidadeDoModelo({ templateName: "x", templateLanguage: "pt_BR", anterior: "GREEN", nova: "RED" });
    expect(a?.severity).toBe("critical");
    expect(a?.body).toContain("PAUSAR");
  });

  it("número sinalizado é crítico, com o limite em português", () => {
    const a = avisoDeQualidadeDoNumero({ telefone: "+55 31 99999-0000", event: "FLAGGED", limite: "TIER_1K" });
    expect(a).toMatchObject({ kind: "channel_number_alert", severity: "critical" });
    expect(a?.title).toContain("1.000 clientes por dia");
  });

  it("evento desconhecido não gera aviso", () => {
    expect(avisoDeQualidadeDoNumero({ telefone: null, event: "COISA_NOVA", limite: null })).toBeNull();
  });
});

describe("gravarAvisoDeQualidade", () => {
  const aviso = avisoDeQualidadeDoNumero({ telefone: "+55", event: "DOWNGRADE", limite: null });

  function admin(jaAberto: boolean, erroNoInsert = false) {
    const insert = vi.fn().mockResolvedValue({ error: erroNoInsert ? { message: "x" } : null });
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: jaAberto ? { id: "1" } : null, error: null });
    chain.insert = insert;
    return { client: { from: vi.fn(() => chain) } as never, insert };
  }
  const alvo = { organizationId: "o", channelSessionId: "s" };

  it("grava uma vez e não repete aviso aberto", async () => {
    const novo = admin(false);
    expect(await gravarAvisoDeQualidade(novo.client, alvo, aviso)).toBe("aviso");
    expect(novo.insert).toHaveBeenCalledOnce();
    const repetido = admin(true);
    expect(await gravarAvisoDeQualidade(repetido.client, alvo, aviso)).toBe("aviso_repetido");
    expect(repetido.insert).not.toHaveBeenCalled();
  });

  it("nunca lança quando o insert falha", async () => {
    expect(await gravarAvisoDeQualidade(admin(false, true).client, alvo, aviso)).toBe("aviso_falhou");
  });

  it("sem aviso, não toca o banco", async () => {
    const a = admin(false);
    expect(await gravarAvisoDeQualidade(a.client, alvo, null)).toBe("sem_aviso");
    expect(a.insert).not.toHaveBeenCalled();
  });
});
